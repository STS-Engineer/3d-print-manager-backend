const db = require('../config/database');
const { FIXED_COST } = require('./costConfig');
const {
  completedReworkCycleHoursSql,
  invalidPlannedDurationSql,
  logInvalidPlannedDurations,
  reworkCycleSql,
} = require('./dashboardMetricsService');


const moneyNumber = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
};

const buildCostFilters = (filters = {}, startIndex = 1) => {
  const conditions = ["COALESCE(r.source, 'application') <> 'monday'"];
  const params = [];
  let idx = startIndex;

  const add = (sql, value) => {
    conditions.push(sql.replace('?', `$${idx++}`));
    params.push(value);
  };

  if (filters.site_id) add('r.site_id = ?', filters.site_id);
  if (filters.material_id) add('r.material_id = ?', filters.material_id);
  if (filters.printer_id) add('r.printer_id = ?', filters.printer_id);
  if (filters.technician_id) add('r.assigned_technician_id = ?', filters.technician_id);
  if (filters.priority) add('r.priority = ?', filters.priority);
  if (filters.status) add('r.status = ?', filters.status);
  if (filters.category_id) add('r.category_id = ?', filters.category_id);
  if (filters.requester_id) add('r.requester_id = ?', filters.requester_id);
  if (filters.criticality) add('r.criticality = ?', filters.criticality);
  if (filters.requester) add('r.requester_name ILIKE ?', `%${filters.requester}%`);
  if (filters.department) add('r.requester_department ILIKE ?', `%${filters.department}%`);
  if (filters.production_status) {
    const groups = {
      planned: ['planned'],
      active: ['assigned', 'in_progress', 'printed', 'post_processing', 'quality_check', 'rework_required'],
      blocked: ['blocked', 'on_hold', 'waiting_for_material', 'waiting_for_machine', 'waiting_for_input'],
      completed: ['ready_for_pickup', 'requester_confirmation', 'completed', 'archived'],
    };
    if (groups[filters.production_status]) add('r.status = ANY(?)', groups[filters.production_status]);
  }
  if (filters.approval_status) {
    const groups = {
      pending: ['submitted', 'completeness_check', 'feasibility_review'],
      approved: ['approved', 'prioritized', 'planned', 'assigned', 'in_progress', 'printed', 'post_processing', 'quality_check', 'ready_for_pickup', 'requester_confirmation', 'completed', 'archived'],
      rejected: ['rejected'],
    };
    if (groups[filters.approval_status]) add('r.status = ANY(?)', groups[filters.approval_status]);
  }
  if (filters.delivery_status) {
    const completedAt = 'COALESCE(r.completion_date, r.ready_at, r.actual_end_time)';
    const dueDate = 'COALESCE(r.approved_due_date, r.requested_due_date)';
    if (filters.delivery_status === 'overdue') conditions.push(`r.status NOT IN ('completed','requester_confirmation','waiting_customer_confirmation','archived','cancelled','rejected') AND ${dueDate} IS NOT NULL AND ${dueDate}::date < CURRENT_DATE`);
    if (filters.delivery_status === 'awaiting_confirmation') conditions.push("r.status IN ('ready_for_pickup','requester_confirmation','waiting_customer_confirmation')");
    if (filters.delivery_status === 'completed') conditions.push("r.status IN ('completed','requester_confirmation','waiting_customer_confirmation','archived')");
    if (filters.delivery_status === 'on_time') conditions.push(`r.status IN ('completed','requester_confirmation','waiting_customer_confirmation','archived') AND ${completedAt} IS NOT NULL AND ${dueDate} IS NOT NULL AND ${completedAt} <= ${dueDate}`);
    if (filters.delivery_status === 'late') conditions.push(`r.status IN ('completed','requester_confirmation','waiting_customer_confirmation','archived') AND ${completedAt} IS NOT NULL AND ${dueDate} IS NOT NULL AND ${completedAt} > ${dueDate}`);
  }
  if (filters.date_from) add('COALESCE(r.completion_date, r.actual_end_time, r.created_at)::date >= ?::date', filters.date_from);
  if (filters.date_to) add('COALESCE(r.completion_date, r.actual_end_time, r.created_at)::date <= ?::date', filters.date_to);
  if (filters.month) add("EXTRACT(MONTH FROM COALESCE(r.completion_date, r.actual_end_time, r.created_at)) = ?::int", filters.month);
  if (filters.year) add("EXTRACT(YEAR FROM COALESCE(r.completion_date, r.actual_end_time, r.created_at)) = ?::int", filters.year);

  return {
    where: `WHERE ${conditions.join(' AND ')}`,
    params,
  };
};

const baseFrom = `
  FROM print_requests r
  LEFT JOIN (
    SELECT request_id, COUNT(*) AS cycle_count
    FROM request_production_cycles
    GROUP BY request_id
  ) pc ON pc.request_id = r.id
`;

const normalizeSummary = (row = {}) => {
  const actualCostTotal = moneyNumber(row.actual_cost_total);
  const requestCount = parseInt(row.request_count || 0, 10);
  return {
    actualCostTotal,
    averageCostPerRequest: requestCount > 0 ? moneyNumber(actualCostTotal / requestCount) : 0,
    averageMaterialCost: moneyNumber(row.average_material_cost),
    averageMachineCost: moneyNumber(row.average_machine_cost),
    averageTotalCost: requestCount > 0 ? moneyNumber(actualCostTotal / requestCount) : 0,
    topCostMaterials: row.top_cost_materials || [],
    topCostPrinters: row.top_cost_printers || [],
    requestCount,
    reworkCount: parseInt(row.rework_count || 0, 10),
    lastUpdated: new Date().toISOString(),
  };
};

const normalizeRows = (rows = []) => rows.map((row) => {
  const actualCostTotal = moneyNumber(row.actual_cost_total);
  return {
    id: row.id,
    label: row.label || 'Unassigned',
    actualCostTotal,
    requestCount: parseInt(row.request_count || 0, 10),
    reworkCount: parseInt(row.rework_count || 0, 10),
  };
});

const getCostSummary = async (filters = {}) => {
  const { where, params } = buildCostFilters(filters);
  const result = await db.query(`
    WITH filtered AS (
      SELECT r.*, m.cost_per_unit, p.cost_per_minute,
             COALESCE(pc.cycle_count, 0) AS cycle_count
      ${baseFrom}
      LEFT JOIN materials m ON r.material_id = m.id
      LEFT JOIN printers p ON r.printer_id = p.id
      ${where}
    ),
    components AS (
      SELECT *,
        COALESCE(production_total_material_usage, 0) * COALESCE(cost_per_unit, price_per_kg / 1000.0, 0) AS material_cost_component,
        COALESCE(production_total_print_time_minutes, 0) * COALESCE(cost_per_minute, 0) AS machine_cost_component
      FROM filtered
    ),
    top_materials AS (
      SELECT COALESCE(m.name, 'Unassigned') AS label,
             COALESCE(SUM(c.material_cost_component), 0) AS value
      FROM components c
      LEFT JOIN materials m ON c.material_id = m.id
      GROUP BY COALESCE(m.name, 'Unassigned')
      ORDER BY value DESC
      LIMIT 5
    ),
    top_printers AS (
      SELECT COALESCE(p.name, 'Unassigned') AS label,
             COALESCE(SUM(c.machine_cost_component), 0) AS value
      FROM components c
      LEFT JOIN printers p ON c.printer_id = p.id
      GROUP BY COALESCE(p.name, 'Unassigned')
      ORDER BY value DESC
      LIMIT 5
    )
    SELECT
      COALESCE(SUM(actual_cost), 0) AS actual_cost_total,
      COUNT(id) AS request_count,
      COALESCE(SUM(GREATEST(cycle_count - 1, 0)), 0) AS rework_count,
      AVG(material_cost_component) AS average_material_cost,
      AVG(machine_cost_component) AS average_machine_cost,
      COALESCE((SELECT json_agg(top_materials) FROM top_materials), '[]'::json) AS top_cost_materials,
      COALESCE((SELECT json_agg(top_printers) FROM top_printers), '[]'::json) AS top_cost_printers
    FROM components
  `, params);
  return normalizeSummary(result.rows[0]);
};

const getCostBreakdown = async (dimension, filters = {}) => {
  const dimensions = {
    site: {
      joins: 'LEFT JOIN sites s ON r.site_id = s.id',
      id: 's.id',
      label: "COALESCE(s.name, 'Unassigned')",
    },
    material: {
      joins: 'LEFT JOIN materials m ON r.material_id = m.id',
      id: 'm.id',
      label: "COALESCE(m.name, 'Unassigned')",
    },
    printer: {
      joins: 'LEFT JOIN printers p ON r.printer_id = p.id',
      id: 'p.id',
      label: "COALESCE(p.name, 'Unassigned')",
    },
    technician: {
      joins: 'LEFT JOIN users u ON r.assigned_technician_id = u.id',
      id: 'u.id',
      label: "COALESCE(u.first_name || ' ' || u.last_name, 'Unassigned')",
    },
  };
  const config = dimensions[dimension];
  if (!config) throw new Error(`Unknown cost breakdown dimension: ${dimension}`);

  const { where, params } = buildCostFilters(filters);
  const result = await db.query(`
    SELECT
      ${config.id} AS id,
      ${config.label} AS label,
      COALESCE(SUM(r.actual_cost), 0) AS actual_cost_total,
      COUNT(r.id) AS request_count,
      COALESCE(SUM(GREATEST(COALESCE(pc.cycle_count, 0) - 1, 0)), 0) AS rework_count
    ${baseFrom}
    ${config.joins}
    ${where}
    GROUP BY ${config.id}, ${config.label}
    ORDER BY actual_cost_total DESC, label ASC
  `, params);
  return normalizeRows(result.rows);
};

const getMonthlyCostTrend = async (filters = {}) => {
  const { where, params } = buildCostFilters(filters);
  const result = await db.query(`
    SELECT
      DATE_TRUNC('month', COALESCE(r.completion_date, r.actual_end_time, r.created_at))::DATE AS month,
      COALESCE(SUM(r.actual_cost), 0) AS actual_cost_total
    ${baseFrom}
    ${where}
    GROUP BY DATE_TRUNC('month', COALESCE(r.completion_date, r.actual_end_time, r.created_at))
    ORDER BY month
  `, params);

  return result.rows.map(row => ({
    month: row.month,
    actualCostTotal: moneyNumber(row.actual_cost_total),
  }));
};

const getReworkCostSummary = async (filters = {}) => {
  const { where, params } = buildCostFilters(filters);
  const result = await db.query(`
    SELECT
      COALESCE(SUM(pc.actual_cost), 0) AS total_rework_cost,
      COALESCE(SUM(pc.material_used), 0) AS rework_material_used,
      COALESCE(SUM(${completedReworkCycleHoursSql('r', 'pc')}), 0) AS rework_print_hours,
      COUNT(*) FILTER (WHERE ${invalidPlannedDurationSql('r')}) AS invalid_planned_duration_count
    FROM print_requests r
    JOIN request_production_cycles pc ON pc.request_id = r.id AND ${reworkCycleSql('pc')}
    ${where}
  `, params);

  const row = result.rows[0] || {};
  logInvalidPlannedDurations('Cost - Rework Print Hours', [row]);
  return {
    totalReworkCost: moneyNumber(row.total_rework_cost),
    reworkMaterialUsed: moneyNumber(row.rework_material_used),
    reworkPrintHours: moneyNumber(row.rework_print_hours),
  };
};

const getCostComponentBreakdown = async (filters = {}) => {
  const { where, params } = buildCostFilters(filters);
  const result = await db.query(`
    WITH filtered_requests AS (
      SELECT r.*
      FROM print_requests r
      ${where}
    )
    SELECT
      COALESCE(SUM(
        COALESCE(
          COALESCE(fr.production_total_material_usage, 0) * m.cost_per_unit,
          COALESCE(fr.production_total_material_usage, 0) * COALESCE(fr.price_per_kg, 0) / 1000.0,
          0
        )
      ), 0) AS material_cost,
      COALESCE(SUM(COALESCE(fr.production_total_print_time_minutes, 0) * COALESCE(p.cost_per_minute, 0)), 0) AS print_time_cost,
      CASE
        WHEN COUNT(fr.id) FILTER (
          WHERE COALESCE(fr.production_total_material_usage, 0) > 0
             AND COALESCE(fr.production_total_print_time_minutes, 0) > 0
        ) > 0 THEN ${FIXED_COST}
        ELSE 0
      END AS fixed_cost,
      COALESCE(SUM(fr.actual_cost), 0) AS actual_cost_total
    FROM filtered_requests fr
    LEFT JOIN materials m ON fr.material_id = m.id
    LEFT JOIN printers p ON fr.printer_id = p.id
  `, params);

  const row = result.rows[0] || {};
  return {
    materialCost: moneyNumber(row.material_cost),
    printTimeCost: moneyNumber(row.print_time_cost),
    fixedCost: moneyNumber(row.fixed_cost),
    actualCostTotal: moneyNumber(row.actual_cost_total),
    fixedCostUnit: FIXED_COST,
    fixedCostFormula: `Total Cost = (Material Weight x Material Rate) + (Print Time x Time Rate) + ${FIXED_COST.toFixed(2)} EUR. The fixed cost is a constant and is not multiplied by production cycle count.`,
    fixedCostSource: 'REQUEST_FIXED_COST env var, fallback FIXED_COST env var, fallback 9.86 EUR.',
  };
};

const getTopCostDrivers = async (filters = {}) => {
  const { where, params } = buildCostFilters(filters);
  const result = await db.query(`
    SELECT
      r.id,
      r.request_number,
      r.title,
      COALESCE(r.actual_cost, 0) AS actual_cost
    ${baseFrom}
    ${where}
    ORDER BY COALESCE(r.actual_cost, 0) DESC
    LIMIT 10
  `, params);

  return result.rows.map(row => ({
    id: row.id,
    requestNumber: row.request_number,
    title: row.title,
    actualCost: moneyNumber(row.actual_cost),
  }));
};

const getAllCostData = async (filters = {}) => ({
  summary: await getCostSummary(filters),
  bySite: await getCostBreakdown('site', filters),
  byMaterial: await getCostBreakdown('material', filters),
  byPrinter: await getCostBreakdown('printer', filters),
  byTechnician: await getCostBreakdown('technician', filters),
  monthlyTrend: await getMonthlyCostTrend(filters),
  reworkCost: await getReworkCostSummary(filters),
  costBreakdown: await getCostComponentBreakdown(filters),
  topCostDrivers: await getTopCostDrivers(filters),
});

module.exports = {
  getCostSummary,
  getCostBreakdown,
  getMonthlyCostTrend,
  getReworkCostSummary,
  getCostComponentBreakdown,
  getTopCostDrivers,
  getAllCostData,
};
