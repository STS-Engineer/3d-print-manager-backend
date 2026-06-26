const db = require('../config/database');
const { PRODUCTION_TECHNICIAN_ALIASES, roleSqlList } = require('../utils/roles');
const { createAuditLog } = require('../middleware/auditLog');
const {
  getCostSummary,
  getCostComponentBreakdown,
} = require('../services/costDashboardService');

let ExcelJS;
try { ExcelJS = require('exceljs'); } catch (_) { ExcelJS = null; }

const COMPLETED = "'completed','requester_confirmation','waiting_customer_confirmation','archived'";
const TERMINAL = `${COMPLETED},'cancelled','rejected'`;
const ACTIVE = `status NOT IN (${TERMINAL})`;

const n = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
};

const getUserName = (u = {}) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'System';

const buildFilters = (query = {}, alias = 'r', start = 1, dateExpr = `COALESCE(${alias}.completion_date, ${alias}.actual_end_time, ${alias}.created_at)`) => {
  const conditions = [`COALESCE(${alias}.source, 'application') <> 'monday'`];
  const params = [];
  let idx = start;
  const add = (field, col) => {
    if (query[field]) {
      conditions.push(`${alias}.${col} = $${idx++}`);
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
    conditions.push(`${alias}.requester_name ILIKE $${idx++}`);
    params.push(`%${query.requester}%`);
  }
  if (query.department) {
    conditions.push(`${alias}.requester_department ILIKE $${idx++}`);
    params.push(`%${query.department}%`);
  }
  if (query.production_status) {
    const groups = {
      planned: ['planned'],
      active: ['assigned', 'in_progress', 'printed', 'post_processing', 'quality_check', 'rework_required'],
      blocked: ['blocked', 'on_hold', 'waiting_for_material', 'waiting_for_machine', 'waiting_for_input'],
      completed: ['ready_for_pickup', 'requester_confirmation', 'completed', 'archived'],
    };
    if (groups[query.production_status]) {
      conditions.push(`${alias}.status = ANY($${idx++})`);
      params.push(groups[query.production_status]);
    }
  }
  if (query.approval_status) {
    const groups = {
      pending: ['submitted', 'completeness_check', 'feasibility_review'],
      approved: ['approved', 'prioritized', 'planned', 'assigned', 'in_progress', 'printed', 'post_processing', 'quality_check', 'ready_for_pickup', 'requester_confirmation', 'completed', 'archived'],
      rejected: ['rejected'],
    };
    if (groups[query.approval_status]) {
      conditions.push(`${alias}.status = ANY($${idx++})`);
      params.push(groups[query.approval_status]);
    }
  }
  if (query.delivery_status) {
    const completedAt = `COALESCE(${alias}.completion_date, ${alias}.ready_at, ${alias}.actual_end_time)`;
    const dueDate = `COALESCE(${alias}.approved_due_date, ${alias}.requested_due_date)`;
    if (query.delivery_status === 'overdue') {
      conditions.push(`${alias}.status NOT IN (${TERMINAL}) AND ${dueDate} IS NOT NULL AND ${dueDate}::date < CURRENT_DATE`);
    } else if (query.delivery_status === 'awaiting_confirmation') {
      conditions.push(`${alias}.status IN ('ready_for_pickup','requester_confirmation','waiting_customer_confirmation')`);
    } else if (query.delivery_status === 'completed') {
      conditions.push(`${alias}.status IN (${COMPLETED})`);
    } else if (query.delivery_status === 'on_time') {
      conditions.push(`${alias}.status IN (${COMPLETED}) AND ${completedAt} IS NOT NULL AND ${dueDate} IS NOT NULL AND ${completedAt} <= ${dueDate}`);
    } else if (query.delivery_status === 'late') {
      conditions.push(`${alias}.status IN (${COMPLETED}) AND ${completedAt} IS NOT NULL AND ${dueDate} IS NOT NULL AND ${completedAt} > ${dueDate}`);
    }
  }
  if (query.date_from) {
    conditions.push(`${dateExpr}::date >= $${idx++}::date`);
    params.push(query.date_from);
  }
  if (query.date_to) {
    conditions.push(`${dateExpr}::date <= $${idx++}::date`);
    params.push(query.date_to);
  }
  return { where: `WHERE ${conditions.join(' AND ')}`, and: `AND ${conditions.join(' AND ')}`, params };
};

const risk = (severity, affectedArea, recommendedAction, metric = null) => ({
  severity,
  affectedArea,
  recommendedAction,
  metric,
});

const auditExecutive = async (req, action, details) => createAuditLog({
  entityType: 'executive_dashboard',
  entityId: req.user?.id || null,
  action,
  performedBy: req.user?.id || null,
  performedByName: getUserName(req.user),
  newValues: details || {},
  ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
});

const getExecutiveData = async (query = {}) => {
  const filters = buildFilters(query);
  const costFilters = {
    site_id: query.site_id,
    material_id: query.material_id,
    printer_id: query.printer_id,
    technician_id: query.technician_id,
    priority: query.priority,
    status: query.status,
    category_id: query.category_id,
    requester_id: query.requester_id,
    requester: query.requester,
    criticality: query.criticality,
    production_status: query.production_status,
    approval_status: query.approval_status,
    delivery_status: query.delivery_status,
    department: query.department,
    date_from: query.date_from,
    date_to: query.date_to,
  };

  const [
    production,
    delivery,
    capacity,
    inventory,
    quality,
    trends,
    forecast,
    topLists,
    costSummary,
    costComponents,
  ] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*) AS total_requests,
        COUNT(*) FILTER (WHERE status IN (${COMPLETED})) AS completed_requests,
        COUNT(*) FILTER (WHERE ${ACTIVE}) AS active_requests,
        COUNT(*) FILTER (
          WHERE ${ACTIVE}
          AND ((requested_due_date IS NOT NULL AND requested_due_date < CURRENT_DATE)
            OR (approved_due_date IS NOT NULL AND approved_due_date < CURRENT_DATE))
        ) AS overdue_requests,
        COUNT(*) FILTER (WHERE status = 'rejected') AS rejected_requests,
        COUNT(*) FILTER (WHERE status = 'blocked') AS blocked_requests
      FROM print_requests r
      ${filters.where}
    `, filters.params),

    db.query(`
      SELECT
        ROUND(100.0 * COUNT(*) FILTER (
          WHERE status IN (${COMPLETED})
            AND COALESCE(completion_date, ready_at, actual_end_time) <= COALESCE(approved_due_date, requested_due_date)
        ) / NULLIF(COUNT(*) FILTER (WHERE status IN (${COMPLETED})), 0), 1) AS on_time_delivery_rate,
        ROUND((AVG(EXTRACT(EPOCH FROM (COALESCE(completion_date, ready_at, actual_end_time) - submitted_at)) / 3600)
          FILTER (WHERE status IN (${COMPLETED}) AND submitted_at IS NOT NULL))::NUMERIC, 1) AS average_lead_time,
        ROUND(AVG(COALESCE(actual_duration,
          CASE WHEN actual_start_time IS NOT NULL AND actual_end_time IS NOT NULL
            THEN EXTRACT(EPOCH FROM (actual_end_time - actual_start_time)) / 3600 END
        ))::NUMERIC, 1) AS average_production_time,
        ROUND((AVG(EXTRACT(EPOCH FROM (approved_at - submitted_at)) / 3600)
          FILTER (WHERE approved_at IS NOT NULL AND submitted_at IS NOT NULL))::NUMERIC, 1) AS average_approval_time,
        ROUND((AVG(EXTRACT(EPOCH FROM (reception_confirmed_at - ready_at)) / 3600)
          FILTER (WHERE reception_confirmed_at IS NOT NULL AND ready_at IS NOT NULL))::NUMERIC, 1) AS average_customer_confirmation_time
      FROM print_requests r
      ${filters.where}
    `, filters.params),

    db.query(`
      WITH printers AS (
        SELECT COUNT(*) AS total_printers FROM printers WHERE is_active = true
      ),
      technicians AS (
        SELECT COUNT(*) AS total_technicians FROM users WHERE role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)}) AND is_active = true
      ),
      active_printers AS (
        SELECT COUNT(DISTINCT printer_id) AS active_printers
        FROM print_requests r
        ${filters.where}
          AND status IN ('planned','assigned','in_progress','printed','quality_check','rework_required')
      ),
      active_technicians AS (
        SELECT COUNT(DISTINCT assigned_technician_id) AS active_technicians
        FROM print_requests r
        ${filters.where}
          AND status IN ('planned','assigned','in_progress','printed','quality_check','rework_required')
      ),
      reserved AS (
        SELECT COALESCE(SUM(material_reserved_qty), 0) AS reserved_capacity
        FROM print_requests r
        ${filters.where}
          AND status IN ('planned','assigned','in_progress')
      ),
      forecast AS (
        SELECT COALESCE(AVG(monthly_count), 0) AS forecast_capacity
        FROM (
          SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS monthly_count
          FROM print_requests r
          ${filters.where}
            AND created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '6 months'
          GROUP BY DATE_TRUNC('month', created_at)
        ) m
      )
      SELECT
        CASE WHEN p.total_printers > 0 THEN ROUND((ap.active_printers::NUMERIC / p.total_printers) * 100, 1) ELSE 0 END AS printer_utilization,
        CASE WHEN t.total_technicians > 0 THEN ROUND((at.active_technicians::NUMERIC / t.total_technicians) * 100, 1) ELSE 0 END AS technician_utilization,
        GREATEST(0, 100 - GREATEST(
          CASE WHEN p.total_printers > 0 THEN (ap.active_printers::NUMERIC / p.total_printers) * 100 ELSE 0 END,
          CASE WHEN t.total_technicians > 0 THEN (at.active_technicians::NUMERIC / t.total_technicians) * 100 ELSE 0 END
        )) AS available_capacity,
        reserved.reserved_capacity,
        forecast.forecast_capacity
      FROM printers p, technicians t, active_printers ap, active_technicians at, reserved, forecast
    `, filters.params),

    db.query(`
      WITH coverage AS (
        SELECT
          m.id,
          m.name,
          COALESCE(m.available_quantity, m.stock_quantity, 0) AS available_quantity,
          COALESCE(SUM(mt.quantity) FILTER (
            WHERE mt.transaction_type = 'consumption'
              AND mt.created_at > NOW() - INTERVAL '90 days'
          ), 0) / 90.0 AS avg_daily_consumption
        FROM materials m
        LEFT JOIN material_transactions mt ON mt.material_id = m.id
        WHERE m.is_active = true
        GROUP BY m.id, m.name, m.available_quantity, m.stock_quantity
      ),
      top_consumed AS (
        SELECT m.name, COALESCE(SUM(mt.quantity), 0) AS consumed
        FROM material_transactions mt
        JOIN materials m ON mt.material_id = m.id
        WHERE mt.transaction_type = 'consumption'
          AND mt.created_at > NOW() - INTERVAL '90 days'
        GROUP BY m.id, m.name
        ORDER BY consumed DESC
        LIMIT 1
      )
      SELECT
        (SELECT COUNT(*) FROM materials WHERE is_active = true) AS total_materials,
        (SELECT COUNT(*) FROM materials WHERE is_active = true AND COALESCE(available_quantity, stock_quantity, 0) <= COALESCE(low_stock_threshold, 200)) AS low_stock_materials,
        0 AS inventory_value,
        ROUND(AVG(CASE WHEN avg_daily_consumption > 0 THEN available_quantity / avg_daily_consumption ELSE NULL END)::NUMERIC, 1) AS average_days_of_coverage,
        (SELECT name FROM top_consumed) AS top_consumed_material
      FROM coverage
    `),

    db.query(`
      SELECT
        ROUND(100.0 * COUNT(*) FILTER (WHERE quality_result = 'pass') / NULLIF(COUNT(*) FILTER (WHERE quality_result IS NOT NULL), 0), 1) AS pass_rate,
        ROUND(100.0 * COUNT(*) FILTER (WHERE quality_result = 'pass') / NULLIF(COUNT(*) FILTER (WHERE status IN ('quality_check','requester_confirmation','completed','archived') OR quality_result IS NOT NULL), 0), 1) AS quality_check_success_rate,
        ROUND(100.0 * COUNT(*) FILTER (WHERE rework_required = true) / NULLIF(COUNT(*), 0), 1) AS rework_rate,
        ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'rejected') / NULLIF(COUNT(*), 0), 1) AS rejected_rate,
        ROUND(100.0 * COUNT(*) FILTER (WHERE requester_confirmation = true OR reception_confirmed_at IS NOT NULL) / NULLIF(COUNT(*) FILTER (WHERE status IN (${COMPLETED})), 0), 1) AS customer_confirmation_rate
      FROM print_requests r
      ${filters.where}
    `, filters.params),

    getTrends(query),
    getForecast(query),
    getTopLists(query),
    getCostSummary(costFilters),
    getCostComponentBreakdown(costFilters),
  ]);

  const financial = {
    actualProductionCost: costSummary.actualCostTotal,
    averageCostPerRequest: costSummary.averageCostPerRequest,
    materialConsumptionCost: costComponents.materialCost,
    laborCost: 0,
    machineCost: costComponents.printTimeCost,
  };

  const executiveRisks = buildRisks({
    production: production.rows[0],
    delivery: delivery.rows[0],
    capacity: capacity.rows[0],
    inventory: inventory.rows[0],
    quality: quality.rows[0],
    financial,
    forecast,
  });

  return {
    productionOverview: production.rows[0],
    financialOverview: financial,
    deliveryPerformance: delivery.rows[0],
    capacityOverview: capacity.rows[0],
    inventoryOverview: inventory.rows[0],
    qualityOverview: quality.rows[0],
    trends,
    forecasting: forecast,
    executiveRisks,
    topLists,
    generatedAt: new Date().toISOString(),
  };
};

const getPeriodBucket = (period) => {
  if (period === '30d') return { interval: "30 days", trunc: 'day' };
  if (period === '12m') return { interval: "12 months", trunc: 'month' };
  return { interval: "90 days", trunc: 'week' };
};

const getTrends = async (query = {}) => {
  const periods = ['30d', '90d', '12m'];
  const output = {};
  for (const period of periods) {
    const p = getPeriodBucket(period);
    const filters = buildFilters(query, 'r', 1, 'r.created_at');
    const [requests, costs, inventory, capacity] = await Promise.all([
      db.query(`
        SELECT DATE_TRUNC('${p.trunc}', r.created_at)::DATE AS bucket,
               COUNT(*) AS requests_created,
               COUNT(*) FILTER (WHERE r.status IN (${COMPLETED})) AS requests_completed,
               COUNT(*) FILTER (WHERE r.status = 'rejected') AS requests_rejected
        FROM print_requests r
        ${filters.where}
          AND r.created_at >= NOW() - INTERVAL '${p.interval}'
        GROUP BY DATE_TRUNC('${p.trunc}', r.created_at)
        ORDER BY bucket
      `, filters.params),
      db.query(`
        SELECT DATE_TRUNC('${p.trunc}', COALESCE(r.completion_date, r.actual_end_time, r.created_at))::DATE AS bucket,
               COALESCE(SUM(r.actual_cost), 0) AS actual_cost,
               COALESCE(SUM(COALESCE(r.production_total_material_usage, 0) * COALESCE(m.cost_per_unit, r.price_per_kg / 1000.0, 0)), 0) AS material_cost,
               0 AS labor_cost,
               COALESCE(SUM(COALESCE(r.production_total_print_time_minutes, 0) * COALESCE(p.cost_per_minute, 0)), 0) AS machine_cost
        FROM print_requests r
        LEFT JOIN materials m ON r.material_id = m.id
        LEFT JOIN printers p ON r.printer_id = p.id
        ${filters.where}
          AND COALESCE(r.completion_date, r.actual_end_time, r.created_at) >= NOW() - INTERVAL '${p.interval}'
        GROUP BY DATE_TRUNC('${p.trunc}', COALESCE(r.completion_date, r.actual_end_time, r.created_at))
        ORDER BY bucket
      `, filters.params),
      db.query(`
        SELECT DATE_TRUNC('${p.trunc}', mt.created_at)::DATE AS bucket,
               COALESCE(SUM(mt.quantity) FILTER (WHERE mt.transaction_type = 'consumption'), 0) AS material_consumption,
               0 AS inventory_value,
               COUNT(*) FILTER (WHERE mt.transaction_type = 'consumption') AS low_stock_events
        FROM material_transactions mt
        LEFT JOIN print_requests r ON mt.request_id = r.id
        ${filters.where}
          AND mt.created_at >= NOW() - INTERVAL '${p.interval}'
        GROUP BY DATE_TRUNC('${p.trunc}', mt.created_at)
        ORDER BY bucket
      `, filters.params),
      db.query(`
        SELECT DATE_TRUNC('${p.trunc}', r.created_at)::DATE AS bucket,
               COUNT(DISTINCT r.printer_id) AS printer_utilization,
               COUNT(DISTINCT r.assigned_technician_id) AS technician_utilization,
               COUNT(*) AS forecast_demand,
               GREATEST(0, 100 - COUNT(*)::NUMERIC) AS forecast_capacity
        FROM print_requests r
        ${filters.where}
          AND r.created_at >= NOW() - INTERVAL '${p.interval}'
        GROUP BY DATE_TRUNC('${p.trunc}', r.created_at)
        ORDER BY bucket
      `, filters.params),
    ]);
    output[period] = {
      requestVolumeTrend: requests.rows,
      costTrend: costs.rows,
      inventoryTrend: inventory.rows,
      capacityTrend: capacity.rows,
    };
  }
  return output;
};

const getForecast = async (query = {}) => {
  const filters = buildFilters(query);
  const result = await db.query(`
    WITH monthly AS (
      SELECT
        DATE_TRUNC('month', r.created_at)::DATE AS month,
        COUNT(*) AS requests,
        COUNT(*) FILTER (WHERE r.status IN (${COMPLETED})) AS completions,
        COALESCE(SUM(
          COALESCE(
            r.actual_duration,
            CASE
              WHEN r.planned_start_date IS NOT NULL
               AND r.planned_end_date IS NOT NULL
               AND r.planned_end_date > r.planned_start_date
              THEN EXTRACT(EPOCH FROM (r.planned_end_date - r.planned_start_date)) / 3600.0
            END,
            0
          )
        ), 0) AS workload,
        COALESCE(SUM(COALESCE(r.material_used_grams, r.material_reserved_qty, 0)), 0) AS material_consumption
      FROM print_requests r
      ${filters.where}
        AND r.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', r.created_at)
    )
    SELECT
      COALESCE(AVG(requests), 0) AS avg_monthly_requests,
      COALESCE(AVG(completions), 0) AS avg_monthly_completions,
      COALESCE(AVG(workload), 0) AS avg_monthly_workload,
      COALESCE(AVG(material_consumption), 0) AS avg_monthly_material_consumption
    FROM monthly
  `, filters.params);
  const avg = result.rows[0] || {};
  const monthlyRequests = n(avg.avg_monthly_requests);
  const monthlyCompletions = n(avg.avg_monthly_completions);
  const monthlyWorkload = n(avg.avg_monthly_workload);
  const monthlyMaterial = n(avg.avg_monthly_material_consumption);

  const shortages = await db.query(`
    WITH usage AS (
      SELECT material_id, COALESCE(SUM(quantity), 0) / 90.0 AS avg_daily_usage
      FROM material_transactions
      WHERE transaction_type = 'consumption'
        AND created_at > NOW() - INTERVAL '90 days'
      GROUP BY material_id
    )
    SELECT m.id, m.name AS material, m.unit,
           COALESCE(m.available_quantity, m.stock_quantity, 0) AS available_quantity,
           COALESCE(u.avg_daily_usage, 0) AS avg_daily_usage,
           CASE WHEN COALESCE(u.avg_daily_usage, 0) > 0
             THEN ROUND((COALESCE(m.available_quantity, m.stock_quantity, 0)::NUMERIC / u.avg_daily_usage)::NUMERIC, 1)
             ELSE NULL END AS days_until_stockout
    FROM materials m
    LEFT JOIN usage u ON u.material_id = m.id
    WHERE m.is_active = true
      AND (
        COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200)
        OR (COALESCE(u.avg_daily_usage, 0) > 0 AND COALESCE(m.available_quantity, m.stock_quantity, 0) / u.avg_daily_usage <= 30)
      )
    ORDER BY days_until_stockout ASC NULLS LAST, available_quantity ASC
    LIMIT 10
  `);

  const utilizationRisk = monthlyWorkload > 140 ? 'High' : monthlyWorkload > 90 ? 'Medium' : 'Low';
  return {
    requestForecast: {
      next30Days: {
        expectedRequests: Math.round(monthlyRequests),
        expectedCompletions: Math.round(monthlyCompletions),
        expectedWorkload: monthlyWorkload,
      },
      next90Days: {
        expectedRequests: Math.round(monthlyRequests * 3),
        expectedCompletions: Math.round(monthlyCompletions * 3),
        expectedWorkload: n(monthlyWorkload * 3),
      },
      next12Months: {
        expectedRequests: Math.round(monthlyRequests * 12),
        expectedCompletions: Math.round(monthlyCompletions * 12),
        expectedWorkload: n(monthlyWorkload * 12),
      },
    },
    capacityForecast: {
      projectedPrinterCapacity: n(Math.max(0, 160 - monthlyWorkload)),
      projectedTechnicianCapacity: n(Math.max(0, 160 - monthlyWorkload)),
      projectedMaterialConsumption: monthlyMaterial,
      capacityRiskLevel: utilizationRisk,
    },
    inventoryForecast: {
      expectedMaterialConsumption: monthlyMaterial,
      predictedShortages: shortages.rows.length,
      recommendedReorderMaterials: shortages.rows,
      daysUntilStockout: shortages.rows[0]?.days_until_stockout || null,
    },
  };
};

const getTopLists = async (query = {}) => {
  const filters = buildFilters(query);
  const [expensive, longest, consumed, printers, technicians] = await Promise.all([
    db.query(`
      SELECT id, request_number, title, COALESCE(actual_cost, 0) AS value
      FROM print_requests r
      ${filters.where}
      ORDER BY COALESCE(actual_cost, 0) DESC
      LIMIT 10
    `, filters.params),
    db.query(`
      SELECT id, request_number, title,
        COALESCE(actual_duration,
          CASE WHEN actual_start_time IS NOT NULL AND actual_end_time IS NOT NULL THEN EXTRACT(EPOCH FROM (actual_end_time - actual_start_time)) / 3600 END,
          CASE
            WHEN planned_start_date IS NOT NULL
             AND planned_end_date IS NOT NULL
             AND planned_end_date > planned_start_date
            THEN EXTRACT(EPOCH FROM (planned_end_date - planned_start_date)) / 3600.0
          END,
          0
        ) AS value
      FROM print_requests r
      ${filters.where}
      ORDER BY value DESC
      LIMIT 10
    `, filters.params),
    db.query(`
      SELECT m.id, m.name AS label, COALESCE(SUM(mt.quantity), 0) AS value, m.unit
      FROM material_transactions mt
      JOIN materials m ON mt.material_id = m.id
      LEFT JOIN print_requests r ON mt.request_id = r.id
      ${filters.where}
        AND mt.transaction_type = 'consumption'
      GROUP BY m.id, m.name, m.unit
      ORDER BY value DESC
      LIMIT 10
    `, filters.params),
    db.query(`
      SELECT p.id, p.name AS label, COUNT(r.id) AS value
      FROM printers p
      LEFT JOIN print_requests r ON r.printer_id = p.id
      ${filters.where}
        AND p.is_active = true
      GROUP BY p.id, p.name
      ORDER BY value DESC
      LIMIT 10
    `, filters.params),
    db.query(`
      SELECT u.id, u.first_name || ' ' || u.last_name AS label, COUNT(r.id) AS value
      FROM users u
      LEFT JOIN print_requests r ON r.assigned_technician_id = u.id
      ${filters.where}
        AND u.role IN (${roleSqlList(PRODUCTION_TECHNICIAN_ALIASES)}) AND u.is_active = true
      GROUP BY u.id, u.first_name, u.last_name
      ORDER BY value DESC
      LIMIT 10
    `, filters.params),
  ]);
  return {
    mostExpensiveRequests: expensive.rows,
    longestPrints: longest.rows,
    mostConsumedMaterials: consumed.rows,
    mostUtilizedPrinters: printers.rows,
    mostActiveTechnicians: technicians.rows,
  };
};

const buildRisks = ({ production = {}, delivery = {}, capacity = {}, inventory = {}, quality = {}, financial = {}, forecast = {} }) => {
  const risks = [];
  if (n(capacity.available_capacity) < 20 || forecast.capacityForecast.capacityRiskLevel === 'High') {
    risks.push(risk('High', 'Capacity', 'Review printer and technician allocation for the next planning cycle.', `${n(capacity.available_capacity)}% available`));
  }
  if (parseInt(inventory.low_stock_materials || 0, 10) > 0) {
    risks.push(risk('High', 'Inventory', 'Reorder low-stock materials and validate planned reservations.', `${inventory.low_stock_materials} low stock`));
  }
  if (parseInt(production.overdue_requests || 0, 10) > 0 || n(delivery.on_time_delivery_rate) < 85) {
    risks.push(risk('Medium', 'Delivery', 'Prioritize overdue work and review promised dates.', `${production.overdue_requests || 0} overdue`));
  }
  if (n(quality.rework_rate) > 10 || n(quality.pass_rate) < 90) {
    risks.push(risk('Medium', 'Quality', 'Review recurring defects and rework causes with production.', `${n(quality.rework_rate)}% rework`));
  }
  return risks.length ? risks : [risk('Low', 'Executive', 'No immediate strategic risks detected from current data.', 'Stable')];
};

exports.getExecutiveDashboard = async (req, res) => {
  try {
    res.json(await getExecutiveData(req.query));
  } catch (err) {
    console.error('[Executive] Dashboard error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

const flattenExecutive = (data) => {
  const rows = [];
  const addGroup = (group, obj = {}) => Object.entries(obj).forEach(([metric, value]) => {
    if (typeof value !== 'object' || value === null) rows.push({ Group: group, Metric: metric, Value: value ?? '' });
  });
  addGroup('Production Overview', data.productionOverview);
  addGroup('Financial Overview', data.financialOverview);
  addGroup('Delivery Performance', data.deliveryPerformance);
  addGroup('Capacity Overview', data.capacityOverview);
  addGroup('Inventory Overview', data.inventoryOverview);
  addGroup('Quality Overview', data.qualityOverview);
  data.executiveRisks.forEach((r, index) => rows.push({ Group: 'Executive Risks', Metric: `${index + 1}. ${r.affectedArea}`, Value: `${r.severity} - ${r.recommendedAction}` }));
  return rows;
};

const sendCSV = (res, rows, filename) => {
  const headers = Object.keys(rows[0] || { Group: '', Metric: '', Value: '' });
  const esc = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + [headers.join(','), ...rows.map(row => headers.map(h => esc(row[h])).join(','))].join('\n'));
};

const sendExcel = async (res, rows, filename, sheet = 'Executive KPIs') => {
  if (!ExcelJS) return sendCSV(res, rows, filename.replace('.xlsx', '.csv'));
  const wb = new ExcelJS.Workbook();
  wb.creator = '3D Print Manager';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = Object.keys(rows[0] || { Group: '', Metric: '', Value: '' });
  ws.columns = headers.map(h => ({ header: h, key: h, width: Math.max(16, h.length + 4) }));
  rows.forEach(row => ws.addRow(row));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
};

const pdfSafe = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
  .replace(/\\/g, '\\\\')
  .replace(/\(/g, '\\(')
  .replace(/\)/g, '\\)');

const sendSimplePdf = (res, rows, filename) => {
  const lines = [
    'Executive Report',
    `Generated ${new Date().toLocaleString('en-GB')}`,
    '',
    ...rows.map(row => `${row.Group} | ${row.Metric}: ${row.Value}`),
  ];
  const content = [
    'BT',
    '/F1 9 Tf',
    '45 760 Td',
    ...lines.slice(0, 42).map((line, index) => `${index ? '0 -16 Td' : ''}(${pdfSafe(line).slice(0, 115)}) Tj`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(chunks.join('')));
    chunks.push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xref = Buffer.byteLength(chunks.join(''));
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach(offset => chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(chunks.join(''), 'utf8'));
};

exports.exportExecutiveReport = async (req, res) => {
  try {
    const data = await getExecutiveData(req.query);
    const rows = flattenExecutive(data);
    const format = String(req.query.format || 'xlsx').toLowerCase();
    await auditExecutive(req, format === 'pdf' ? 'executive_report_generated' : 'executive_dashboard_exported', { format });
    if (format === 'pdf') return sendSimplePdf(res, rows, `executive-report-${new Date().toISOString().split('T')[0]}.pdf`);
    if (format === 'csv') return sendCSV(res, rows, `executive-report-${new Date().toISOString().split('T')[0]}.csv`);
    return sendExcel(res, rows, `executive-report-${new Date().toISOString().split('T')[0]}.xlsx`);
  } catch (err) {
    console.error('[Executive] Export error:', err.message);
    res.status(500).json({ error: 'Executive export failed' });
  }
};

exports.exportExecutiveKpis = async (req, res) => {
  try {
    const rows = flattenExecutive(await getExecutiveData(req.query));
    await auditExecutive(req, 'executive_dashboard_exported', { export: 'kpis' });
    return sendExcel(res, rows, `executive-kpis-${new Date().toISOString().split('T')[0]}.xlsx`);
  } catch (err) {
    res.status(500).json({ error: 'Executive KPI export failed' });
  }
};

exports.exportForecast = async (req, res) => {
  try {
    const data = await getForecast(req.query);
    const rows = [];
    Object.entries(data.requestForecast).forEach(([period, values]) => {
      Object.entries(values).forEach(([metric, value]) => rows.push({ Group: `Request Forecast ${period}`, Metric: metric, Value: value }));
    });
    Object.entries(data.capacityForecast).forEach(([metric, value]) => rows.push({ Group: 'Capacity Forecast', Metric: metric, Value: value }));
    Object.entries(data.inventoryForecast).forEach(([metric, value]) => {
      if (!Array.isArray(value)) rows.push({ Group: 'Inventory Forecast', Metric: metric, Value: value });
    });
    data.inventoryForecast.recommendedReorderMaterials.forEach(row => rows.push({
      Group: 'Recommended Reorder Materials',
      Metric: row.material,
      Value: `${row.days_until_stockout || 'N/A'} days until stockout`,
    }));
    await auditExecutive(req, 'forecast_exported', {});
    return sendExcel(res, rows, `executive-forecast-${new Date().toISOString().split('T')[0]}.xlsx`, 'Forecast');
  } catch (err) {
    res.status(500).json({ error: 'Forecast export failed' });
  }
};
