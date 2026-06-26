const db = require('../config/database');
const { createAuditLog } = require('../middleware/auditLog');
const { PRODUCTION_TECHNICIAN_ALIASES, roleSqlList } = require('../utils/roles');

const TECH_OPEN_STATUSES = [
  'planned', 'assigned', 'in_progress', 'printed', 'quality_check',
  'ready_for_pickup', 'blocked', 'on_hold',
  'waiting_for_material', 'waiting_for_machine', 'waiting_for_input',
  'rework_required',
];

const scopedPlanningQuery = (req) => req.query;

const overdueSql = (alias = 'r') => `
  ${alias}.status NOT IN ('completed','archived','requester_confirmation','waiting_customer_confirmation','cancelled','rejected')
  AND (
    (${alias}.requested_due_date IS NOT NULL AND ${alias}.requested_due_date < CURRENT_DATE)
    OR (${alias}.approved_due_date IS NOT NULL AND ${alias}.approved_due_date < CURRENT_DATE)
  )
`;

const buildPlanningRequestFilters = (query = {}, startIndex = 1) => {
  const conditions = [];
  const params = [];
  let idx = startIndex;

  const add = (sql, value) => {
    conditions.push(sql.replace('?', `$${idx++}`));
    params.push(value);
  };

  if (query.site_id) add('r.site_id = ?', query.site_id);
  if (query.status) add('r.status = ?', query.status);
  if (query.priority) add('r.priority = ?', query.priority);
  if (query.technician_id) add('r.assigned_technician_id = ?', query.technician_id);
  if (query.printer_id) add('r.printer_id = ?', query.printer_id);
  if (query.date_from) add('COALESCE(r.planned_start_date, r.approved_due_date, r.requested_due_date, r.created_at)::date >= ?::date', query.date_from);
  if (query.date_to) add('COALESCE(r.planned_start_date, r.approved_due_date, r.requested_due_date, r.created_at)::date <= ?::date', query.date_to);
  if (query.month) add("EXTRACT(MONTH FROM COALESCE(r.planned_start_date, r.approved_due_date, r.requested_due_date, r.created_at)) = ?::int", query.month);
  if (query.year) add("EXTRACT(YEAR FROM COALESCE(r.planned_start_date, r.approved_due_date, r.requested_due_date, r.created_at)) = ?::int", query.year);

  return {
    where: conditions.length ? `AND ${conditions.join(' AND ')}` : '',
    params,
  };
};

const buildTechnicianScheduleFilters = (query = {}) => {
  const conditions = [`u.role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)})`, 'u.is_active = true'];
  const requestConditions = [];
  const params = [];
  let idx = 1;

  const addRequest = (sql, value) => {
    requestConditions.push(sql.replace('?', `$${idx++}`));
    params.push(value);
  };

  if (query.technician_id) {
    conditions.push(`u.id = $${idx++}`);
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
    technicianWhere: conditions.join(' AND '),
    requestWhere: requestConditions.length ? `AND ${requestConditions.join(' AND ')}` : '',
    params,
  };
};

const loadLevel = (plannedHours) => {
  const lowMax = parseFloat(process.env.TECH_LOAD_LOW_HOURS || '8');
  const mediumMax = parseFloat(process.env.TECH_LOAD_MEDIUM_HOURS || '20');
  if (plannedHours <= lowMax) return 'low';
  if (plannedHours <= mediumMax) return 'medium';
  return 'high';
};

const dateOnly = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};

const formatDateOnly = (value) => {
  const date = dateOnly(value);
  if (!date) return null;
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
};

const dateTime = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDateTime = (value) => {
  const date = dateTime(value);
  if (!date) return formatDateOnly(value);
  return date.toISOString();
};

const plannedDurationHours = (startValue, endValue) => {
  if (!startValue || !endValue) return null;
  const start = dateTime(startValue);
  const end = dateTime(endValue);
  if (!start || !end) return null;
  return (end.getTime() - start.getTime()) / 3600000;
};

const plannedDurationSql = (alias = 'r') => `
  CASE
    WHEN ${alias}.planned_start_date IS NOT NULL
     AND ${alias}.planned_end_date IS NOT NULL
     AND ${alias}.planned_end_date > ${alias}.planned_start_date
    THEN EXTRACT(EPOCH FROM (${alias}.planned_end_date - ${alias}.planned_start_date)) / 3600.0
    WHEN COALESCE(${alias}.production_total_print_time_minutes, 0) > 0
    THEN ${alias}.production_total_print_time_minutes / 60.0
    ELSE 0
  END
`;

const rangesOverlap = (a, b) => {
  const aStart = dateTime(a.planned_start_date || a.planned_end_date);
  const aEnd = dateTime(a.planned_end_date || a.planned_start_date);
  const bStart = dateTime(b.planned_start_date || b.planned_end_date);
  const bEnd = dateTime(b.planned_end_date || b.planned_start_date);
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart <= bEnd && bStart <= aEnd;
};

const conflictDate = (...requests) => {
  const dates = requests
    .flatMap(request => [dateTime(request.planned_start_date), dateTime(request.planned_end_date)])
    .filter(Boolean)
    .sort((a, b) => a - b);
  return formatDateTime(dates[0]);
};

const requestRef = (request) => ({
  id: request.id,
  request_number: request.request_number,
  title: request.title,
  planned_start_date: formatDateTime(request.planned_start_date),
  planned_end_date: formatDateTime(request.planned_end_date),
  approved_due_date: formatDateTime(request.approved_due_date),
});

const buildConflict = ({ type, resource, severity, requests, date, detail }) => ({
  id: `${type}-${resource || 'resource'}-${requests.map(r => r.id).join('-')}-${date || 'date'}`.replace(/\s+/g, '-').toLowerCase(),
  date,
  type,
  resource: resource || '-',
  requests: requests.map(requestRef),
  requestsText: requests.map(r => r.request_number).join(', '),
  severity,
  status: 'Open',
  detail: detail || '',
});

// GET read-only planning conflicts
exports.getPlanningConflicts = async (req, res) => {
  try {
    const activeStatuses = [
      'approved', 'prioritized', 'planned', 'assigned',
      'in_progress', 'printed', 'quality_check',
      'ready_for_pickup', 'blocked', 'on_hold', 'waiting_for_material',
      'waiting_for_machine', 'waiting_for_input', 'rework_required',
    ];
    const { where: filterWhere, params: filterParams } = buildPlanningRequestFilters(scopedPlanningQuery(req), 2);

    const result = await db.query(`
      SELECT
        r.id, r.request_number, r.title, r.status, r.priority,
        r.planned_start_date, r.planned_end_date, r.approved_due_date,
        ${plannedDurationSql('r')} AS planned_duration_hours,
        r.assigned_technician_id, r.printer_id,
        u.first_name || ' ' || u.last_name AS technician_name,
        p.name AS printer_name
      FROM print_requests r
      LEFT JOIN users u ON r.assigned_technician_id = u.id
      LEFT JOIN printers p ON r.printer_id = p.id
      WHERE r.status = ANY($1)
      ${filterWhere}
      ORDER BY COALESCE(r.planned_start_date, r.planned_end_date, r.approved_due_date, r.created_at) ASC
    `, [activeStatuses, ...filterParams]);

    const planned = result.rows.filter(r => r.planned_start_date || r.planned_end_date);
    const conflicts = [];

    for (let i = 0; i < planned.length; i += 1) {
      for (let j = i + 1; j < planned.length; j += 1) {
        const a = planned[i];
        const b = planned[j];
        if (!rangesOverlap(a, b)) continue;

        if (a.printer_id && a.printer_id === b.printer_id) {
          conflicts.push(buildConflict({
            type: 'Printer Conflict',
            resource: a.printer_name,
            severity: 'High',
            requests: [a, b],
            date: conflictDate(a, b),
          }));
        }

        if (a.assigned_technician_id && a.assigned_technician_id === b.assigned_technician_id) {
          conflicts.push(buildConflict({
            type: 'Technician Conflict',
            resource: a.technician_name,
            severity: 'Medium',
            requests: [a, b],
            date: conflictDate(a, b),
          }));
        }
      }
    }

    planned.forEach(request => {
      const missing = [];
      if (!request.printer_id) missing.push('Printer');
      if (!request.assigned_technician_id) missing.push('Technician');
      if (missing.length) {
        conflicts.push(buildConflict({
          type: 'Planning Warning',
          resource: `Missing ${missing.join(' and ')}`,
          severity: 'Low',
          requests: [request],
          date: formatDateOnly(request.planned_start_date || request.planned_end_date),
          detail: 'Missing assignment',
        }));
      }

      const plannedEnd = dateTime(request.planned_end_date || request.planned_start_date);
      const approvedDue = dateTime(request.approved_due_date);
      if (plannedEnd && approvedDue && plannedEnd > approvedDue) {
        conflicts.push(buildConflict({
          type: 'Schedule Risk',
          resource: request.printer_name || request.technician_name || '-',
          severity: 'Medium',
          requests: [request],
          date: formatDateTime(plannedEnd),
          detail: 'Planned end is after approved due date',
        }));
      }
    });

    res.json({
      summary: {
        totalConflicts: conflicts.length,
        printerConflicts: conflicts.filter(c => c.type === 'Printer Conflict').length,
        technicianConflicts: conflicts.filter(c => c.type === 'Technician Conflict').length,
        dueDateRisks: conflicts.filter(c => c.type === 'Schedule Risk').length,
        missingAssignments: conflicts.filter(c => c.type === 'Planning Warning').length,
      },
      conflicts,
    });
  } catch (err) {
    console.error('[Planning] Conflict detection error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET planning board - requests grouped by status for kanban
exports.getPlanningBoard = async (req, res) => {
  try {
    const activeStatuses = [
      'approved', 'prioritized', 'planned', 'assigned',
      'in_progress', 'printed', 'quality_check',
      'ready_for_pickup', 'blocked', 'on_hold', 'waiting_for_material',
      'waiting_for_machine', 'waiting_for_input', 'rework_required',
    ];
    const { where: filterWhere, params: filterParams } = buildPlanningRequestFilters(scopedPlanningQuery(req), 2);

    const result = await db.query(`
      SELECT
        r.id, r.request_number, r.title, r.status, r.priority,
        r.assigned_technician_id,
        r.requested_due_date, r.approved_due_date, r.planned_start_date, r.planned_end_date,
        ${plannedDurationSql('r')} AS planned_duration_hours,
        r.slot_order, r.requester_name, r.requester_department,
        r.quantity, r.category_id,
        u.first_name || ' ' || u.last_name AS technician_name,
        p.name AS printer_name,
        m.name AS material_name,
        c.name AS category_name,
        CASE
          WHEN ${overdueSql('r')}
          THEN true ELSE false
        END AS is_overdue
      FROM print_requests r
      LEFT JOIN users u ON r.assigned_technician_id = u.id
      LEFT JOIN printers p ON r.printer_id = p.id
      LEFT JOIN materials m ON r.material_id = m.id
      LEFT JOIN request_categories c ON r.category_id = c.id
      WHERE r.status = ANY($1)
      ${filterWhere}
      ORDER BY r.slot_order ASC, r.approved_due_date ASC NULLS LAST, r.created_at ASC
    `, [activeStatuses, ...filterParams]);

    // Group by status
    const board = { overdue: [] };
    activeStatuses.forEach(s => { board[s] = []; });
    result.rows.forEach(r => {
      if (r.is_overdue) board.overdue.push(r);
      else if (board[r.status]) board[r.status].push(r);
    });

    const summary = {
      totalRequests: result.rows.length,
      overdueRequests: result.rows.filter(r => r.is_overdue).length,
      inProgressRequests: result.rows.filter(r => r.status === 'in_progress').length,
      blockedRequests: result.rows.filter(r => r.status === 'blocked').length,
      highPriorityRequests: result.rows.filter(r => ['critical', 'high'].includes(r.priority)).length,
      plannedRequests: result.rows.filter(r => r.status === 'planned').length,
      assignedRequests: result.rows.filter(r => r.status === 'assigned').length,
      qualityCheckRequests: result.rows.filter(r => r.status === 'quality_check').length,
    };

    res.json({ summary, board });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// UPDATE card position (drag & drop slot ordering)
exports.updateSlotOrder = async (req, res) => {
  try {
    const { updates } = req.body;
    // updates = [{ id, slot_order, status? }]
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });

    for (const u of updates) {
      await db.query(
        `UPDATE print_requests SET slot_order = $1 WHERE id = $2`,
        [u.slot_order, u.id]
      );
    }
    res.json({ message: 'Order updated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// UPDATE planning dates for a request
exports.updatePlanningDates = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const {
      planned_start_date, planned_end_date,
      approved_due_date, rescheduled_due_date, rescheduled_reason,
    } = req.body;

    const existing = await client.query(
      `SELECT approved_due_date, planned_start_date, planned_end_date,
              rescheduled_due_date, rescheduled_reason,
              rescheduled_due_date, rescheduled_reason
       FROM print_requests r
       WHERE r.id = $1`,
      [id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });

    const effectiveStart = planned_start_date || existing.rows[0].planned_start_date;
    const effectiveEnd = planned_end_date || existing.rows[0].planned_end_date;
    if (effectiveStart && effectiveEnd) {
      const duration = plannedDurationHours(effectiveStart, effectiveEnd);
      if (duration === null || duration <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Planned End DateTime must be greater than Planned Start DateTime.' });
      }
    }

    const result = await client.query(`
      UPDATE print_requests SET
        planned_start_date    = COALESCE($1, planned_start_date),
        planned_end_date      = COALESCE($2, planned_end_date),
        approved_due_date     = COALESCE($3, approved_due_date),
        rescheduled_due_date  = COALESCE($4, rescheduled_due_date),
        rescheduled_reason    = COALESCE($5, rescheduled_reason),
        rescheduled_by_name   = $6
      WHERE id = $7 RETURNING *
    `, [
      planned_start_date, planned_end_date, approved_due_date,
      rescheduled_due_date, rescheduled_reason,
      `${req.user.first_name} ${req.user.last_name}`,
      id,
    ]);

    await createAuditLog({
      client,
      entityType: 'print_request', entityId: id,
      action: 'reschedule',
      performedBy: req.user.id,
      performedByName: `${req.user.first_name} ${req.user.last_name}`,
      oldValues: {
        approved_due_date: existing.rows[0].approved_due_date,
        planned_start_date: existing.rows[0].planned_start_date,
        planned_end_date: existing.rows[0].planned_end_date,
        rescheduled_due_date: existing.rows[0].rescheduled_due_date,
        rescheduled_reason: existing.rows[0].rescheduled_reason,
      },
      newValues: {
        approved_due_date,
        planned_start_date,
        planned_end_date,
        rescheduled_due_date,
        rescheduled_reason,
      },
    });

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
};

// GET printer schedule (all active requests per printer with dates)
exports.getPrinterSchedule = async (req, res) => {
  try {
    const { where: filterWhere, params: filterParams } = buildPlanningRequestFilters(scopedPlanningQuery(req), 2);
    const activeStatuses = [
      'planned','assigned','in_progress','printed','quality_check',
      'ready_for_pickup','blocked','on_hold',
      'waiting_for_material','waiting_for_machine','waiting_for_input',
      'rework_required',
    ];

    const result = await db.query(`
      SELECT
        r.id, r.request_number, r.title, r.status, r.priority,
        r.assigned_technician_id,
        r.planned_start_date, r.planned_end_date, r.approved_due_date, r.requested_due_date,
        ${plannedDurationSql('r')} AS planned_duration_hours,
        r.actual_start_time, r.actual_end_time,
        p.id AS printer_id, p.name AS printer_name, p.technology,
        u.first_name || ' ' || u.last_name AS technician_name,
        s.name AS site_name,
        CASE
          WHEN r.actual_start_time IS NOT NULL AND r.actual_end_time IS NOT NULL
          THEN EXTRACT(EPOCH FROM (r.actual_end_time - r.actual_start_time)) / 3600.0
          ELSE 0
        END AS actual_hours,
        CASE
          WHEN ${overdueSql('r')}
          THEN true ELSE false
        END AS is_overdue
      FROM print_requests r
      JOIN printers p ON r.printer_id = p.id
      LEFT JOIN users u ON r.assigned_technician_id = u.id
      LEFT JOIN sites s ON r.site_id = s.id
      WHERE r.status = ANY($1)
      ${filterWhere}
      ORDER BY p.name, r.planned_start_date NULLS LAST
    `, [activeStatuses, ...filterParams]);

    // Group by printer
    const schedule = {};
    result.rows.forEach(r => {
      if (!schedule[r.printer_id]) {
        schedule[r.printer_id] = {
          printer_id: r.printer_id,
          printer_name: r.printer_name,
          technology: r.technology,
          jobs: [],
          plannedHours: 0,
          actualHours: 0,
          overdueJobs: 0,
        };
      }
      schedule[r.printer_id].plannedHours += parseFloat(r.planned_duration_hours || 0);
      schedule[r.printer_id].actualHours += parseFloat(r.actual_hours || 0);
      schedule[r.printer_id].overdueJobs += r.is_overdue ? 1 : 0;
      schedule[r.printer_id].jobs.push(r);
    });

    const printers = Object.values(schedule).map(p => ({
      ...p,
      plannedHours: Math.round(p.plannedHours * 100) / 100,
      actualHours: Math.round(p.actualHours * 100) / 100,
    }));
    const withJobs = printers.filter(p => p.jobs.length > 0);
    const totalPlanned = printers.reduce((sum, p) => sum + p.plannedHours, 0);
    const totalActual = printers.reduce((sum, p) => sum + p.actualHours, 0);

    res.json({
      summary: {
        totalPrinters: printers.length,
        totalJobs: result.rows.length,
        activeJobs: result.rows.filter(r => r.status === 'in_progress').length,
        overdueJobs: result.rows.filter(r => r.is_overdue).length,
        blockedJobs: result.rows.filter(r => r.status === 'blocked').length,
        highPriorityJobs: result.rows.filter(r => ['critical', 'high'].includes(r.priority)).length,
        totalPlannedHours: Math.round(totalPlanned * 100) / 100,
        totalActualHours: Math.round(totalActual * 100) / 100,
        mostLoadedPrinter: withJobs.slice().sort((a, b) => b.plannedHours - a.plannedHours)[0]?.printer_name || null,
        leastLoadedPrinter: withJobs.slice().sort((a, b) => a.plannedHours - b.plannedHours)[0]?.printer_name || null,
      },
      printers,
    });
  } catch (err) {
    console.error('[Planning] Printer schedule error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET technician schedule (active technicians with assigned workload)
exports.getTechnicianSchedule = async (req, res) => {
  try {
    const { technicianWhere, requestWhere, params } = buildTechnicianScheduleFilters(scopedPlanningQuery(req));
    const activeStatuses = TECH_OPEN_STATUSES;

    const result = await db.query(`
      WITH cycle_hours AS (
        SELECT request_id,
               SUM(EXTRACT(EPOCH FROM (end_time - start_time)) / 3600.0)
                 FILTER (WHERE start_time IS NOT NULL AND end_time IS NOT NULL) AS actual_hours
        FROM request_production_cycles
        GROUP BY request_id
      )
      SELECT
        u.id AS technician_id,
        u.first_name || ' ' || u.last_name AS technician_name,
        u.email AS technician_email,
        r.id,
        r.request_number,
        r.title,
        r.status,
        r.priority,
        r.actual_start_time,
        r.actual_end_time,
        r.requested_due_date,
        r.approved_due_date,
        r.planned_start_date,
        r.planned_end_date,
        ${plannedDurationSql('r')} AS planned_duration_hours,
        s.name AS site_name,
        p.name AS printer_name,
        COALESCE(ch.actual_hours,
          CASE
            WHEN r.actual_start_time IS NOT NULL AND r.actual_end_time IS NOT NULL
            THEN EXTRACT(EPOCH FROM (r.actual_end_time - r.actual_start_time)) / 3600.0
            ELSE 0
          END
        ) AS actual_hours,
        CASE
          WHEN ${overdueSql('r')}
          THEN true ELSE false
        END AS is_overdue
      FROM users u
      LEFT JOIN print_requests r ON r.assigned_technician_id = u.id
        AND r.status = ANY($${params.length + 1})
        ${requestWhere}
      LEFT JOIN cycle_hours ch ON ch.request_id = r.id
      LEFT JOIN sites s ON r.site_id = s.id
      LEFT JOIN printers p ON r.printer_id = p.id
      WHERE ${technicianWhere}
      ORDER BY u.last_name, u.first_name, r.approved_due_date ASC NULLS LAST, r.created_at ASC NULLS LAST
    `, [...params, activeStatuses]).catch(async (err) => {
      if (!/request_production_cycles/i.test(err.message)) throw err;
      return db.query(`
        SELECT
          u.id AS technician_id,
          u.first_name || ' ' || u.last_name AS technician_name,
          u.email AS technician_email,
          r.id,
          r.request_number,
          r.title,
          r.status,
          r.priority,
          r.actual_start_time,
          r.actual_end_time,
          r.requested_due_date,
          r.approved_due_date,
          r.planned_start_date,
          r.planned_end_date,
          ${plannedDurationSql('r')} AS planned_duration_hours,
          s.name AS site_name,
          p.name AS printer_name,
          CASE
            WHEN r.actual_start_time IS NOT NULL AND r.actual_end_time IS NOT NULL
            THEN EXTRACT(EPOCH FROM (r.actual_end_time - r.actual_start_time)) / 3600.0
            ELSE 0
          END AS actual_hours,
          CASE
            WHEN ${overdueSql('r')}
            THEN true ELSE false
          END AS is_overdue
        FROM users u
        LEFT JOIN print_requests r ON r.assigned_technician_id = u.id
          AND r.status = ANY($${params.length + 1})
          ${requestWhere}
        LEFT JOIN sites s ON r.site_id = s.id
        LEFT JOIN printers p ON r.printer_id = p.id
        WHERE ${technicianWhere}
        ORDER BY u.last_name, u.first_name, r.approved_due_date ASC NULLS LAST, r.created_at ASC NULLS LAST
      `, [...params, activeStatuses]);
    });

    const map = new Map();
    for (const row of result.rows) {
      if (!map.has(row.technician_id)) {
        map.set(row.technician_id, {
          technicianId: row.technician_id,
          technicianName: row.technician_name,
          technicianEmail: row.technician_email,
          assignedRequests: 0,
          openRequests: 0,
          inProgressRequests: 0,
          overdueRequests: 0,
          plannedHours: 0,
          actualHours: 0,
          loadLevel: 'low',
          requests: [],
        });
      }
      const tech = map.get(row.technician_id);
      if (!row.id) continue;
      const plannedHours = parseFloat(row.planned_duration_hours || 0);
      const actualHours = parseFloat(row.actual_hours || 0);
      tech.assignedRequests += 1;
      tech.openRequests += TECH_OPEN_STATUSES.includes(row.status) ? 1 : 0;
      tech.inProgressRequests += row.status === 'in_progress' ? 1 : 0;
      tech.overdueRequests += row.is_overdue ? 1 : 0;
      tech.plannedHours += plannedHours;
      tech.actualHours += actualHours;
      tech.requests.push({
        id: row.id,
        request_number: row.request_number,
        title: row.title,
        status: row.status,
        priority: row.priority,
        site_name: row.site_name,
        due_date: row.approved_due_date || row.requested_due_date,
        planned_start_date: row.planned_start_date,
        planned_end_date: row.planned_end_date,
        planned_duration_hours: parseFloat(row.planned_duration_hours || 0),
        planned_hours: plannedHours,
        actual_hours: actualHours,
        printer_name: row.printer_name,
        is_overdue: row.is_overdue,
      });
    }

    const technicians = Array.from(map.values()).map((tech) => ({
      ...tech,
      plannedHours: Math.round(tech.plannedHours * 100) / 100,
      actualHours: Math.round(tech.actualHours * 100) / 100,
      loadLevel: loadLevel(tech.plannedHours),
    }));

    const assignedCounts = technicians.map(t => t.assignedRequests);
    const totalPlanned = technicians.reduce((sum, t) => sum + t.plannedHours, 0);
    const totalActual = technicians.reduce((sum, t) => sum + t.actualHours, 0);
    const withRequests = technicians.filter(t => t.assignedRequests > 0);

    res.json({
      summary: {
        totalTechnicians: technicians.length,
        totalAssignedRequests: technicians.reduce((sum, t) => sum + t.assignedRequests, 0),
        averageRequestsPerTechnician: technicians.length ? Math.round((assignedCounts.reduce((a, b) => a + b, 0) / technicians.length) * 100) / 100 : 0,
        mostLoadedTechnician: withRequests.slice().sort((a, b) => b.plannedHours - a.plannedHours)[0]?.technicianName || null,
        leastLoadedTechnician: withRequests.slice().sort((a, b) => a.plannedHours - b.plannedHours)[0]?.technicianName || null,
        totalPlannedHours: Math.round(totalPlanned * 100) / 100,
        totalActualHours: Math.round(totalActual * 100) / 100,
        overdueRequests: technicians.reduce((sum, t) => sum + t.overdueRequests, 0),
        loadThresholds: {
          lowMaxHours: parseFloat(process.env.TECH_LOAD_LOW_HOURS || '8'),
          mediumMaxHours: parseFloat(process.env.TECH_LOAD_MEDIUM_HOURS || '20'),
        },
      },
      technicians,
    });
  } catch (err) {
    console.error('[Planning] Technician schedule error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

