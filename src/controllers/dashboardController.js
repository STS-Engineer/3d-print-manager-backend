const db = require('../config/database');
const { PRODUCTION_TECHNICIAN_ALIASES, roleSqlList } = require('../utils/roles');
const { sendMail, getEmailConfigStatus } = require('../services/emailService');
const {
  ensureNotificationHistoryTable,
  recordNotificationHistory,
} = require('../services/notificationHistoryService');
const { ensureSatisfactionTable } = require('../services/satisfactionService');
const { reworkRequestSql } = require('../services/reworkMetricsService');
const {
  completedCycleHoursSql,
  completedReworkCycleHoursSql,
  invalidPlannedDurationSql,
  logInvalidPlannedDurations,
  reworkCycleSql,
  utilizationSql,
} = require('../services/dashboardMetricsService');

/**
 * KPI RULES — applies to ALL queries:
 *
 * OPEN = NOT IN ('completed','archived','requester_confirmation','waiting_customer_confirmation','cancelled','rejected')
 * COMPLETED = status IN ('completed','requester_confirmation','waiting_customer_confirmation','archived')
 * REJECTED = status = 'rejected'
 * Archived ≠ Deleted — archived requests ALWAYS count in historical KPIs
 *
 * On-Time: completion_date <= COALESCE(approved_due_date, requested_due_date)
 * Lead time: submitted_at → completion_date
 */

const NON_IMPORTED = `COALESCE(source, 'application') <> 'monday'`;
const COMPLETED_STATUS_LIST = "'completed','requester_confirmation','waiting_customer_confirmation','archived'";
const TERMINAL_STATUS_LIST = `${COMPLETED_STATUS_LIST},'cancelled','rejected'`;
const OPEN_STATUSES = `${NON_IMPORTED} AND status NOT IN (${TERMINAL_STATUS_LIST})`;
const COMPLETED_STATUSES = `${NON_IMPORTED} AND status IN (${COMPLETED_STATUS_LIST})`;
const HISTORICAL_COMPLETED_STATUSES = COMPLETED_STATUSES;
const ALL_TERMINAL = `${NON_IMPORTED} AND status IN (${TERMINAL_STATUS_LIST})`;
const OVERDUE_CONDITION = `status NOT IN (${TERMINAL_STATUS_LIST})
  AND ((requested_due_date IS NOT NULL AND requested_due_date < CURRENT_DATE)
    OR (approved_due_date IS NOT NULL AND approved_due_date < CURRENT_DATE))`;

const prefixed = (alias, column) => alias ? `${alias}.${column}` : column;
const nonImportedFor = (alias = '') => `COALESCE(${prefixed(alias, 'source')}, 'application') <> 'monday'`;
const openStatusesFor = (alias = '') => `${nonImportedFor(alias)} AND ${prefixed(alias, 'status')} NOT IN (${TERMINAL_STATUS_LIST})`;
const completedStatusesFor = (alias = '') => `${nonImportedFor(alias)} AND ${prefixed(alias, 'status')} IN (${COMPLETED_STATUS_LIST})`;
const historicalCompletedStatusesFor = completedStatusesFor;
const requestDateExpr = (alias = '') => `COALESCE(${prefixed(alias, 'completion_date')}, ${prefixed(alias, 'ready_at')}, ${prefixed(alias, 'actual_end_time')}, ${prefixed(alias, 'planned_start_date')}, ${prefixed(alias, 'created_at')})`;

const buildDashboardFilters = (query = {}, alias = '', startIndex = 1, dateExpr = requestDateExpr(alias)) => {
  const filters = [];
  const params = [];
  let i = startIndex;
  const add = (field, column) => {
    if (query[field]) {
      filters.push(`${prefixed(alias, column)} = $${i++}`);
      params.push(query[field]);
    }
  };

  add('site_id', 'site_id');
  add('material_id', 'material_id');
  add('printer_id', 'printer_id');
  add('technician_id', 'assigned_technician_id');
  add('priority', 'priority');
  add('status', 'status');
  add('category_id', 'category_id');
  add('requester_id', 'requester_id');
  add('criticality', 'criticality');

  if (query.requester) {
    filters.push(`${prefixed(alias, 'requester_name')} ILIKE $${i++}`);
    params.push(`%${query.requester}%`);
  }
  if (query.department) {
    filters.push(`${prefixed(alias, 'requester_department')} ILIKE $${i++}`);
    params.push(`%${query.department}%`);
  }
  if (query.production_status) {
    const statusCol = prefixed(alias, 'status');
    const productionGroups = {
      planned: ['planned'],
      active: ['assigned', 'in_progress', 'printed', 'post_processing', 'quality_check', 'rework_required'],
      blocked: ['blocked', 'on_hold', 'waiting_for_material', 'waiting_for_machine', 'waiting_for_input'],
      completed: ['ready_for_pickup', 'requester_confirmation', 'completed', 'archived'],
    };
    if (productionGroups[query.production_status]) {
      filters.push(`${statusCol} = ANY($${i++})`);
      params.push(productionGroups[query.production_status]);
    }
  }
  if (query.approval_status) {
    const statusCol = prefixed(alias, 'status');
    const approvalGroups = {
      pending: ['submitted', 'completeness_check', 'feasibility_review'],
      approved: ['approved', 'prioritized', 'planned', 'assigned', 'in_progress', 'printed', 'post_processing', 'quality_check', 'ready_for_pickup', 'requester_confirmation', 'completed', 'archived'],
      rejected: ['rejected'],
    };
    if (approvalGroups[query.approval_status]) {
      filters.push(`${statusCol} = ANY($${i++})`);
      params.push(approvalGroups[query.approval_status]);
    }
  }
  if (query.delivery_status) {
    const statusCol = prefixed(alias, 'status');
    const completedAt = `COALESCE(${prefixed(alias, 'completion_date')}, ${prefixed(alias, 'ready_at')}, ${prefixed(alias, 'actual_end_time')})`;
    const dueDate = `COALESCE(${prefixed(alias, 'approved_due_date')}, ${prefixed(alias, 'requested_due_date')})`;
    if (query.delivery_status === 'overdue') {
      filters.push(`${statusCol} NOT IN (${TERMINAL_STATUS_LIST}) AND ${dueDate} IS NOT NULL AND ${dueDate}::date < CURRENT_DATE`);
    } else if (query.delivery_status === 'awaiting_confirmation') {
      filters.push(`${statusCol} IN ('ready_for_pickup','requester_confirmation','waiting_customer_confirmation')`);
    } else if (query.delivery_status === 'completed') {
      filters.push(`${statusCol} IN (${COMPLETED_STATUS_LIST})`);
    } else if (query.delivery_status === 'on_time') {
      filters.push(`${statusCol} IN (${COMPLETED_STATUS_LIST}) AND ${completedAt} IS NOT NULL AND ${dueDate} IS NOT NULL AND ${completedAt} <= ${dueDate}`);
    } else if (query.delivery_status === 'late') {
      filters.push(`${statusCol} IN (${COMPLETED_STATUS_LIST}) AND ${completedAt} IS NOT NULL AND ${dueDate} IS NOT NULL AND ${completedAt} > ${dueDate}`);
    }
  }

  if (query.date_from) {
    filters.push(`${dateExpr}::date >= $${i++}::date`);
    params.push(query.date_from);
  }
  if (query.date_to) {
    filters.push(`${dateExpr}::date <= $${i++}::date`);
    params.push(query.date_to);
  }
  if (query.month) {
    filters.push(`EXTRACT(MONTH FROM ${dateExpr}) = $${i++}::int`);
    params.push(query.month);
  }
  if (query.year) {
    filters.push(`EXTRACT(YEAR FROM ${dateExpr}) = $${i++}::int`);
    params.push(query.year);
  }

  return {
    sql: filters.length ? ` AND ${filters.join(' AND ')}` : '',
    params,
    nextIndex: i,
  };
};

const buildMaterialFilters = (query = {}, startIndex = 1, alias = '') => {
  const filters = [];
  const params = [];
  let i = startIndex;
  if (query.material_id) {
    filters.push(`${prefixed(alias, 'id')} = $${i++}`);
    params.push(query.material_id);
  }
  if (query.inventory_status === 'low_stock') {
    filters.push(`COALESCE(${prefixed(alias, 'available_quantity')}, ${prefixed(alias, 'stock_quantity')}, 0) <= COALESCE(${prefixed(alias, 'low_stock_threshold')}, 200)`);
  } else if (query.inventory_status === 'in_stock') {
    filters.push(`COALESCE(${prefixed(alias, 'available_quantity')}, ${prefixed(alias, 'stock_quantity')}, 0) > COALESCE(${prefixed(alias, 'low_stock_threshold')}, 200)`);
  }
  return {
    sql: filters.length ? ` AND ${filters.join(' AND ')}` : '',
    params,
    nextIndex: i,
  };
};

const buildEntityFilters = (query = {}, mappings = {}, startIndex = 1) => {
  const filters = [];
  const params = [];
  let i = startIndex;
  Object.entries(mappings).forEach(([field, column]) => {
    if (query[field]) {
      filters.push(`${column} = $${i++}`);
      params.push(query[field]);
    }
  });
  return {
    sql: filters.length ? ` AND ${filters.join(' AND ')}` : '',
    params,
    nextIndex: i,
  };
};

// ── Operational Dashboard ─────────────────────────────────────────────────────
exports.getOperationalDashboard = async (req, res) => {
  try {
    const requestFilter = buildDashboardFilters(req.query);
    const aliasFilter = buildDashboardFilters(req.query, 'r');
    const materialFilter = buildMaterialFilters(req.query);
    const technicianEntityFilter = buildEntityFilters(req.query, { technician_id: 'u.id' }, aliasFilter.nextIndex);
    const printerEntityFilter = buildEntityFilters(req.query, { printer_id: 'p.id', site_id: 'p.site_id' }, aliasFilter.nextIndex);
    const [openByStatus, prioritySplit, techWorkload, printerWorkload,
           overdue, blocked, deptResult, kpiSummary, operationalCounts,
           lowStockAlerts, technicianSchedule, printerSchedule] = await Promise.all([

      // Status split — only REAL open statuses
      db.query(`
        SELECT status, COUNT(*) AS count
        FROM print_requests
        WHERE ${OPEN_STATUSES}${requestFilter.sql}
        GROUP BY status ORDER BY count DESC
      `, requestFilter.params),

      // Priority split — only open requests
      db.query(`
        SELECT priority, COUNT(*) AS count
        FROM print_requests
        WHERE ${OPEN_STATUSES}${requestFilter.sql}
        GROUP BY priority
      `, requestFilter.params),

      // Technician workload — active jobs only
      db.query(`
        SELECT u.first_name || ' ' || u.last_name AS name, COUNT(*) AS count
        FROM print_requests r
        JOIN users u ON r.assigned_technician_id = u.id
        WHERE COALESCE(r.source, 'application') <> 'monday'
          AND r.status IN ('assigned','in_progress','printed','post_processing','quality_check','rework_required')
          ${aliasFilter.sql}
        GROUP BY u.id, u.first_name, u.last_name
        ORDER BY count DESC
      `, aliasFilter.params),

      // Printer workload — only active jobs
      db.query(`
        SELECT p.name, COUNT(*) AS count
        FROM print_requests r
        JOIN printers p ON r.printer_id = p.id
        WHERE COALESCE(r.source, 'application') <> 'monday'
          AND r.status IN ('in_progress','printed')
          ${aliasFilter.sql}
        GROUP BY p.id, p.name
      `, aliasFilter.params),

      // Overdue — open requests past due date
      db.query(`
        SELECT COUNT(*) AS count FROM print_requests
        WHERE ${OPEN_STATUSES}${requestFilter.sql}
          AND ${OVERDUE_CONDITION}
      `, requestFilter.params),

      // Blocked
      db.query(`SELECT COUNT(*) AS count FROM print_requests WHERE ${NON_IMPORTED} AND status = 'blocked'${requestFilter.sql}`, requestFilter.params),

      // Department split — all non-cancelled
      db.query(`
        SELECT requester_department AS department, COUNT(*) AS count
        FROM print_requests
        WHERE ${NON_IMPORTED} AND status != 'cancelled'${requestFilter.sql}
        GROUP BY requester_department
        ORDER BY count DESC LIMIT 10
      `, requestFilter.params),

      // KPI summary counts
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE ${OPEN_STATUSES})                              AS open_count,
          COUNT(*) FILTER (WHERE ${COMPLETED_STATUSES})                         AS completed_count,
          COUNT(*) FILTER (WHERE status = 'rejected')                           AS rejected_count,
          COUNT(*) FILTER (WHERE status = 'cancelled')                          AS cancelled_count,
          COUNT(*)                                                               AS total_count
        FROM print_requests
        WHERE ${NON_IMPORTED}${requestFilter.sql}
      `, requestFilter.params),

      // Daily operational action counters
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('submitted','completeness_check','feasibility_review')) AS awaiting_approval,
          COUNT(*) FILTER (WHERE status = 'requester_confirmation')                                  AS awaiting_requester_confirmation,
          COUNT(*) FILTER (WHERE status = 'rework_required')                                         AS rework_required,
          COUNT(*) FILTER (WHERE status = 'more_info_required')                                      AS information_required,
          COUNT(*) FILTER (WHERE status = 'rejected')                                                AS rejected
        FROM print_requests
        WHERE ${NON_IMPORTED}${requestFilter.sql}
      `, requestFilter.params),

      // Low stock alerts
      db.query(`
        SELECT COUNT(*) AS count
        FROM materials
        WHERE COALESCE(available_quantity, stock_quantity, 0) <= COALESCE(low_stock_threshold, 200)
          ${materialFilter.sql}
      `, materialFilter.params),

      // Technician schedule
      db.query(`
        SELECT
          u.id,
          u.first_name || ' ' || u.last_name AS technician,
          COUNT(r.id) FILTER (WHERE r.status = 'assigned')    AS assigned_requests,
          COUNT(r.id) FILTER (WHERE r.status = 'in_progress') AS in_progress_requests,
          COUNT(r.id) FILTER (WHERE r.status = 'planned')     AS planned_requests
        FROM users u
        LEFT JOIN print_requests r ON r.assigned_technician_id = u.id
          AND COALESCE(r.source, 'application') <> 'monday'
          AND r.status IN ('planned','assigned','in_progress')
          ${aliasFilter.sql}
        WHERE u.role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)}) AND u.is_active = true
          ${technicianEntityFilter.sql}
        GROUP BY u.id, u.first_name, u.last_name
        ORDER BY assigned_requests DESC, in_progress_requests DESC, planned_requests DESC, technician
      `, [...aliasFilter.params, ...technicianEntityFilter.params]),

      // Printer schedule
      db.query(`
        SELECT
          p.id,
          p.name AS printer,
          p.status AS availability,
          COUNT(r.id) FILTER (WHERE r.status IN ('in_progress','printed','post_processing','quality_check')) AS current_jobs,
          COUNT(r.id) FILTER (WHERE r.status IN ('planned','assigned'))                                      AS planned_jobs
        FROM printers p
        LEFT JOIN print_requests r ON r.printer_id = p.id
          AND COALESCE(r.source, 'application') <> 'monday'
          AND r.status IN ('planned','assigned','in_progress','printed','post_processing','quality_check')
          ${aliasFilter.sql}
        WHERE p.is_active = true
          ${printerEntityFilter.sql}
        GROUP BY p.id, p.name, p.status
        ORDER BY current_jobs DESC, planned_jobs DESC, p.name
      `, [...aliasFilter.params, ...printerEntityFilter.params]),
    ]);

    res.json({
      statusSplit:    openByStatus.rows,
      prioritySplit:  prioritySplit.rows,
      techWorkload:   techWorkload.rows,
      printerWorkload: printerWorkload.rows,
      overdueCount:   parseInt(overdue.rows[0].count),
      blockedCount:   parseInt(blocked.rows[0].count),
      awaitingApprovalCount: parseInt(operationalCounts.rows[0].awaiting_approval) || 0,
      awaitingRequesterConfirmationCount: parseInt(operationalCounts.rows[0].awaiting_requester_confirmation) || 0,
      reworkRequiredCount: parseInt(operationalCounts.rows[0].rework_required) || 0,
      informationRequiredCount: parseInt(operationalCounts.rows[0].information_required) || 0,
      rejectedCount: parseInt(operationalCounts.rows[0].rejected) || 0,
      lowStockAlertsCount: parseInt(lowStockAlerts.rows[0].count) || 0,
      technicianSchedule: technicianSchedule.rows,
      printerSchedule: printerSchedule.rows,
      departmentSplit: deptResult.rows,
      kpiSummary:     kpiSummary.rows[0],
    });
  } catch (err) {
    console.error('[Dashboard] Operational error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Performance Dashboard ─────────────────────────────────────────────────────
exports.getPerformanceDashboard = async (req, res) => {
  try {
    await ensureSatisfactionTable(db);
    const { period = '30' } = req.query;
    const days = parseInt(period);
    const hasExplicitDateFilter = Boolean(req.query.date_from || req.query.date_to || req.query.month || req.query.year);
    const periodSql = hasExplicitDateFilter ? '' : ` AND COALESCE(completion_date, ready_at, actual_end_time, created_at) > NOW() - INTERVAL '${days} days'`;
    const requestFilter = buildDashboardFilters(req.query);
    const aliasFilter = buildDashboardFilters(req.query, 'r');

    const [avgLeadTime, onTime, historicalCompletedCount, completedByWeek, reworkRate,
           failedRate, backlogAging, techPerf, reworkAnalysis,
           materialConsumption, materialByType, printerPerformance,
           technicianPerformance, costTrend, satisfactionSummary,
           satisfactionTrend, satisfactionDistribution, satisfactionBySite,
           satisfactionByTechnician] = await Promise.all([

      // Average lead time — submitted_at → completion_date
      // Include archived (they were completed)
      db.query(`
        SELECT
          ROUND(
            AVG(EXTRACT(EPOCH FROM (COALESCE(completion_date, ready_at, actual_end_time) - submitted_at)) / 3600)::NUMERIC,
            1
          ) AS avg_hours
        FROM print_requests
        WHERE ${HISTORICAL_COMPLETED_STATUSES}${requestFilter.sql}
          AND COALESCE(completion_date, ready_at, actual_end_time) IS NOT NULL
          AND submitted_at IS NOT NULL
          ${periodSql}
      `, requestFilter.params),

      // On-time delivery: completed on or before approved_due_date (or requested if no approved)
      // Include archived — they were completed
      db.query(`
        SELECT
          COUNT(*) FILTER (
            WHERE COALESCE(completion_date, ready_at, actual_end_time) <= COALESCE(approved_due_date, requested_due_date)
          )                                                                   AS on_time,
          COUNT(*)                                                            AS total
        FROM print_requests
        WHERE ${HISTORICAL_COMPLETED_STATUSES}${requestFilter.sql}
          AND COALESCE(completion_date, ready_at, actual_end_time) IS NOT NULL
          AND COALESCE(approved_due_date, requested_due_date) IS NOT NULL
          ${periodSql}
      `, requestFilter.params),

      // Completed per week — include archived
      db.query(`
        SELECT COUNT(*) AS total
        FROM print_requests
        WHERE ${HISTORICAL_COMPLETED_STATUSES}${requestFilter.sql}
          ${periodSql}
      `, requestFilter.params),

      db.query(`
        SELECT
          DATE_TRUNC('week', COALESCE(completion_date, ready_at, actual_end_time))::DATE AS week,
          COUNT(*) AS count
        FROM print_requests
        WHERE ${HISTORICAL_COMPLETED_STATUSES}${requestFilter.sql}
          AND COALESCE(completion_date, ready_at, actual_end_time) IS NOT NULL
          ${periodSql}
        GROUP BY DATE_TRUNC('week', COALESCE(completion_date, ready_at, actual_end_time))
        ORDER BY week
      `, requestFilter.params),

      // Rework rate - historically completed requests, including archived
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE ${reworkRequestSql('print_requests')}) AS rework_count,
          COUNT(*)                                        AS total
        FROM print_requests
        WHERE ${HISTORICAL_COMPLETED_STATUSES}
          ${requestFilter.sql}
          ${periodSql}
      `, requestFilter.params),

      // Failed print rate
      db.query(`
        SELECT
          COALESCE(SUM(COALESCE(rejected_quantity, scrap_count, 0)), 0) AS failed_count,
          COALESCE(SUM(GREATEST(COALESCE(printed_quantity, 0) + COALESCE(rejected_quantity, scrap_count, 0), 1)), 0) AS total
        FROM print_requests
        WHERE ${HISTORICAL_COMPLETED_STATUSES}${requestFilter.sql}
          ${periodSql}
      `, requestFilter.params),

      // Backlog aging — only truly open requests
      db.query(`
        SELECT
          CASE
            WHEN created_at > NOW() - INTERVAL '7 days'  THEN '0-7 days'
            WHEN created_at > NOW() - INTERVAL '14 days' THEN '7-14 days'
            WHEN created_at > NOW() - INTERVAL '30 days' THEN '14-30 days'
            ELSE '30+ days'
          END AS age_bucket,
          COUNT(*) AS count
        FROM print_requests
        WHERE ${OPEN_STATUSES}${requestFilter.sql}
        GROUP BY age_bucket
        ORDER BY MIN(created_at)
      `, requestFilter.params),

      // Technician performance
      db.query(`
        WITH technician_cycle_hours AS (
          SELECT
            r.assigned_technician_id,
            ROUND((AVG(${completedCycleHoursSql('r', 'pc')}) FILTER (WHERE ${completedCycleHoursSql('r', 'pc')} > 0))::NUMERIC, 1) AS avg_duration_h,
            COUNT(*) FILTER (WHERE ${invalidPlannedDurationSql('r')}) AS invalid_planned_duration_count
          FROM print_requests r
          JOIN request_production_cycles pc ON pc.request_id = r.id
          WHERE ${historicalCompletedStatusesFor('r')}
            ${aliasFilter.sql}
            ${hasExplicitDateFilter ? '' : `AND COALESCE(pc.end_time, r.completion_date, r.ready_at, r.actual_end_time, r.created_at) > NOW() - INTERVAL '${days} days'`}
          GROUP BY r.assigned_technician_id
        ),
        technician_counts AS (
          SELECT
            r.assigned_technician_id,
            COUNT(r.id) FILTER (WHERE ${historicalCompletedStatusesFor('r')}) AS completed,
            COUNT(r.id) FILTER (WHERE ${historicalCompletedStatusesFor('r')} AND ${reworkRequestSql('r')}) AS rework,
            COUNT(r.id) FILTER (
              WHERE ${historicalCompletedStatusesFor('r')}
                AND COALESCE(r.completion_date, r.ready_at, r.actual_end_time) <= COALESCE(r.approved_due_date, r.requested_due_date)
            ) AS on_time
          FROM print_requests r
          WHERE COALESCE(r.source, 'application') <> 'monday'
            ${aliasFilter.sql}
            ${hasExplicitDateFilter ? '' : `AND COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.created_at) > NOW() - INTERVAL '${days} days'`}
          GROUP BY r.assigned_technician_id
        )
        SELECT
          u.first_name || ' ' || u.last_name          AS technician,
          COALESCE(tc.completed, 0) AS completed,
          COALESCE(tc.rework, 0) AS rework,
          COALESCE(tch.avg_duration_h, 0) AS avg_duration_h,
          COALESCE(tc.on_time, 0) AS on_time,
          COALESCE(tch.invalid_planned_duration_count, 0) AS invalid_planned_duration_count
        FROM users u
        LEFT JOIN technician_counts tc ON tc.assigned_technician_id = u.id
        LEFT JOIN technician_cycle_hours tch ON tch.assigned_technician_id = u.id
        WHERE u.role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)}) AND u.is_active = true
        ORDER BY completed DESC
      `, aliasFilter.params),

      // Rework analysis — cumulative rework cycle data
      db.query(`
        SELECT
          COUNT(DISTINCT r.id) AS rework_requests,
          COALESCE(SUM(pc.actual_cost), 0) AS rework_cost,
          COALESCE(SUM(pc.material_used), 0) AS rework_material_used,
          COALESCE(SUM(${completedReworkCycleHoursSql('r', 'pc')}), 0) AS rework_print_time,
          COUNT(*) FILTER (WHERE ${invalidPlannedDurationSql('r')}) AS invalid_planned_duration_count
        FROM request_production_cycles pc
        JOIN print_requests r ON r.id = pc.request_id
        WHERE ${reworkCycleSql('pc')}
          AND ${NON_IMPORTED.replace(/source/g, 'r.source')}
          AND ${completedStatusesFor('r')}
          ${aliasFilter.sql}
          ${hasExplicitDateFilter ? '' : `AND COALESCE(pc.end_time, pc.created_at) > NOW() - INTERVAL '${days} days'`}
      `, aliasFilter.params),

      // Material consumption summary
      db.query(`
        SELECT
          COALESCE(SUM(material_used_grams), 0) AS total_material_used,
          ROUND(AVG(material_used_grams) FILTER (WHERE material_used_grams IS NOT NULL)::NUMERIC, 1) AS average_material_per_request
        FROM print_requests
        WHERE ${HISTORICAL_COMPLETED_STATUSES}${requestFilter.sql}
          ${periodSql}
      `, requestFilter.params),

      // Material consumption by material type
      db.query(`
        SELECT
          COALESCE(m.type, 'Unknown') AS material_type,
          COALESCE(SUM(r.material_used_grams), 0) AS material_used
        FROM print_requests r
        LEFT JOIN materials m ON r.material_id = m.id
        WHERE ${historicalCompletedStatusesFor('r')}
          ${aliasFilter.sql}
          ${hasExplicitDateFilter ? '' : `AND COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.created_at) > NOW() - INTERVAL '${days} days'`}
        GROUP BY COALESCE(m.type, 'Unknown')
        ORDER BY material_used DESC
      `, aliasFilter.params),

      // Printer performance
      db.query(`
        WITH cycle_hours AS (
          SELECT
            r.printer_id,
            ROUND(COALESCE(SUM(${completedCycleHoursSql('r', 'pc')}), 0)::NUMERIC, 1) AS print_hours,
            COUNT(*) FILTER (WHERE ${invalidPlannedDurationSql('r')}) AS invalid_planned_duration_count
          FROM print_requests r
          JOIN request_production_cycles pc ON pc.request_id = r.id
          WHERE ${historicalCompletedStatusesFor('r')}
            ${aliasFilter.sql}
            ${hasExplicitDateFilter ? '' : `AND COALESCE(pc.end_time, r.completion_date, r.ready_at, r.actual_end_time, r.created_at) > NOW() - INTERVAL '${days} days'`}
          GROUP BY r.printer_id
        ),
        request_totals AS (
          SELECT
            r.printer_id,
            COUNT(r.id) AS requests_completed,
            COALESCE(SUM(COALESCE(r.rejected_quantity, r.scrap_count, 0)), 0) AS failed_prints,
            COALESCE(SUM(GREATEST(COALESCE(r.printed_quantity, 0) + COALESCE(r.rejected_quantity, r.scrap_count, 0), 1)), 0) AS total_prints,
            COUNT(r.id) FILTER (WHERE ${reworkRequestSql('r')}) AS rework_requests
          FROM print_requests r
          WHERE ${historicalCompletedStatusesFor('r')}
            ${aliasFilter.sql}
            ${hasExplicitDateFilter ? '' : `AND COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.created_at) > NOW() - INTERVAL '${days} days'`}
          GROUP BY r.printer_id
        ),
        printer_keys AS (
          SELECT printer_id FROM request_totals
          UNION
          SELECT printer_id FROM cycle_hours
        )
        SELECT
          COALESCE(p.name, 'Unassigned') AS printer,
          COALESCE(rt.requests_completed, 0) AS requests_completed,
          COALESCE(ch.print_hours, 0) AS print_hours,
          COALESCE(rt.failed_prints, 0) AS failed_prints,
          COALESCE(rt.total_prints, 0) AS total_prints,
          COALESCE(rt.rework_requests, 0) AS rework_requests,
          COALESCE(ch.invalid_planned_duration_count, 0) AS invalid_planned_duration_count
        FROM printer_keys pk
        LEFT JOIN request_totals rt ON rt.printer_id IS NOT DISTINCT FROM pk.printer_id
        LEFT JOIN cycle_hours ch ON ch.printer_id IS NOT DISTINCT FROM pk.printer_id
        LEFT JOIN printers p ON p.id = pk.printer_id
        ORDER BY requests_completed DESC, print_hours DESC
      `, aliasFilter.params),

      // Technician production performance
      db.query(`
        WITH cycle_hours AS (
          SELECT
            r.assigned_technician_id,
            ROUND(COALESCE(SUM(${completedCycleHoursSql('r', 'pc')}), 0)::NUMERIC, 1) AS actual_print_hours,
            COUNT(*) FILTER (WHERE ${invalidPlannedDurationSql('r')}) AS invalid_planned_duration_count
          FROM print_requests r
          JOIN request_production_cycles pc ON pc.request_id = r.id
          WHERE ${historicalCompletedStatusesFor('r')}
            ${aliasFilter.sql}
            ${hasExplicitDateFilter ? '' : `AND COALESCE(pc.end_time, r.completion_date, r.ready_at, r.actual_end_time, r.created_at) > NOW() - INTERVAL '${days} days'`}
          GROUP BY r.assigned_technician_id
        ),
        request_totals AS (
          SELECT
            r.assigned_technician_id,
            COALESCE(SUM(r.material_used_grams), 0) AS material_consumed,
            COALESCE(SUM(r.actual_cost), 0) AS actual_cost_managed
          FROM print_requests r
          WHERE ${historicalCompletedStatusesFor('r')}
            ${aliasFilter.sql}
            ${hasExplicitDateFilter ? '' : `AND COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.created_at) > NOW() - INTERVAL '${days} days'`}
          GROUP BY r.assigned_technician_id
        )
        SELECT
          u.first_name || ' ' || u.last_name AS technician,
          COALESCE(ch.actual_print_hours, 0) AS actual_print_hours,
          COALESCE(rt.material_consumed, 0) AS material_consumed,
          COALESCE(rt.actual_cost_managed, 0) AS actual_cost_managed,
          COALESCE(ch.invalid_planned_duration_count, 0) AS invalid_planned_duration_count
        FROM users u
        LEFT JOIN cycle_hours ch ON ch.assigned_technician_id = u.id
        LEFT JOIN request_totals rt ON rt.assigned_technician_id = u.id
        WHERE u.role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)}) AND u.is_active = true
          AND (
            COALESCE(ch.actual_print_hours, 0) > 0
            OR COALESCE(rt.material_consumed, 0) > 0
            OR COALESCE(rt.actual_cost_managed, 0) > 0
          )
        ORDER BY actual_print_hours DESC, actual_cost_managed DESC
      `, aliasFilter.params),

      // Monthly actual cost trend
      db.query(`
        SELECT
          DATE_TRUNC('month', COALESCE(completion_date, ready_at, actual_end_time, created_at))::DATE AS month,
          COALESCE(SUM(actual_cost), 0) AS actual_cost
        FROM print_requests
        WHERE ${HISTORICAL_COMPLETED_STATUSES}${requestFilter.sql}
          ${periodSql}
        GROUP BY DATE_TRUNC('month', COALESCE(completion_date, ready_at, actual_end_time, created_at))
        ORDER BY month
      `, requestFilter.params),

      db.query(`
        SELECT
          ROUND(AVG(s.overall_rating)::NUMERIC, 2) AS average_satisfaction_score,
          ROUND(AVG(s.quality_rating)::NUMERIC, 2) AS average_quality_rating,
          ROUND(AVG(s.delivery_rating)::NUMERIC, 2) AS average_delivery_rating,
          ROUND(AVG(s.communication_rating)::NUMERIC, 2) AS average_communication_rating,
          ROUND(100.0 * COUNT(s.id) FILTER (WHERE s.recommendation_score = 'yes') / NULLIF(COUNT(s.id), 0), 1) AS recommendation_rate,
          ROUND(100.0 * COUNT(s.id) / NULLIF(COUNT(r.id) FILTER (WHERE ${historicalCompletedStatusesFor('r')}), 0), 1) AS survey_participation_rate,
          COUNT(s.id) AS responses
        FROM print_requests r
        LEFT JOIN request_satisfaction_surveys s ON s.request_id = r.id
        WHERE COALESCE(r.source, 'application') <> 'monday'
          ${aliasFilter.sql}
          ${hasExplicitDateFilter ? '' : `AND COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.created_at) > NOW() - INTERVAL '${days} days'`}
      `, aliasFilter.params),

      db.query(`
        SELECT
          DATE_TRUNC('month', COALESCE(s.created_at, r.completion_date, r.ready_at, r.actual_end_time))::DATE AS month,
          ROUND(AVG(s.overall_rating)::NUMERIC, 2) AS average_satisfaction
        FROM request_satisfaction_surveys s
        JOIN print_requests r ON r.id = s.request_id
        WHERE COALESCE(r.source, 'application') <> 'monday'
          ${aliasFilter.sql}
          ${hasExplicitDateFilter ? '' : `AND COALESCE(s.created_at, r.completion_date, r.ready_at, r.actual_end_time) > NOW() - INTERVAL '${days} days'`}
        GROUP BY DATE_TRUNC('month', COALESCE(s.created_at, r.completion_date, r.ready_at, r.actual_end_time))
        ORDER BY month
      `, aliasFilter.params),

      db.query(`
        SELECT rating, COUNT(r.id) AS count
        FROM generate_series(1, 5) rating
        LEFT JOIN request_satisfaction_surveys s ON s.overall_rating = rating
        LEFT JOIN print_requests r ON r.id = s.request_id
          AND COALESCE(r.source, 'application') <> 'monday'
          ${aliasFilter.sql}
        GROUP BY rating
        ORDER BY rating
      `, aliasFilter.params),

      db.query(`
        SELECT
          COALESCE(si.name, 'Unassigned') AS site,
          ROUND(AVG(s.overall_rating)::NUMERIC, 2) AS average_satisfaction,
          COUNT(s.id) AS responses
        FROM request_satisfaction_surveys s
        JOIN print_requests r ON r.id = s.request_id
        LEFT JOIN sites si ON r.site_id = si.id
        WHERE COALESCE(r.source, 'application') <> 'monday'
          ${aliasFilter.sql}
        GROUP BY COALESCE(si.name, 'Unassigned')
        ORDER BY average_satisfaction DESC NULLS LAST, responses DESC
      `, aliasFilter.params),

      db.query(`
        SELECT
          COALESCE(u.first_name || ' ' || u.last_name, 'Unassigned') AS technician,
          ROUND(AVG(s.overall_rating)::NUMERIC, 2) AS average_satisfaction,
          COUNT(s.id) AS responses
        FROM request_satisfaction_surveys s
        JOIN print_requests r ON r.id = s.request_id
        LEFT JOIN users u ON r.assigned_technician_id = u.id
        WHERE COALESCE(r.source, 'application') <> 'monday'
          ${aliasFilter.sql}
        GROUP BY COALESCE(u.first_name || ' ' || u.last_name, 'Unassigned')
        ORDER BY average_satisfaction DESC NULLS LAST, responses DESC
      `, aliasFilter.params),
    ]);

    logInvalidPlannedDurations('Performance - Technician Average Duration', techPerf.rows);
    logInvalidPlannedDurations('Performance - Rework Analysis', reworkAnalysis.rows);
    logInvalidPlannedDurations('Performance - Printer Performance', printerPerformance.rows);
    logInvalidPlannedDurations('Performance - Technician Production Performance', technicianPerformance.rows);

    const onTimeData = onTime.rows[0];
    const onTimeRate = onTimeData.total > 0
      ? Math.round((parseInt(onTimeData.on_time) / parseInt(onTimeData.total)) * 100)
      : 0;

    const reworkData = reworkRate.rows[0];
    const reworkRateVal = reworkData.total > 0
      ? Math.round((parseInt(reworkData.rework_count) / parseInt(reworkData.total)) * 100)
      : 0;

    const failData = failedRate.rows[0];
    const failRateVal = failData.total > 0
      ? Math.round((parseInt(failData.failed_count) / parseInt(failData.total)) * 100)
      : 0;

    res.json({
      avgLeadTimeHours: parseFloat(avgLeadTime.rows[0]?.avg_hours) || 0,
      completedRequests: parseInt(historicalCompletedCount.rows[0]?.total || 0, 10),
      onTimeRate,
      completedByWeek: completedByWeek.rows,
      reworkRate:      reworkRateVal,
      failedPrintRate: failRateVal,
      backlogAging:    backlogAging.rows,
      techPerformance: techPerf.rows,
      reworkAnalysis:  reworkAnalysis.rows[0],
      materialConsumption: {
        ...materialConsumption.rows[0],
        byType: materialByType.rows,
      },
      printerPerformance: printerPerformance.rows.map(row => {
        const completed = parseInt(row.requests_completed || 0, 10);
        const failed = parseInt(row.failed_prints || 0, 10);
        const totalPrints = parseInt(row.total_prints || 0, 10);
        const reworkRequests = parseInt(row.rework_requests || 0, 10);
        return {
          ...row,
          success_rate: totalPrints > 0 ? Math.max(0, Math.round(((totalPrints - failed) / totalPrints) * 100)) : 0,
          rework_rate: completed > 0 ? Math.round((reworkRequests / completed) * 100) : 0,
        };
      }),
      technicianProductionPerformance: technicianPerformance.rows,
      costTrend: costTrend.rows,
      requesterSatisfaction: {
        summary: satisfactionSummary.rows[0],
        trend: satisfactionTrend.rows,
        distribution: satisfactionDistribution.rows,
        bySite: satisfactionBySite.rows,
        byTechnician: satisfactionByTechnician.rows,
      },
    });
  } catch (err) {
    console.error('[Dashboard] Performance error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Management Dashboard ──────────────────────────────────────────────────────
exports.getManagementDashboard = async (req, res) => {
  try {
    await ensureSatisfactionTable(db);
    const requestFilter = buildDashboardFilters(req.query);
    const aliasFilter = buildDashboardFilters(req.query, 'r');
    const printerCapacityHours = Math.max(parseFloat(process.env.RESOURCE_PRINTER_MONTHLY_HOURS || '160') || 0, 0);
    const technicianCapacityHours = Math.max(parseFloat(process.env.RESOURCE_TECHNICIAN_MONTHLY_HOURS || '160') || 0, 0);
    const [demandTrend, topCategories, serviceLevel,
           bottlenecks, productionReviewPerf, costBySite, costByDepartment,
           costByCategory, capacityOverview, forecast, managementSatisfaction] = await Promise.all([

      // Demand vs completion trend — 6 months
      // archived requests count as completed for historical KPIs
      db.query(`
        SELECT
          DATE_TRUNC('month', created_at)::DATE                                              AS month,
          COUNT(*)                                                                            AS submitted,
          COUNT(*) FILTER (WHERE ${COMPLETED_STATUSES.replace(/status/g,'status')})          AS completed,
          COUNT(*) FILTER (WHERE status = 'rejected')                                        AS rejected,
          COUNT(*) FILTER (WHERE status = 'cancelled')                                       AS cancelled
        FROM print_requests
        WHERE ${NON_IMPORTED} AND created_at > NOW() - INTERVAL '6 months'${requestFilter.sql}
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month
      `, requestFilter.params),

      // Top categories — all requests (not just open)
      db.query(`
        SELECT COALESCE(c.name, 'Uncategorized') AS name, COUNT(*) AS count
        FROM print_requests r
        LEFT JOIN request_categories c ON r.category_id = c.id
        WHERE COALESCE(r.source, 'application') <> 'monday' AND r.status != 'cancelled'${aliasFilter.sql}
        GROUP BY c.name
        ORDER BY count DESC LIMIT 8
      `, aliasFilter.params),

      // Service level — correct open count
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE ${OPEN_STATUSES})         AS open,
          COUNT(*) FILTER (WHERE ${COMPLETED_STATUSES})    AS completed,
          COUNT(*) FILTER (WHERE status = 'rejected')      AS rejected,
          COUNT(*) FILTER (WHERE status = 'cancelled')     AS cancelled,
          COUNT(*) FILTER (
            WHERE ${OPEN_STATUSES}
              AND ${OVERDUE_CONDITION}
          )                                                AS overdue,
          COUNT(*) FILTER (WHERE status = 'blocked')       AS blocked,
          COUNT(*)                                         AS total
        FROM print_requests
        WHERE ${NON_IMPORTED}${requestFilter.sql}
      `, requestFilter.params),

      // Bottlenecks — open requests stuck in waiting states
      db.query(`
        SELECT status, COUNT(*) AS count
        FROM print_requests
        WHERE ${NON_IMPORTED}
          AND status IN ('more_info_required','blocked','on_hold',
                         'waiting_for_material','waiting_for_machine',
                         'rework_required','waiting_for_input')
          ${requestFilter.sql}
        GROUP BY status
        ORDER BY count DESC
      `, requestFilter.params),

      // Production review performance
      db.query(`
        SELECT
          ROUND(
            AVG(EXTRACT(EPOCH FROM (approved_at - submitted_at)) / 3600)::NUMERIC, 1
          ) AS avg_review_hours,
          COUNT(*) FILTER (WHERE ${COMPLETED_STATUSES}) AS total_completed,
          COUNT(*) FILTER (WHERE status = 'rejected')   AS total_rejected,
          COUNT(*) FILTER (WHERE ${OPEN_STATUSES})       AS total_open
        FROM print_requests
        WHERE ${NON_IMPORTED} AND submitted_at IS NOT NULL${requestFilter.sql}
      `, requestFilter.params),

      // Cost by site
      db.query(`
        SELECT
          COALESCE(s.name, 'Unassigned') AS site,
          COUNT(r.id) AS requests,
          COALESCE(SUM(r.actual_cost), 0) AS actual_cost
        FROM print_requests r
        LEFT JOIN sites s ON r.site_id = s.id
        WHERE COALESCE(r.source, 'application') <> 'monday'
          AND r.status NOT IN ('cancelled','rejected')
          ${aliasFilter.sql}
        GROUP BY COALESCE(s.name, 'Unassigned')
        ORDER BY actual_cost DESC, requests DESC
        LIMIT 10
      `, aliasFilter.params),

      // Cost by requester department
      db.query(`
        SELECT
          COALESCE(NULLIF(requester_department, ''), 'Unknown') AS department,
          COALESCE(SUM(actual_cost), 0) AS total_cost,
          COUNT(id) AS request_count
        FROM print_requests
        WHERE ${NON_IMPORTED}
          AND status NOT IN ('cancelled','rejected')
          ${requestFilter.sql}
        GROUP BY COALESCE(NULLIF(requester_department, ''), 'Unknown')
        ORDER BY total_cost DESC, request_count DESC
        LIMIT 10
      `, requestFilter.params),

      // Cost by request category
      db.query(`
        SELECT
          COALESCE(c.name, 'Other') AS category,
          COALESCE(SUM(r.actual_cost), 0) AS total_cost,
          COUNT(r.id) AS request_count
        FROM print_requests r
        LEFT JOIN request_categories c ON r.category_id = c.id
        WHERE COALESCE(r.source, 'application') <> 'monday'
          AND r.status NOT IN ('cancelled','rejected')
          ${aliasFilter.sql}
        GROUP BY COALESCE(c.name, 'Other')
        ORDER BY total_cost DESC, request_count DESC
      `, aliasFilter.params),

      // Current capacity overview
      db.query(`
        WITH printer_capacity AS (
          SELECT
            COUNT(*) FILTER (WHERE is_active = true) AS total_printers,
            COUNT(*) FILTER (
              WHERE is_active = true
                AND EXISTS (
                  SELECT 1 FROM print_requests r
                  WHERE r.printer_id = printers.id
                    AND COALESCE(r.source, 'application') <> 'monday'
                    AND r.status IN ('planned','assigned','in_progress','printed','post_processing','quality_check','rework_required')
                    ${aliasFilter.sql}
                )
            ) AS active_printers
          FROM printers
        ),
        technician_capacity AS (
          SELECT
            COUNT(*) FILTER (WHERE role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)}) AND is_active = true) AS total_technicians,
            COUNT(*) FILTER (
              WHERE role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)})
                AND is_active = true
                AND EXISTS (
                  SELECT 1 FROM print_requests r
                  WHERE r.assigned_technician_id = users.id
                    AND COALESCE(r.source, 'application') <> 'monday'
                    AND r.status IN ('planned','assigned','in_progress','printed','post_processing','quality_check','rework_required')
                    ${aliasFilter.sql}
                )
            ) AS active_technicians
          FROM users
        ),
        printer_hours AS (
          SELECT COALESCE(SUM(${completedCycleHoursSql('r', 'pc')}), 0) AS completed_print_hours,
                 COUNT(*) FILTER (WHERE ${invalidPlannedDurationSql('r')}) AS invalid_planned_duration_count
          FROM print_requests r
          JOIN request_production_cycles pc ON pc.request_id = r.id
          WHERE ${historicalCompletedStatusesFor('r')}
            ${aliasFilter.sql}
        ),
        technician_hours AS (
          SELECT COALESCE(SUM(${completedCycleHoursSql('r', 'pc')}), 0) AS completed_print_hours
          FROM print_requests r
          JOIN request_production_cycles pc ON pc.request_id = r.id
          WHERE ${historicalCompletedStatusesFor('r')}
            AND r.assigned_technician_id IS NOT NULL
            ${aliasFilter.sql}
        )
        SELECT
          total_printers,
          active_printers,
          ${utilizationSql('ph.completed_print_hours', `(total_printers * ${printerCapacityHours})`)} AS printer_utilization,
          total_technicians,
          active_technicians,
          ${utilizationSql('th.completed_print_hours', `(total_technicians * ${technicianCapacityHours})`)} AS technician_utilization,
          COALESCE(ph.completed_print_hours, 0) AS completed_printer_print_hours,
          COALESCE(th.completed_print_hours, 0) AS completed_technician_print_hours,
          COALESCE(ph.invalid_planned_duration_count, 0) AS invalid_planned_duration_count,
          GREATEST(
            0,
            ROUND(100 - GREATEST(
              ${utilizationSql('ph.completed_print_hours', `(total_printers * ${printerCapacityHours})`)},
              ${utilizationSql('th.completed_print_hours', `(total_technicians * ${technicianCapacityHours})`)}
            ), 1)
          ) AS open_capacity
        FROM printer_capacity, technician_capacity, printer_hours ph, technician_hours th
      `, aliasFilter.params),

      // Forecast based on monthly averages over the last 6 months
      db.query(`
        WITH monthly AS (
          SELECT
            DATE_TRUNC('month', created_at)::DATE AS month,
            COUNT(*) AS requests,
            COALESCE(SUM(material_used_grams), 0) AS material_consumption,
            COALESCE(SUM(actual_cost), 0) AS cost
          FROM print_requests
          WHERE ${NON_IMPORTED}
            AND status NOT IN ('cancelled','rejected')
            AND created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '6 months'
            ${requestFilter.sql}
          GROUP BY DATE_TRUNC('month', created_at)
        )
        SELECT
          ROUND(COALESCE(AVG(requests), 0)::NUMERIC, 0) AS forecast_requests,
          ROUND(COALESCE(AVG(material_consumption), 0)::NUMERIC, 0) AS forecast_material_consumption,
          ROUND(COALESCE(AVG(cost), 0)::NUMERIC, 2) AS forecast_cost
        FROM monthly
      `, requestFilter.params),

      db.query(`
        SELECT
          ROUND(AVG(s.overall_rating)::NUMERIC, 2) AS customer_satisfaction,
          ROUND(100.0 * COUNT(s.id) FILTER (WHERE s.recommendation_score = 'yes') / NULLIF(COUNT(s.id), 0), 1) AS recommendation_rate,
          ROUND(100.0 * COUNT(s.id) / NULLIF(COUNT(r.id) FILTER (WHERE ${COMPLETED_STATUSES.replace(/status/g,'r.status').replace(/source/g, 'r.source')}), 0), 1) AS survey_participation
        FROM print_requests r
        LEFT JOIN request_satisfaction_surveys s ON s.request_id = r.id
        WHERE COALESCE(r.source, 'application') <> 'monday'
          ${aliasFilter.sql}
      `, aliasFilter.params),
    ]);

    logInvalidPlannedDurations('Management - Capacity Overview', capacityOverview.rows);

    res.json({
      demandTrend:      demandTrend.rows,
      topCategories:    topCategories.rows,
      serviceLevel:     serviceLevel.rows[0],
      bottlenecks:      bottlenecks.rows,
      productionReviewPerf: productionReviewPerf.rows[0],
      costBySite:       costBySite.rows,
      costByDepartment: costByDepartment.rows,
      costByCategory:   costByCategory.rows,
      capacityOverview: capacityOverview.rows[0],
      forecast:         forecast.rows[0],
      satisfaction:     managementSatisfaction.rows[0],
    });
  } catch (err) {
    console.error('[Dashboard] Management error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Notifications ─────────────────────────────────────────────────────────────
exports.getResourceDashboard = async (req, res) => {
  try {
    const printerCapacityHours = parseFloat(process.env.RESOURCE_PRINTER_MONTHLY_HOURS || '160');
    const technicianCapacityHours = parseFloat(process.env.RESOURCE_TECHNICIAN_MONTHLY_HOURS || '160');
    const activeStatuses = [
      'planned','assigned','in_progress','printed','post_processing','quality_check',
      'ready_for_pickup','blocked','on_hold','waiting_for_material',
      'waiting_for_machine','waiting_for_input','rework_required',
    ];
    const requestFilter = buildDashboardFilters(req.query, 'r');
    const resourceFilter = buildDashboardFilters(req.query, 'r', 3);
    const materialFilter = buildMaterialFilters(req.query, requestFilter.nextIndex, 'm');
    const resourcePrinterEntityFilter = buildEntityFilters(req.query, { printer_id: 'p.id', site_id: 'p.site_id' }, resourceFilter.nextIndex);
    const resourceTechnicianEntityFilter = buildEntityFilters(req.query, { technician_id: 'u.id' }, resourceFilter.nextIndex);

    const [
      printerUtilization,
      technicianUtilization,
      materialConsumption,
      materialTrend,
      stockRisk,
      forecast,
    ] = await Promise.all([
      db.query(`
        WITH cycle_hours AS (
          SELECT r.printer_id,
                 COALESCE(SUM(${completedCycleHoursSql('r', 'pc')}), 0) AS print_hours,
                 COUNT(*) FILTER (WHERE ${invalidPlannedDurationSql('r')}) AS invalid_planned_duration_count
          FROM print_requests r
          JOIN request_production_cycles pc ON pc.request_id = r.id
          WHERE COALESCE(r.source, 'application') <> 'monday'
            AND ${historicalCompletedStatusesFor('r')}
            AND pc.end_time > NOW() - INTERVAL '30 days'
            ${resourceFilter.sql}
          GROUP BY r.printer_id
        ),
        active_jobs AS (
          SELECT r.printer_id, COUNT(*) AS active_jobs
          FROM print_requests r
          WHERE COALESCE(r.source, 'application') <> 'monday'
            AND r.status = ANY($1)
            ${resourceFilter.sql}
          GROUP BY r.printer_id
        )
        SELECT p.id, p.name AS printer,
               COALESCE(ch.print_hours, 0) AS print_hours,
               COALESCE(aj.active_jobs, 0) AS active_jobs,
               ${utilizationSql('COALESCE(ch.print_hours, 0)', '$2::NUMERIC')} AS utilization,
               COALESCE(ch.invalid_planned_duration_count, 0) AS invalid_planned_duration_count
        FROM printers p
        LEFT JOIN cycle_hours ch ON ch.printer_id = p.id
        LEFT JOIN active_jobs aj ON aj.printer_id = p.id
        WHERE p.is_active = true
          ${resourcePrinterEntityFilter.sql}
        ORDER BY utilization DESC, active_jobs DESC, p.name
      `, [activeStatuses, printerCapacityHours, ...resourceFilter.params, ...resourcePrinterEntityFilter.params]),

      db.query(`
        WITH cycle_hours AS (
          SELECT r.assigned_technician_id,
                 COALESCE(SUM(${completedCycleHoursSql('r', 'pc')}), 0) AS print_hours,
                 COUNT(*) FILTER (WHERE ${invalidPlannedDurationSql('r')}) AS invalid_planned_duration_count
          FROM print_requests r
          JOIN request_production_cycles pc ON pc.request_id = r.id
          WHERE COALESCE(r.source, 'application') <> 'monday'
            AND ${historicalCompletedStatusesFor('r')}
            AND pc.end_time > NOW() - INTERVAL '30 days'
            ${resourceFilter.sql}
          GROUP BY r.assigned_technician_id
        ),
        assigned AS (
          SELECT r.assigned_technician_id, COUNT(*) AS assigned_requests
          FROM print_requests r
          WHERE COALESCE(r.source, 'application') <> 'monday'
            AND r.status = ANY($1)
            ${resourceFilter.sql}
          GROUP BY r.assigned_technician_id
        )
        SELECT u.id,
               u.first_name || ' ' || u.last_name AS technician,
               COALESCE(a.assigned_requests, 0) AS assigned_requests,
               COALESCE(ch.print_hours, 0) AS print_hours,
               ${utilizationSql('COALESCE(ch.print_hours, 0)', '$2::NUMERIC')} AS utilization,
               COALESCE(ch.invalid_planned_duration_count, 0) AS invalid_planned_duration_count
        FROM users u
        LEFT JOIN cycle_hours ch ON ch.assigned_technician_id = u.id
        LEFT JOIN assigned a ON a.assigned_technician_id = u.id
        WHERE u.role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)}) AND u.is_active = true
          ${resourceTechnicianEntityFilter.sql}
        ORDER BY utilization DESC, assigned_requests DESC, technician
      `, [activeStatuses, technicianCapacityHours, ...resourceFilter.params, ...resourceTechnicianEntityFilter.params]),

      db.query(`
        SELECT COALESCE(m.name, 'Unassigned') AS material,
               COALESCE(m.type, 'Unknown') AS material_type,
               COALESCE(SUM(r.material_used_grams), 0) AS consumed
        FROM print_requests r
        LEFT JOIN materials m ON r.material_id = m.id
        WHERE COALESCE(r.source, 'application') <> 'monday'
          AND COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.created_at) > NOW() - INTERVAL '30 days'
          AND COALESCE(r.material_used_grams, 0) > 0
          ${requestFilter.sql}
        GROUP BY COALESCE(m.name, 'Unassigned'), COALESCE(m.type, 'Unknown')
        ORDER BY consumed DESC
        LIMIT 12
      `, requestFilter.params),

      db.query(`
        SELECT DATE_TRUNC('month', COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.created_at))::DATE AS month,
               COALESCE(SUM(r.material_used_grams), 0) AS consumed
        FROM print_requests r
        WHERE ${completedStatusesFor('r')}
          AND COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.created_at) >= DATE_TRUNC('month', NOW()) - INTERVAL '5 months'
          ${requestFilter.sql}
        GROUP BY DATE_TRUNC('month', COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.created_at))
        ORDER BY month
      `, requestFilter.params),

      db.query(`
        WITH consumption AS (
          SELECT material_id,
                 COALESCE(SUM(material_used_grams), 0) / 90.0 AS avg_daily_consumption
          FROM print_requests r
          WHERE COALESCE(r.source, 'application') <> 'monday'
            AND COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.created_at) > NOW() - INTERVAL '90 days'
            ${requestFilter.sql}
          GROUP BY r.material_id
        )
        SELECT m.id, m.name AS material, m.type AS material_type, m.unit,
               COALESCE(m.stock_quantity, 0) AS stock_quantity,
               COALESCE(m.reserved_quantity, 0) AS reserved_quantity,
               COALESCE(m.available_quantity, m.stock_quantity, 0) AS remaining_quantity,
               COALESCE(m.low_stock_threshold, 200) AS low_stock_threshold,
               COALESCE(c.avg_daily_consumption, 0) AS avg_daily_consumption,
               CASE
                 WHEN COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200) THEN 'red'
                 WHEN COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200) * 1.25 THEN 'orange'
                 ELSE 'green'
               END AS risk_level,
               CASE
                 WHEN COALESCE(c.avg_daily_consumption, 0) > 0
                 THEN ROUND((COALESCE(m.available_quantity, m.stock_quantity, 0)::NUMERIC / c.avg_daily_consumption)::NUMERIC, 1)
                 ELSE NULL
               END AS days_of_coverage
        FROM materials m
        LEFT JOIN consumption c ON c.material_id = m.id
        WHERE m.is_active = true
          AND COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200) * 1.25
          ${materialFilter.sql}
        ORDER BY risk_level DESC, remaining_quantity ASC, days_of_coverage ASC NULLS LAST, m.name
      `, [...requestFilter.params, ...materialFilter.params]),

      db.query(`
        WITH monthly_demand AS (
          SELECT DATE_TRUNC('month', r.created_at)::DATE AS month,
                 COUNT(*) AS requests,
                 COALESCE(SUM(
                   CASE
                     WHEN r.planned_start_date IS NOT NULL
                      AND r.planned_end_date IS NOT NULL
                      AND r.planned_end_date > r.planned_start_date
                     THEN EXTRACT(EPOCH FROM (r.planned_end_date - r.planned_start_date)) / 3600.0
                     ELSE 0
                   END
                 ), 0) AS forecast_hours
          FROM print_requests r
          WHERE ${nonImportedFor('r')}
            AND r.status NOT IN ('cancelled','rejected')
            AND r.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '6 months'
            ${requestFilter.sql}
          GROUP BY DATE_TRUNC('month', r.created_at)
        )
        SELECT ROUND(COALESCE(AVG(requests), 0)::NUMERIC, 0) AS forecast_requests,
               ROUND(COALESCE(AVG(forecast_hours), 0)::NUMERIC, 1) AS forecast_resource_demand
        FROM monthly_demand
      `, requestFilter.params),
    ]);

    const printerRows = printerUtilization.rows;
    const technicianRows = technicianUtilization.rows;
    logInvalidPlannedDurations('Resource - Printer Utilization', printerRows);
    logInvalidPlannedDurations('Resource - Technician Utilization', technicianRows);
    const forecastRow = forecast.rows[0] || {};
    const lowStockCount = stockRisk.rows.filter(row => row.risk_level === 'red').length;
    const usedPrinterHours = printerRows.reduce((sum, row) => sum + parseFloat(row.print_hours || 0), 0);
    const usedTechnicianHours = technicianRows.reduce((sum, row) => sum + parseFloat(row.print_hours || 0), 0);
    const totalPrinterCapacity = printerRows.length * printerCapacityHours;
    const totalTechnicianCapacity = technicianRows.length * technicianCapacityHours;

    res.json({
      summary: {
        printerUtilization: totalPrinterCapacity > 0 ? Math.round((usedPrinterHours / totalPrinterCapacity) * 1000) / 10 : 0,
        technicianUtilization: totalTechnicianCapacity > 0 ? Math.round((usedTechnicianHours / totalTechnicianCapacity) * 1000) / 10 : 0,
        lowStockMaterials: lowStockCount,
        forecastRequests: parseInt(forecastRow.forecast_requests || 0, 10),
      },
      printerUtilization: printerRows,
      technicianUtilization: technicianRows,
      materialConsumption: {
        byMaterial: materialConsumption.rows,
        trend: materialTrend.rows,
      },
      stockRisk: stockRisk.rows,
      capacityForecast: {
        forecastRequests: parseInt(forecastRow.forecast_requests || 0, 10),
        forecastResourceDemand: parseFloat(forecastRow.forecast_resource_demand || 0),
        availablePrinterCapacity: Math.max(0, Math.round((totalPrinterCapacity - usedPrinterHours) * 10) / 10),
        availableTechnicianCapacity: Math.max(0, Math.round((totalTechnicianCapacity - usedTechnicianHours) * 10) / 10),
      },
    });
  } catch (err) {
    console.error('[Dashboard] Resource error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getNotifications = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT n.*, r.request_number, r.title AS request_title
      FROM notifications n
      LEFT JOIN print_requests r ON n.request_id = r.id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT 100
    `, [req.user.id]);
    const unreadCount = result.rows.filter(n => !n.is_read).length;
    res.json({ notifications: result.rows, unreadCount });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.markNotificationsRead = async (req, res) => {
  try {
    await db.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.user.id]);
    res.json({ message: 'OK' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getNotificationHistory = async (req, res) => {
  try {
    await ensureNotificationHistoryTable(db);

    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const result = await db.query(`
      SELECT nh.*,
             r.request_number,
             r.title AS request_title,
             u.first_name || ' ' || u.last_name AS recipient_name
      FROM notification_history nh
      LEFT JOIN print_requests r ON nh.request_id = r.id
      LEFT JOIN users u ON nh.recipient_user_id = u.id
      ORDER BY nh.created_at DESC
      LIMIT $1
    `, [limit]);

    res.json({
      emailConfig: getEmailConfigStatus(),
      history: result.rows,
    });
  } catch (err) {
    console.error('[NotificationHistory] Read failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.sendTestEmail = async (req, res) => {
  const recipient = String(req.body?.to || req.user.email || '').trim();
  const subject = '3D Print Manager Test Email';
  const text = `Hello,

This is a test email from 3D Print Manager.

If you received this message, SMTP email delivery is working.

Sent by: ${req.user.email || req.user.id}
Date: ${new Date().toISOString()}`;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    await recordNotificationHistory(db, {
      recipientUserId: req.user.id,
      recipientEmail: recipient || null,
      type: 'test_email',
      subject,
      status: 'skipped',
      reason: 'missing_or_invalid_recipient_email',
      metadata: { actorId: req.user.id },
    });
    return res.status(400).json({
      error: 'A valid recipient email is required.',
      emailConfig: getEmailConfigStatus(),
    });
  }

  try {
    const result = await sendMail({
      to: recipient,
      subject,
      text,
      html: text.split('\n').map((line) => (line.trim() ? line : '<br/>')).join('<br/>'),
    });

    const status = result?.skipped ? 'skipped' : 'success';
    await recordNotificationHistory(db, {
      recipientUserId: req.user.id,
      recipientEmail: recipient,
      type: 'test_email',
      subject,
      status,
      reason: result?.reason || null,
      providerMessageId: result?.messageId || null,
      metadata: {
        actorId: req.user.id,
        accepted: result?.accepted || [],
        rejected: result?.rejected || [],
      },
    });

    res.json({
      status,
      reason: result?.reason || null,
      messageId: result?.messageId || null,
      emailConfig: getEmailConfigStatus(),
    });
  } catch (err) {
    console.error('[Email Notification Failed]', {
      type: 'test_email',
      recipient,
      reason: err.message,
    });

    await recordNotificationHistory(db, {
      recipientUserId: req.user.id,
      recipientEmail: recipient,
      type: 'test_email',
      subject,
      status: 'failed',
      reason: err.message,
      metadata: { actorId: req.user.id },
    });

    res.status(500).json({
      error: 'Email test failed.',
      reason: err.message,
      emailConfig: getEmailConfigStatus(),
    });
  }
};

// ── Export (legacy endpoint) ──────────────────────────────────────────────────
exports.exportRequests = async (req, res) => {
  try {
    const { type = 'all' } = req.query;
    let where = `WHERE ${NON_IMPORTED}`;
    if (type === 'open')      where = `WHERE ${OPEN_STATUSES}`;
    if (type === 'completed') where = `WHERE ${COMPLETED_STATUSES}`;
    if (type === 'overdue')   where = `WHERE ${OPEN_STATUSES} AND ${OVERDUE_CONDITION}`;

    const result = await db.query(`
      SELECT r.request_number, r.title, r.status, r.priority,
        r.requester_name, r.requester_department,
        r.requested_due_date, r.approved_due_date,
        u.first_name || ' ' || u.last_name AS technician,
        p.name AS printer, m.name AS material,
        r.actual_start_time, r.actual_end_time, r.quality_result,
        r.scrap_count, r.rework_required, r.completion_date, r.created_at
      FROM print_requests r
      LEFT JOIN users u ON r.assigned_technician_id = u.id
      LEFT JOIN printers p ON r.printer_id = p.id
      LEFT JOIN materials m ON r.material_id = m.id
      ${where}
      ORDER BY r.created_at DESC
    `);
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
