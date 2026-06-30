const db   = require('../config/database');
const path = require('path');
const { PRODUCTION_TECHNICIAN_ALIASES, roleSqlList } = require('../utils/roles');
const { getAllCostData } = require('../services/costDashboardService');
const { ensureSatisfactionTable } = require('../services/satisfactionService');
const { createAuditLog } = require('../middleware/auditLog');
const { reworkRequestSql, reworkRateSql } = require('../services/reworkMetricsService');

// ── ExcelJS helper ────────────────────────────────────────────────────────────
let ExcelJS;
try { ExcelJS = require('exceljs'); } catch (_) { ExcelJS = null; }

const BRAND_COLOR  = 'FF2D2D2D'; // dark header bg
const ACCENT_COLOR = 'FFFF6B35'; // orange accent
const HEADER_FONT  = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
const BODY_FONT    = { name: 'Calibri', size: 10 };
const BORDER       = { style: 'thin', color: { argb: 'FFD0D0D0' } };
const BORDERS      = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
const COMPLETED_STATUS_LIST = "'completed','requester_confirmation','waiting_customer_confirmation','archived'";
const TERMINAL_STATUS_LIST = `${COMPLETED_STATUS_LIST},'cancelled','rejected'`;
const HISTORICAL_COMPLETED_SQL = `r.status IN (${COMPLETED_STATUS_LIST})`;
const NON_IMPORTED_SQL = `COALESCE(r.source, 'application') <> 'monday'`;
const ACTUAL_HOURS_SQL = `
  CASE
    WHEN r.actual_start_time IS NOT NULL
     AND r.actual_end_time IS NOT NULL
     AND r.actual_end_time >= r.actual_start_time
    THEN EXTRACT(EPOCH FROM (r.actual_end_time - r.actual_start_time)) / 3600.0
    ELSE 0
  END
`;
const CYCLE_ACTUAL_HOURS_SQL = `
  CASE
    WHEN start_time IS NOT NULL
     AND end_time IS NOT NULL
     AND end_time >= start_time
    THEN EXTRACT(EPOCH FROM (end_time - start_time)) / 3600.0
    ELSE 0
  END
`;

/**
 * Build a styled Excel workbook for a given dataset.
 * @param {object} opts
 * @param {string}   opts.sheetName
 * @param {string[]} opts.columns      - column header labels
 * @param {string[]} opts.keys         - corresponding object keys
 * @param {object[]} opts.rows
 * @param {string[]} opts.dateKeys     - keys whose values should be formatted as dates
 * @param {object[]} opts.summaryRows  - optional KPI summary rows [{label, value}]
 */
const buildWorkbook = async (opts) => {
  if (!ExcelJS) throw new Error('exceljs not installed — run: npm install exceljs');

  const wb = new ExcelJS.Workbook();
  wb.creator  = '3D Print Manager — Avocarbon';
  wb.created  = new Date();

  // ── Data sheet ─────────────────────────────────────────────────────────
  const ws = wb.addWorksheet(opts.sheetName || 'Data', {
    views: [{ state: 'frozen', ySplit: 1 }], // freeze header row
  });

  // Column definitions
  ws.columns = opts.columns.map((header, i) => ({
    header,
    key:   opts.keys[i],
    width: Math.max(header.length + 4, 14),
  }));

  // Style header row
  const headerRow = ws.getRow(1);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_COLOR } };
    cell.font   = HEADER_FONT;
    cell.border = BORDERS;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
  });

  // Add data rows
  opts.rows.forEach((row, idx) => {
    const values = {};
    opts.keys.forEach(k => {
      let v = row[k];
      if (opts.dateKeys?.includes(k) && v) {
        v = new Date(v).toLocaleDateString('fr-FR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
      }
      values[k] = v ?? '';
    });

    const dataRow = ws.addRow(values);
    dataRow.height = 18;
    dataRow.eachCell((cell) => {
      cell.font   = BODY_FONT;
      cell.border = BORDERS;
      cell.alignment = { vertical: 'middle', wrapText: false };
      // Alternate row shading
      if (idx % 2 === 0) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F8F8' } };
      }
    });
  });

  // Auto-fit columns based on actual content
  ws.columns.forEach(col => {
    let maxLen = col.header?.length || 10;
    col.eachCell({ includeEmpty: false }, cell => {
      const len = String(cell.value ?? '').length;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(Math.max(maxLen + 2, 12), 50);
  });

  // Add Excel AutoFilter on header row
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: opts.columns.length },
  };

  // ── Summary sheet (optional) ───────────────────────────────────────────
  if (opts.summaryRows?.length) {
    const ss = wb.addWorksheet('Summary', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ss.columns = [
      { header: 'KPI', key: 'label', width: 35 },
      { header: 'Value', key: 'value', width: 20 },
    ];
    const sh = ss.getRow(1);
    sh.height = 22;
    sh.eachCell(cell => {
      cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
      cell.font   = HEADER_FONT;
      cell.border = BORDERS;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    opts.summaryRows.forEach((row, i) => {
      const r = ss.addRow(row);
      r.eachCell(cell => {
        cell.font   = BODY_FONT;
        cell.border = BORDERS;
        if (i % 2 === 0)
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } };
      });
    });
  }

  return wb;
};

// ── Send XLSX response ─────────────────────────────────────────────────────
const sendXLSX = async (res, workbook, filename) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-cache');
  await workbook.xlsx.write(res);
  res.end();
};

// ── CSV fallback (if ExcelJS not installed) ────────────────────────────────
const sendCSV = (res, rows, filename) => {
  if (!rows.length) { res.json({ data: [] }); return; }
  const headers = Object.keys(rows[0]);
  const escape  = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace('.xlsx','.csv')}"`);
  res.send('\uFEFF' + csv);
};

const getActorName = (user = {}) => [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || 'System';

const auditActualHourIssues = async (req, rows = [], source) => {
  const seen = new Set();
  for (const row of rows) {
    if (!row.actual_hours_data_issue || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    await createAuditLog({
      entityType: 'print_request',
      entityId: row.id,
      action: 'actual_hours_data_issue',
      performedBy: req.user?.id || null,
      performedByName: getActorName(req.user),
      newValues: {
        source,
        request_number: row.request_number,
        actual_start_time: row.actual_start_time,
        actual_end_time: row.actual_end_time,
        warning: 'actual_end_time is earlier than actual_start_time; exported Actual Hours was set to 0.',
      },
      ipAddress: req.ip,
    });
  }
};

const addCostSheet = (wb, sheetName, rows) => {
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  const columns = Object.keys(rows[0] || { Empty: '' });
  ws.columns = columns.map((header) => ({
    header,
    key: header,
    width: Math.max(header.length + 4, 16),
  }));

  const headerRow = ws.getRow(1);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_COLOR } };
    cell.font = HEADER_FONT;
    cell.border = BORDERS;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  rows.forEach((row, idx) => {
    const dataRow = ws.addRow(row);
    dataRow.eachCell((cell) => {
      cell.font = BODY_FONT;
      cell.border = BORDERS;
      if (idx % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F8F8' } };
    });
  });

  ws.columns.forEach((col) => {
    let maxLen = col.header?.length || 10;
    col.eachCell({ includeEmpty: false }, (cell) => {
      maxLen = Math.max(maxLen, String(cell.value ?? '').length);
    });
    col.width = Math.min(Math.max(maxLen + 2, 14), 42);
  });
};

const costRows = (rows) => rows.map((r) => ({
  Name: r.label,
  'Actual Cost Total (€)': r.actualCostTotal.toFixed(2),
  Requests: r.requestCount,
  Reworks: r.reworkCount,
}));

const buildTechnicianExportFilters = (query = {}) => {
  const requestConditions = [];
  const techConditions = [`u.role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)})`, 'u.is_active = true'];
  const params = [];
  let idx = 1;
  const addRequest = (sql, value) => {
    requestConditions.push(sql.replace('?', `$${idx++}`));
    params.push(value);
  };
  if (query.technician_id) {
    techConditions.push(`u.id = $${idx++}`);
    params.push(query.technician_id);
  }
  if (query.site_id) addRequest('r.site_id = ?', query.site_id);
  if (query.status) addRequest('r.status = ?', query.status);
  if (query.priority) addRequest('r.priority = ?', query.priority);
  if (query.printer_id) addRequest('r.printer_id = ?', query.printer_id);
  if (query.date_from) addRequest('COALESCE(r.planned_start_date, r.approved_due_date, r.requested_due_date, r.created_at)::date >= ?::date', query.date_from);
  if (query.date_to) addRequest('COALESCE(r.planned_start_date, r.approved_due_date, r.requested_due_date, r.created_at)::date <= ?::date', query.date_to);
  if (query.month) addRequest("EXTRACT(MONTH FROM COALESCE(r.planned_start_date, r.approved_due_date, r.requested_due_date, r.created_at)) = ?::int", query.month);
  if (query.year) addRequest("EXTRACT(YEAR FROM COALESCE(r.planned_start_date, r.approved_due_date, r.requested_due_date, r.created_at)) = ?::int", query.year);
  return {
    params,
    technicianWhere: techConditions.join(' AND '),
    requestWhere: requestConditions.length ? `AND ${requestConditions.join(' AND ')}` : '',
  };
};

// ── Base request query ─────────────────────────────────────────────────────
const getRequestRows = async (whereClause = '', params = []) => {
  await ensureSatisfactionTable(db);
  const result = await db.query(`
    SELECT
      r.request_number       AS "Request ID",
      r.title                AS "Title",
      r.status               AS "Status",
      r.priority             AS "Priority",
      r.requester_name       AS "Requester",
      r.requester_department AS "Department",
      c.name                 AS "Category",
      r.criticality          AS "Criticality",
      r.quantity             AS "Qty",
      m.name                 AS "Material",
      r.spool_reference      AS "Spool Ref",
      r.material_used_grams  AS "Material Used (g)",
      p.name                 AS "Printer",
      COALESCE(u.first_name||' '||u.last_name,'—') AS "Technician",
      r.requested_due_date   AS "Requested Due",
      r.approved_due_date    AS "Approved Due",
      r.planned_start_date   AS "Planned Start",
      r.actual_start_time    AS "Started At",
      r.actual_end_time      AS "Finished At",
      r.actual_duration      AS "Duration (h)",
      r.quality_result       AS "QC Result",
      r.scrap_count          AS "Scraps",
      ${reworkRequestSql('r')} AS "Rework",
      r.completion_date      AS "Completed At",
      ss.overall_rating      AS "Satisfaction",
      ss.quality_rating      AS "Quality Rating",
      ss.delivery_rating     AS "Delivery Rating",
      ss.communication_rating AS "Communication Rating",
      ss.fulfillment_result  AS "Fulfillment",
      ss.recommendation_score AS "Recommendation",
      ss.comment             AS "Requester Feedback",
      ss.created_at          AS "Feedback Submitted",
      r.feasibility_result   AS "Feasibility",
      r.project_reference    AS "Project Ref",
      r.created_at           AS "Created"
    FROM print_requests r
    LEFT JOIN users u       ON r.assigned_technician_id = u.id
    LEFT JOIN printers p    ON r.printer_id    = p.id
    LEFT JOIN materials m   ON r.material_id   = m.id
    LEFT JOIN request_categories c ON r.category_id = c.id
    LEFT JOIN request_satisfaction_surveys ss ON ss.request_id = r.id
    ${whereClause}
    ORDER BY r.created_at DESC
  `, params);
  return result.rows;
};

const buildRequestExportWhere = (query = {}, baseConditions = []) => {
  const conditions = ["COALESCE(r.source, 'application') <> 'monday'", ...baseConditions];
  const params = [];
  let idx = 1;
  const add = (sql, value) => {
    conditions.push(sql.replace('?', `$${idx++}`));
    params.push(value);
  };
  if (query.site_id) add('r.site_id = ?', query.site_id);
  if (query.material_id) add('r.material_id = ?', query.material_id);
  if (query.printer_id) add('r.printer_id = ?', query.printer_id);
  if (query.technician_id) add('r.assigned_technician_id = ?', query.technician_id);
  if (query.priority) add('r.priority = ?', query.priority);
  if (query.status) add('r.status = ?', query.status);
  if (query.category_id) add('r.category_id = ?', query.category_id);
  if (query.department) add('r.requester_department ILIKE ?', `%${query.department}%`);
  if (query.requester) add('r.requester_name ILIKE ?', `%${query.requester}%`);
  if (query.date_from) add('COALESCE(r.completion_date, r.actual_end_time, r.planned_start_date, r.approved_due_date, r.requested_due_date, r.created_at)::date >= ?::date', query.date_from);
  if (query.date_to) add('COALESCE(r.completion_date, r.actual_end_time, r.planned_start_date, r.approved_due_date, r.requested_due_date, r.created_at)::date <= ?::date', query.date_to);
  return { where: `WHERE ${conditions.join(' AND ')}`, params };
};

const DATE_KEYS = ['Requested Due','Approved Due','Planned Start','Started At','Finished At','Completed At','Feedback Submitted','Created'];
const REQ_COLS  = ['Request ID','Title','Status','Priority','Requester','Department','Category','Criticality','Qty','Material','Spool Ref','Material Used (g)','Printer','Technician','Requested Due','Approved Due','Planned Start','Started At','Finished At','Duration (h)','QC Result','Scraps','Rework','Completed At','Satisfaction','Quality Rating','Delivery Rating','Communication Rating','Fulfillment','Recommendation','Requester Feedback','Feedback Submitted','Feasibility','Project Ref','Created'];
const REQ_KEYS  = REQ_COLS;

// ── KPI Summary data ───────────────────────────────────────────────────────
const getKPISummary = async (from, to) => {
  await ensureSatisfactionTable(db);
  const result = await db.query(`
    SELECT
      COUNT(*)                                                              AS total,
      COUNT(*) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL}) AS completed,
      COUNT(*) FILTER (WHERE r.status NOT IN (${TERMINAL_STATUS_LIST})) AS open,
      COUNT(*) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL} AND ${reworkRequestSql('r')}) AS rework,
      ${reworkRateSql('r', HISTORICAL_COMPLETED_SQL)} AS rework_rate,
      COUNT(*) FILTER (WHERE r.scrap_count > 0)                              AS failed,
      COUNT(*) FILTER (WHERE r.approved_due_date < COALESCE(r.completion_date, r.ready_at, r.actual_end_time) AND ${HISTORICAL_COMPLETED_SQL}) AS late,
      ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(r.completion_date, r.ready_at, r.actual_end_time) - r.submitted_at))/3600) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL})::NUMERIC, 1) AS avg_lead_h,
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE COALESCE(r.completion_date, r.ready_at, r.actual_end_time) <= r.approved_due_date AND ${HISTORICAL_COMPLETED_SQL})
        / NULLIF(COUNT(*) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL}),0)
      , 1) AS on_time_pct,
      ROUND(SUM(r.material_used_grams) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL})::NUMERIC, 0) AS material_used_g,
      ROUND(AVG(s.overall_rating)::NUMERIC, 2) AS avg_satisfaction,
      ROUND(100.0 * COUNT(s.id) FILTER (WHERE s.recommendation_score = 'yes') / NULLIF(COUNT(s.id), 0), 1) AS recommendation_rate,
      ROUND(100.0 * COUNT(s.id) / NULLIF(COUNT(*) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL}), 0), 1) AS survey_participation
    FROM print_requests r
    LEFT JOIN request_satisfaction_surveys s ON s.request_id = r.id
    WHERE COALESCE(r.source, 'application') <> 'monday'
      AND r.created_at BETWEEN $1 AND $2
  `, [from || '2000-01-01', to || new Date().toISOString()]);
  const d = result.rows[0];
  return [
    { label: 'Total Requests (period)',        value: d.total },
    { label: 'Completed',                      value: d.completed },
    { label: 'Open / In Progress',             value: d.open },
    { label: 'Average Lead Time (hours)',       value: d.avg_lead_h ?? '—' },
    { label: 'On-Time Delivery Rate (%)',       value: d.on_time_pct ?? '—' },
    { label: 'Rework Count',                   value: d.rework },
    { label: 'Rework Rate (%)',                value: d.rework_rate ?? '—' },
    { label: 'Failed / Scrapped Prints',       value: d.failed },
    { label: 'Late Deliveries',                value: d.late },
    { label: 'Total Material Consumed (g)',    value: d.material_used_g ?? '—' },
    { label: 'Average Satisfaction Score',     value: d.avg_satisfaction ?? '—' },
    { label: 'Recommendation Rate (%)',        value: d.recommendation_rate ?? '—' },
    { label: 'Survey Participation Rate (%)',  value: d.survey_participation ?? '—' },
  ];
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

exports.exportAllRequests = async (req, res) => {
  try {
    const { where, params } = buildRequestExportWhere(req.query);
    const rows = await getRequestRows(where, params);
    const summary = await getKPISummary();
    const filename = `3dprint-all-requests-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, rows, filename);
    const wb = await buildWorkbook({ sheetName: 'All Requests', columns: REQ_COLS, keys: REQ_KEYS, rows, dateKeys: DATE_KEYS, summaryRows: summary });
    await sendXLSX(res, wb, filename);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Export failed' }); }
};

exports.exportOpenRequests = async (req, res) => {
  try {
    const { where, params } = buildRequestExportWhere(req.query, [`r.status NOT IN (${TERMINAL_STATUS_LIST})`]);
    const rows = await getRequestRows(where, params);
    const filename = `3dprint-open-requests-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, rows, filename);
    const wb = await buildWorkbook({ sheetName: 'Open Requests', columns: REQ_COLS, keys: REQ_KEYS, rows, dateKeys: DATE_KEYS });
    await sendXLSX(res, wb, filename);
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
};

exports.exportCompletedRequests = async (req, res) => {
  try {
    const { where, params } = buildRequestExportWhere(req.query, [HISTORICAL_COMPLETED_SQL]);
    const rows = await getRequestRows(where, params);
    const summary = await getKPISummary();
    const filename = `3dprint-completed-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, rows, filename);
    const wb = await buildWorkbook({ sheetName: 'Completed Requests', columns: REQ_COLS, keys: REQ_KEYS, rows, dateKeys: DATE_KEYS, summaryRows: summary });
    await sendXLSX(res, wb, filename);
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
};

exports.exportOverdueRequests = async (req, res) => {
  try {
    const { where, params } = buildRequestExportWhere(req.query, [
      "r.approved_due_date < NOW()",
      `r.status NOT IN (${TERMINAL_STATUS_LIST})`,
    ]);
    const rows = await getRequestRows(where, params);
    const filename = `3dprint-overdue-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, rows, filename);
    const wb = await buildWorkbook({ sheetName: 'Overdue Requests', columns: REQ_COLS, keys: REQ_KEYS, rows, dateKeys: DATE_KEYS });
    await sendXLSX(res, wb, filename);
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
};

exports.exportArchivedRequests = async (req, res) => {
  try {
    const { where, params } = buildRequestExportWhere(req.query, ["r.status = 'archived'"]);
    const rows = await getRequestRows(where, params);
    const summary = await getKPISummary();
    const filename = `3dprint-archived-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, rows, filename);
    const wb = await buildWorkbook({ sheetName: 'Archived Requests', columns: REQ_COLS, keys: REQ_KEYS, rows, dateKeys: DATE_KEYS, summaryRows: summary });
    await sendXLSX(res, wb, filename);
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
};

exports.exportTechnicianWorkload = async (req, res) => {
  try {
    // Sheet 1: Summary per technician (full history incl. archived = completed)
    const summary = await db.query(`
      SELECT
        u.first_name||' '||u.last_name AS "Technician",
        u.department                    AS "Department",
        COUNT(r.id)                     AS "Total All Time",
        COUNT(r.id) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL}) AS "Completed",
        COUNT(r.id) FILTER (WHERE r.status NOT IN ('completed','archived',
          'cancelled','rejected','draft','submitted','completeness_check',
          'feasibility_review','more_info_required','approved','prioritized','planned')) AS "Currently Active",
        COUNT(r.id) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL} AND ${reworkRequestSql('r')}) AS "Had Rework",
        COUNT(r.id) FILTER (WHERE r.scrap_count>0)                                 AS "Had Failures",
        COUNT(r.id) FILTER (
          WHERE ${HISTORICAL_COMPLETED_SQL}
            AND r.completion_date <= COALESCE(r.approved_due_date, r.requested_due_date)
        )                                                                           AS "On-Time",
        ROUND(AVG(r.actual_duration) FILTER (
          WHERE ${HISTORICAL_COMPLETED_SQL})::NUMERIC, 2) AS "Avg Duration (h)",
        ROUND(SUM(r.material_used_grams) FILTER (
          WHERE ${HISTORICAL_COMPLETED_SQL})::NUMERIC, 0) AS "Total Material (g)"
      FROM users u
      LEFT JOIN print_requests r ON r.assigned_technician_id = u.id
      WHERE u.role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)}) AND u.is_active = true
      GROUP BY u.id, u.first_name, u.last_name, u.department
      ORDER BY "Completed" DESC
    `);

    // Sheet 2: Full request history per technician (all assigned, including archived)
    const history = await db.query(`
      SELECT
        u.first_name||' '||u.last_name AS "Technician",
        r.request_number               AS "Request ID",
        r.title                        AS "Title",
        r.status                       AS "Status",
        r.priority                     AS "Priority",
        r.requester_department         AS "Department",
        p.name                         AS "Printer",
        m.name                         AS "Material",
        r.actual_start_time            AS "Started At",
        r.actual_end_time              AS "Finished At",
        r.actual_duration              AS "Duration (h)",
        r.material_used_grams          AS "Material Used (g)",
        r.quality_result               AS "QC Result",
        r.scrap_count                  AS "Scraps",
        ${reworkRequestSql('r')}       AS "Rework",
        r.approved_due_date            AS "Due Date",
        r.completion_date              AS "Completed At"
      FROM print_requests r
      JOIN users u ON r.assigned_technician_id = u.id
      LEFT JOIN printers p ON r.printer_id = p.id
      LEFT JOIN materials m ON r.material_id = m.id
      WHERE u.role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)})
        AND r.status NOT IN ('draft','submitted','completeness_check',
          'feasibility_review','more_info_required','approved','prioritized','planned')
      ORDER BY u.last_name, r.actual_start_time DESC NULLS LAST
    `);

    const summCols = ['Technician','Department','Total All Time','Completed','Currently Active',
      'Had Rework','Had Failures','On-Time','Avg Duration (h)','Total Material (g)'];
    const histCols = ['Technician','Request ID','Title','Status','Priority','Department',
      'Printer','Material','Started At','Finished At','Duration (h)','Material Used (g)',
      'QC Result','Scraps','Rework','Due Date','Completed At'];

    const filename = `3dprint-technician-history-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, history.rows, filename);

    // Build workbook with 2 sheets
    const wb = await buildWorkbook({
      sheetName: 'Summary', columns: summCols, keys: summCols,
      rows: summary.rows,
    });
    // Add history sheet
    const ws2 = wb.addWorksheet('Full History', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws2.columns = histCols.map(h => ({ header: h, key: h, width: Math.max(h.length + 4, 14) }));
    const hr = ws2.getRow(1);
    hr.height = 22;
    hr.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
      cell.font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    history.rows.forEach((row, i) => {
      const dr = ws2.addRow(histCols.reduce((o, k) => { o[k] = row[k] ?? ''; return o; }, {}));
      dr.height = 18;
      dr.eachCell(cell => {
        cell.font = { name: 'Calibri', size: 10 };
        if (i % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F8F8' } };
      });
    });
    ws2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: histCols.length } };

    await sendXLSX(res, wb, filename);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Export failed' }); }
};

exports.exportPrinterWorkload = async (req, res) => {
  try {
    const conditions = ['p.is_active = true'];
    const joinConditions = ["r.printer_id = p.id", "r.status NOT IN ('cancelled')"];
    const params = [];
    let idx = 1;
    const addJoin = (sql, value) => {
      joinConditions.push(sql.replace('?', `$${idx++}`));
      params.push(value);
    };
    const addWhere = (sql, value) => {
      conditions.push(sql.replace('?', `$${idx++}`));
      params.push(value);
    };
    if (req.query.printer_id) addWhere('p.id = ?', req.query.printer_id);
    if (req.query.site_id) addJoin('r.site_id = ?', req.query.site_id);
    if (req.query.technician_id) addJoin('r.assigned_technician_id = ?', req.query.technician_id);
    if (req.query.date_from) addJoin('COALESCE(r.completion_date, r.actual_end_time, r.created_at)::date >= ?::date', req.query.date_from);
    if (req.query.date_to) addJoin('COALESCE(r.completion_date, r.actual_end_time, r.created_at)::date <= ?::date', req.query.date_to);

    const result = await db.query(`
      SELECT
        p.name AS "Printer", p.technology AS "Technology", p.location AS "Location",
        p.status AS "Status",
        COUNT(r.id) AS "Total Jobs",
        COUNT(r.id) FILTER (WHERE r.status='in_progress') AS "Active",
        COUNT(r.id) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL}) AS "Completed",
        ROUND(SUM(r.actual_duration)::NUMERIC, 1)          AS "Total Print Hours",
        ROUND(SUM(r.material_used_grams)::NUMERIC, 0)      AS "Material Used (g)"
      FROM printers p
      LEFT JOIN print_requests r ON ${joinConditions.join(' AND ')}
      WHERE ${conditions.join(' AND ')}
      GROUP BY p.id, p.name, p.technology, p.location, p.status
      ORDER BY "Total Jobs" DESC
    `, params);
    const cols = ['Printer','Technology','Location','Status','Total Jobs','Active','Completed','Total Print Hours','Material Used (g)'];
    const filename = `3dprint-printer-workload-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, result.rows, filename);
    const wb = await buildWorkbook({ sheetName: 'Printer Workload', columns: cols, keys: cols, rows: result.rows });
    await sendXLSX(res, wb, filename);
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
};

exports.exportKPIs = async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const dateTo   = to || new Date().toISOString().split('T')[0];
    const params = [dateFrom, dateTo];
    const siteSql = req.query.site_id ? ` AND r.site_id = $${params.push(req.query.site_id)}` : '';

    const weekly = await db.query(`
      SELECT
        DATE_TRUNC('week', r.created_at)::DATE AS "Week",
        COUNT(*) AS "Submitted",
        COUNT(*) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL}) AS "Completed",
        COUNT(*) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL} AND ${reworkRequestSql('r')}) AS "Rework",
        ${reworkRateSql('r', HISTORICAL_COMPLETED_SQL)} AS "Rework Rate (%)",
        COUNT(*) FILTER (WHERE r.scrap_count>0) AS "Failed",
        ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(r.completion_date, r.ready_at, r.actual_end_time)-r.submitted_at))/3600) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL})::NUMERIC, 1) AS "Avg Lead (h)",
        ROUND(SUM(r.material_used_grams) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL})::NUMERIC, 0) AS "Material (g)",
        ROUND(AVG(s.overall_rating)::NUMERIC, 2) AS "Avg Satisfaction",
        ROUND(100.0 * COUNT(s.id) FILTER (WHERE s.recommendation_score = 'yes') / NULLIF(COUNT(s.id), 0), 1) AS "Recommendation Rate (%)",
        ROUND(100.0 * COUNT(s.id) / NULLIF(COUNT(*) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL}), 0), 1) AS "Survey Participation (%)"
      FROM print_requests r
      LEFT JOIN request_satisfaction_surveys s ON s.request_id = r.id
      WHERE r.created_at BETWEEN $1 AND $2
        ${siteSql}
      GROUP BY DATE_TRUNC('week', r.created_at)
      ORDER BY 1
    `, params);

    const summary = await getKPISummary(dateFrom, dateTo);
    const cols = ['Week','Submitted','Completed','Rework','Rework Rate (%)','Failed','Avg Lead (h)','Material (g)','Avg Satisfaction','Recommendation Rate (%)','Survey Participation (%)'];
    const filename = `3dprint-kpis-${dateFrom}-to-${dateTo}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, weekly.rows, filename);
    const wb = await buildWorkbook({
      sheetName: 'Weekly KPIs',
      columns: cols, keys: cols,
      rows: weekly.rows,
      dateKeys: ['Week'],
      summaryRows: summary,
    });
    await sendXLSX(res, wb, filename);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Export failed' }); }
};

exports.exportMaterialConsumption = async (req, res) => {
  try {
    const conditions = ['m.is_active = true'];
    const joinConditions = ['r.material_id = m.id'];
    const params = [];
    let idx = 1;
    const addJoin = (sql, value) => {
      joinConditions.push(sql.replace('?', `$${idx++}`));
      params.push(value);
    };
    const addWhere = (sql, value) => {
      conditions.push(sql.replace('?', `$${idx++}`));
      params.push(value);
    };
    if (req.query.material_id) addWhere('m.id = ?', req.query.material_id);
    if (req.query.site_id) addJoin('r.site_id = ?', req.query.site_id);
    if (req.query.date_from) addJoin('COALESCE(r.completion_date, r.actual_end_time, r.created_at)::date >= ?::date', req.query.date_from);
    if (req.query.date_to) addJoin('COALESCE(r.completion_date, r.actual_end_time, r.created_at)::date <= ?::date', req.query.date_to);

    const result = await db.query(`
      SELECT
        m.name AS "Material", m.type AS "Type", m.brand AS "Brand", m.color AS "Color",
        m.stock_quantity AS "Total Stock", m.available_quantity AS "Available",
        m.reserved_quantity AS "Reserved", m.unit AS "Unit",
        m.low_stock_threshold AS "Low Stock Alert",
        COUNT(r.id) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL}) AS "Jobs Used",
        ROUND(SUM(r.material_used_grams) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL})::NUMERIC, 0) AS "Total Consumed (g)",
        ROUND(AVG(r.material_used_grams) FILTER (WHERE ${HISTORICAL_COMPLETED_SQL})::NUMERIC, 1) AS "Avg per Job (g)"
      FROM materials m
      LEFT JOIN print_requests r ON ${joinConditions.join(' AND ')}
      WHERE ${conditions.join(' AND ')}
      GROUP BY m.id, m.name, m.type, m.brand, m.color, m.stock_quantity, m.available_quantity,
               m.reserved_quantity, m.unit, m.low_stock_threshold
      ORDER BY "Total Consumed (g)" DESC NULLS LAST
    `, params);
    const cols = ['Material','Type','Brand','Color','Total Stock','Available','Reserved','Unit','Low Stock Alert','Jobs Used','Total Consumed (g)','Avg per Job (g)'];
    const filename = `3dprint-materials-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, result.rows, filename);
    const wb = await buildWorkbook({ sheetName: 'Material Consumption', columns: cols, keys: cols, rows: result.rows });
    await sendXLSX(res, wb, filename);
  } catch (err) { res.status(500).json({ error: 'Export failed' }); }
};

exports.exportInventoryTransactions = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        mt.created_at AS "Date Time",
        m.name AS "Material",
        m.type AS "Material Type",
        mt.transaction_type AS "Transaction Type",
        CASE
          WHEN mt.transaction_type IN ('restock','release','stock_in') THEN mt.quantity
          WHEN mt.transaction_type = 'reservation' THEN 0
          ELSE -mt.quantity
        END AS "Quantity",
        m.unit AS "Unit",
        mt.performed_by_name AS "User",
        COALESCE(r.request_number, mt.spool_reference, '') AS "Reference",
        mt.notes AS "Notes"
      FROM material_transactions mt
      LEFT JOIN materials m ON mt.material_id = m.id
      LEFT JOIN print_requests r ON mt.request_id = r.id
      ORDER BY mt.created_at DESC
    `);
    const cols = ['Date Time','Material','Material Type','Transaction Type','Quantity','Unit','User','Reference','Notes'];
    const filename = `inventory-transactions-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, result.rows, filename);
    const wb = await buildWorkbook({ sheetName: 'Inventory Transactions', columns: cols, keys: cols, rows: result.rows, dateKeys: ['Date Time'] });
    await sendXLSX(res, wb, filename);
  } catch (err) {
    console.error('[Export] Inventory transactions failed:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
};

exports.exportLowStockReport = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        m.name AS "Material",
        m.type AS "Type",
        m.brand AS "Brand",
        m.color AS "Color",
        COALESCE(m.stock_quantity, 0) AS "Current Stock",
        COALESCE(m.reserved_quantity, 0) AS "Reserved Stock",
        COALESCE(m.available_quantity, m.stock_quantity, 0) AS "Available Stock",
        COALESCE(m.low_stock_threshold, 200) AS "Minimum Threshold",
        m.unit AS "Unit",
        CASE
          WHEN COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200) THEN 'Red'
          WHEN COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200) * 1.25 THEN 'Orange'
          ELSE 'Green'
        END AS "Risk Level"
      FROM materials m
      WHERE m.is_active = true
        AND COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200) * 1.25
      ORDER BY "Available Stock" ASC, m.name
    `);
    const cols = ['Material','Type','Brand','Color','Current Stock','Reserved Stock','Available Stock','Minimum Threshold','Unit','Risk Level'];
    const filename = `low-stock-report-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, result.rows, filename);
    const wb = await buildWorkbook({ sheetName: 'Low Stock', columns: cols, keys: cols, rows: result.rows });
    await sendXLSX(res, wb, filename);
  } catch (err) {
    console.error('[Export] Low stock failed:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
};

exports.exportMaterialForecast = async (req, res) => {
  try {
    const result = await db.query(`
      WITH avg_usage AS (
        SELECT material_id, COALESCE(SUM(quantity), 0) / 90.0 AS avg_daily_usage
        FROM material_transactions
        WHERE transaction_type = 'consumption'
          AND created_at > NOW() - INTERVAL '90 days'
        GROUP BY material_id
      )
      SELECT
        m.name AS "Material",
        m.type AS "Type",
        COALESCE(m.available_quantity, m.stock_quantity, 0) AS "Available Stock",
        COALESCE(m.reserved_quantity, 0) AS "Reserved Stock",
        COALESCE(a.avg_daily_usage, 0) AS "Average Daily Usage",
        CASE WHEN COALESCE(a.avg_daily_usage, 0) > 0
          THEN ROUND((COALESCE(m.available_quantity, m.stock_quantity, 0)::NUMERIC / a.avg_daily_usage)::NUMERIC, 1)
          ELSE NULL
        END AS "Days Of Coverage",
        m.unit AS "Unit"
      FROM materials m
      LEFT JOIN avg_usage a ON a.material_id = m.id
      WHERE m.is_active = true
      ORDER BY "Days Of Coverage" ASC NULLS LAST, m.name
    `);
    const cols = ['Material','Type','Available Stock','Reserved Stock','Average Daily Usage','Days Of Coverage','Unit'];
    const filename = `material-forecast-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, result.rows, filename);
    const wb = await buildWorkbook({ sheetName: 'Material Forecast', columns: cols, keys: cols, rows: result.rows });
    await sendXLSX(res, wb, filename);
  } catch (err) {
    console.error('[Export] Material forecast failed:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
};

exports.exportCostKPIs = async (req, res) => {
  try {
    const filters = {
      site_id: req.query.site_id,
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      month: req.query.month,
      year: req.query.year,
      material_id: req.query.material_id,
      printer_id: req.query.printer_id,
      technician_id: req.query.technician_id,
    };
    const data = await getAllCostData(filters);
    const filename = `Cost KPI Report-${new Date().toISOString().split('T')[0]}.xlsx`;

    const summaryRows = [
      { KPI: 'Actual Cost Total (€)', Value: data.summary.actualCostTotal.toFixed(2) },
      { KPI: 'Average Cost per Request (€)', Value: data.summary.averageCostPerRequest.toFixed(2) },
      { KPI: 'Requests Analyzed', Value: data.summary.requestCount },
      { KPI: 'Reworks Included', Value: data.summary.reworkCount },
      { KPI: 'Last Updated', Value: data.summary.lastUpdated },
    ];

    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, summaryRows, filename);

    const wb = new ExcelJS.Workbook();
    wb.creator = '3D Print Manager - Avocarbon';
    wb.created = new Date();

    addCostSheet(wb, 'Summary', summaryRows);
    addCostSheet(wb, 'By Site', costRows(data.bySite));
    addCostSheet(wb, 'By Material', costRows(data.byMaterial));
    addCostSheet(wb, 'By Printer', costRows(data.byPrinter));
    addCostSheet(wb, 'By Technician', costRows(data.byTechnician));

    await sendXLSX(res, wb, filename);
  } catch (err) {
    console.error('[Export] Cost KPI report failed:', err);
    res.status(500).json({ error: 'Export failed' });
  }
};

exports.exportWorkflowSnapshot = async (req, res) => {
  try {
    const activeStatuses = [
      'planned','assigned','in_progress','printed','quality_check',
      'ready_for_pickup','blocked','on_hold',
      'waiting_for_material','waiting_for_machine','waiting_for_input',
      'rework_required',
    ];
    const { params, technicianWhere, requestWhere } = buildTechnicianExportFilters(req.query);
    const statusParam = params.length + 1;

    const result = await db.query(`
      WITH cycle_hours AS (
        SELECT request_id,
               SUM(${CYCLE_ACTUAL_HOURS_SQL})
                 FILTER (WHERE start_time IS NOT NULL AND end_time IS NOT NULL) AS actual_hours,
               BOOL_OR(start_time IS NOT NULL AND end_time IS NOT NULL AND end_time < start_time) AS cycle_data_issue
        FROM request_production_cycles
        GROUP BY request_id
      )
      SELECT
        u.id AS technician_id,
        u.first_name || ' ' || u.last_name AS technician,
        r.id,
        r.request_number,
        r.title,
        r.status,
        r.priority,
        s.name AS site,
        p.name AS printer,
        r.approved_due_date,
        r.requested_due_date,
        CASE
          WHEN r.planned_start_date IS NOT NULL
           AND r.planned_end_date IS NOT NULL
           AND r.planned_end_date > r.planned_start_date
          THEN EXTRACT(EPOCH FROM (r.planned_end_date - r.planned_start_date)) / 3600.0
          ELSE 0
        END AS planned_hours,
        COALESCE(ch.actual_hours, ${ACTUAL_HOURS_SQL}) AS actual_hours,
        r.actual_start_time,
        r.actual_end_time,
        (COALESCE(ch.cycle_data_issue, false)
          OR (r.actual_start_time IS NOT NULL AND r.actual_end_time IS NOT NULL AND r.actual_end_time < r.actual_start_time)
        ) AS actual_hours_data_issue,
        CASE
          WHEN r.status NOT IN (${TERMINAL_STATUS_LIST})
           AND (
             (r.requested_due_date IS NOT NULL AND r.requested_due_date < CURRENT_DATE)
             OR (r.approved_due_date IS NOT NULL AND r.approved_due_date < CURRENT_DATE)
           )
          THEN true ELSE false
        END AS is_overdue
      FROM users u
      LEFT JOIN print_requests r ON r.assigned_technician_id = u.id
        AND COALESCE(r.source, 'application') <> 'monday'
        AND r.status = ANY($${statusParam})
        ${requestWhere}
      LEFT JOIN cycle_hours ch ON ch.request_id = r.id
      LEFT JOIN sites s ON r.site_id = s.id
      LEFT JOIN printers p ON r.printer_id = p.id
      WHERE ${technicianWhere}
      ORDER BY u.last_name, u.first_name, r.approved_due_date ASC NULLS LAST
    `, [...params, activeStatuses]).catch((err) => {
      if (!/request_production_cycles/i.test(err.message)) throw err;
      return db.query(`
        SELECT
          u.id AS technician_id,
          u.first_name || ' ' || u.last_name AS technician,
          r.id,
          r.request_number,
          r.title,
          r.status,
          r.priority,
          s.name AS site,
          p.name AS printer,
          r.approved_due_date,
          r.requested_due_date,
          CASE
          WHEN r.planned_start_date IS NOT NULL
           AND r.planned_end_date IS NOT NULL
           AND r.planned_end_date > r.planned_start_date
          THEN EXTRACT(EPOCH FROM (r.planned_end_date - r.planned_start_date)) / 3600.0
          ELSE 0
        END AS planned_hours,
          ${ACTUAL_HOURS_SQL} AS actual_hours,
          r.actual_start_time,
          r.actual_end_time,
          (r.actual_start_time IS NOT NULL AND r.actual_end_time IS NOT NULL AND r.actual_end_time < r.actual_start_time) AS actual_hours_data_issue,
          CASE
            WHEN r.status NOT IN (${TERMINAL_STATUS_LIST})
             AND (
               (r.requested_due_date IS NOT NULL AND r.requested_due_date < CURRENT_DATE)
               OR (r.approved_due_date IS NOT NULL AND r.approved_due_date < CURRENT_DATE)
             )
            THEN true ELSE false
          END AS is_overdue
        FROM users u
        LEFT JOIN print_requests r ON r.assigned_technician_id = u.id
          AND COALESCE(r.source, 'application') <> 'monday'
          AND r.status = ANY($${statusParam})
          ${requestWhere}
        LEFT JOIN sites s ON r.site_id = s.id
        LEFT JOIN printers p ON r.printer_id = p.id
        WHERE ${technicianWhere}
        ORDER BY u.last_name, u.first_name, r.approved_due_date ASC NULLS LAST
      `, [...params, activeStatuses]);
    });

    await auditActualHourIssues(req, result.rows, 'workflow_snapshot_export');

    const byTech = new Map();
    const assignedRows = [];
    for (const row of result.rows) {
      if (!byTech.has(row.technician_id)) {
        byTech.set(row.technician_id, {
          Technician: row.technician,
          'Assigned Requests': 0,
          'Open Requests': 0,
          'In Progress': 0,
          'Overdue Requests': 0,
          'Planned Hours': 0,
          'Actual Hours': 0,
        });
      }
      if (!row.id) continue;
      const tech = byTech.get(row.technician_id);
      tech['Assigned Requests'] += 1;
      tech['Open Requests'] += 1;
      tech['In Progress'] += row.status === 'in_progress' ? 1 : 0;
      tech['Overdue Requests'] += row.is_overdue ? 1 : 0;
      tech['Planned Hours'] += parseFloat(row.planned_hours || 0);
      tech['Actual Hours'] += Math.max(0, parseFloat(row.actual_hours || 0));
      assignedRows.push({
        Technician: row.technician,
        'Request Number': row.request_number,
        Title: row.title,
        Status: row.status,
        Priority: row.priority,
        Site: row.site || '',
        Printer: row.printer || '',
        'Due Date': row.approved_due_date || row.requested_due_date || '',
        'Planned Hours': parseFloat(row.planned_hours || 0).toFixed(2),
        'Actual Hours': Math.max(0, parseFloat(row.actual_hours || 0)).toFixed(2),
        'Data Issue': row.actual_hours_data_issue ? 'Actual end before actual start; hours set to 0' : '',
        Overdue: row.is_overdue ? 'Yes' : 'No',
      });
    }

    const details = Array.from(byTech.values()).map(row => ({
      ...row,
      'Planned Hours': row['Planned Hours'].toFixed(2),
      'Actual Hours': row['Actual Hours'].toFixed(2),
    }));
    const totalAssigned = details.reduce((sum, row) => sum + row['Assigned Requests'], 0);
    const summary = [
      { Metric: 'Total Technicians', Value: details.length },
      { Metric: 'Total Assigned Requests', Value: totalAssigned },
      { Metric: 'Average Requests per Technician', Value: details.length ? (totalAssigned / details.length).toFixed(2) : '0.00' },
      { Metric: 'Most Loaded Technician', Value: details.slice().sort((a, b) => parseFloat(b['Planned Hours']) - parseFloat(a['Planned Hours']))[0]?.Technician || '' },
      { Metric: 'Least Loaded Technician', Value: details.filter(r => r['Assigned Requests'] > 0).sort((a, b) => parseFloat(a['Planned Hours']) - parseFloat(b['Planned Hours']))[0]?.Technician || '' },
      { Metric: 'Total Planned Hours', Value: details.reduce((s, r) => s + parseFloat(r['Planned Hours']), 0).toFixed(2) },
      { Metric: 'Total Actual Hours', Value: details.reduce((s, r) => s + parseFloat(r['Actual Hours']), 0).toFixed(2) },
      { Metric: 'Overdue Requests', Value: details.reduce((s, r) => s + r['Overdue Requests'], 0) },
    ];

    const filename = `Workflow Snapshot Export-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, assignedRows, filename);

    const wb = new ExcelJS.Workbook();
    wb.creator = '3D Print Manager - Avocarbon';
    wb.created = new Date();
    addCostSheet(wb, 'Summary', summary);
    addCostSheet(wb, 'Technician Details', details);
    addCostSheet(wb, 'Assigned Requests', assignedRows);
    addCostSheet(wb, 'Overdue Requests', assignedRows.filter(r => r.Overdue === 'Yes'));
    await sendXLSX(res, wb, filename);
  } catch (err) {
    console.error('[Export] Workflow snapshot export failed:', err);
    res.status(500).json({ error: 'Export failed' });
  }
};

exports.exportTechnicianWorkloadReport = exports.exportWorkflowSnapshot;

const buildWorkflowHistoryFilters = (query = {}) => {
  const conditions = [NON_IMPORTED_SQL];
  const params = [];
  let idx = 1;
  const add = (sql, value) => {
    conditions.push(sql.replace('?', `$${idx++}`));
    params.push(value);
  };

  if (query.site_id) add('r.site_id = ?', query.site_id);
  if (query.technician_id) add('r.assigned_technician_id = ?', query.technician_id);
  if (query.printer_id) add('r.printer_id = ?', query.printer_id);
  if (query.status) add('r.status = ?', query.status);
  if (query.date_from) add('COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.planned_start_date, r.created_at)::date >= ?::date', query.date_from);
  if (query.date_to) add('COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.planned_start_date, r.created_at)::date <= ?::date', query.date_to);
  if (query.month) add("EXTRACT(MONTH FROM COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.planned_start_date, r.created_at)) = ?::int", query.month);
  if (query.year) add("EXTRACT(YEAR FROM COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.planned_start_date, r.created_at)) = ?::int", query.year);

  return { where: `WHERE ${conditions.join(' AND ')}`, params };
};

exports.exportWorkflowHistory = async (req, res) => {
  try {
    const { where, params } = buildWorkflowHistoryFilters(req.query);
    const result = await db.query(`
      SELECT
        r.id,
        r.request_number AS request_number,
        r.request_number AS "Request ID",
        r.title AS "Title",
        s.name AS "Site",
        c.name AS "Category",
        r.priority AS "Priority",
        r.created_at AS "Created Date",
        r.planned_start_date AS "Planned Date",
        r.actual_start_time AS "In Progress Date",
        r.actual_end_time AS "Printed Date",
        COALESCE(r.completion_date, r.ready_at) AS "Completed Date",
        COALESCE(u.first_name || ' ' || u.last_name, '') AS "Assigned Technician",
        COALESCE(p.name, '') AS "Assigned Printer",
        COALESCE(r.quantity, 0) AS "Quantity",
        ROUND((
          CASE
            WHEN r.planned_start_date IS NOT NULL
             AND r.planned_end_date IS NOT NULL
             AND r.planned_end_date > r.planned_start_date
            THEN EXTRACT(EPOCH FROM (r.planned_end_date - r.planned_start_date)) / 3600.0
            ELSE 0
          END
        )::NUMERIC, 2) AS "Planned Hours",
        ROUND((${ACTUAL_HOURS_SQL})::NUMERIC, 2) AS "Actual Hours",
        ROUND((
          CASE
            WHEN COALESCE(r.approved_due_date, r.requested_due_date) IS NOT NULL
             AND COALESCE(r.completion_date, r.ready_at, r.actual_end_time, NOW()) > COALESCE(r.approved_due_date, r.requested_due_date)
            THEN EXTRACT(EPOCH FROM (COALESCE(r.completion_date, r.ready_at, r.actual_end_time, NOW()) - COALESCE(r.approved_due_date, r.requested_due_date))) / 3600.0
            ELSE 0
          END
        )::NUMERIC, 2) AS "Delay",
        r.status AS "Current Status",
        CASE
          WHEN r.actual_start_time IS NOT NULL
           AND r.actual_end_time IS NOT NULL
           AND r.actual_end_time < r.actual_start_time
          THEN 'Actual end before actual start; hours set to 0'
          ELSE ''
        END AS "Data Issue",
        r.actual_start_time,
        r.actual_end_time,
        (r.actual_start_time IS NOT NULL AND r.actual_end_time IS NOT NULL AND r.actual_end_time < r.actual_start_time) AS actual_hours_data_issue
      FROM print_requests r
      LEFT JOIN sites s ON r.site_id = s.id
      LEFT JOIN request_categories c ON r.category_id = c.id
      LEFT JOIN users u ON r.assigned_technician_id = u.id
      LEFT JOIN printers p ON r.printer_id = p.id
      ${where}
      ORDER BY r.created_at DESC
    `, params);

    await auditActualHourIssues(req, result.rows, 'workflow_history_export');

    const rows = result.rows.map(({ id, request_number, actual_start_time, actual_end_time, actual_hours_data_issue, ...row }) => row);
    const totalRequests = rows.length;
    const completedRows = result.rows.filter(r => ['completed', 'requester_confirmation', 'waiting_customer_confirmation', 'archived'].includes(r['Current Status']));
    const avg = (values) => {
      const nums = values.map(v => parseFloat(v || 0)).filter(Number.isFinite);
      return nums.length ? (nums.reduce((sum, v) => sum + v, 0) / nums.length).toFixed(2) : '0.00';
    };
    const completionHours = completedRows.map(r => {
      const start = r['Created Date'] ? new Date(r['Created Date']).getTime() : NaN;
      const end = r['Completed Date'] ? new Date(r['Completed Date']).getTime() : NaN;
      return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 3600000 : 0;
    });
    const workload = new Map();
    for (const row of rows) {
      const technician = row['Assigned Technician'] || 'Unassigned';
      if (!workload.has(technician)) {
        workload.set(technician, { Technician: technician, Requests: 0, 'Planned Hours': 0, 'Actual Hours': 0 });
      }
      const item = workload.get(technician);
      item.Requests += 1;
      item['Planned Hours'] += parseFloat(row['Planned Hours'] || 0);
      item['Actual Hours'] += Math.max(0, parseFloat(row['Actual Hours'] || 0));
    }
    const workloadRows = Array.from(workload.values()).map(row => ({
      ...row,
      'Planned Hours': row['Planned Hours'].toFixed(2),
      'Actual Hours': row['Actual Hours'].toFixed(2),
    })).sort((a, b) => parseFloat(b['Planned Hours']) - parseFloat(a['Planned Hours']));

    const summary = [
      { Metric: 'Total Requests', Value: totalRequests },
      { Metric: 'Completed Requests', Value: completedRows.length },
      { Metric: 'Rejected Requests', Value: rows.filter(r => r['Current Status'] === 'rejected').length },
      { Metric: 'Waiting Customer Confirmation Requests', Value: rows.filter(r => ['requester_confirmation', 'waiting_customer_confirmation'].includes(r['Current Status'])).length },
      { Metric: 'Average Completion Time', Value: `${avg(completionHours)} h` },
      { Metric: 'Average Planned Hours', Value: avg(rows.map(r => r['Planned Hours'])) },
      { Metric: 'Average Actual Hours', Value: avg(rows.map(r => r['Actual Hours'])) },
      { Metric: 'Technician Workload', Value: workloadRows.map(r => `${r.Technician}: ${r.Requests}`).join('; ') },
    ];

    const filename = `Workflow History Export-${new Date().toISOString().split('T')[0]}.xlsx`;
    if (req.query.format === 'csv' || !ExcelJS) return sendCSV(res, rows, filename);

    const wb = new ExcelJS.Workbook();
    wb.creator = '3D Print Manager - Avocarbon';
    wb.created = new Date();
    addCostSheet(wb, 'Summary', summary);
    addCostSheet(wb, 'Workflow History', rows);
    addCostSheet(wb, 'Technician Workload', workloadRows);
    await sendXLSX(res, wb, filename);
  } catch (err) {
    console.error('[Export] Workflow history export failed:', err);
    res.status(500).json({ error: 'Export failed' });
  }
};

