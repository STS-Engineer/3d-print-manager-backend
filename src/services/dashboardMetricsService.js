const COMPLETED_STATUS_LIST = "'completed','requester_confirmation','waiting_customer_confirmation','archived'";

const roundNumber = (value, digits = 2) => {
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  const factor = 10 ** digits;
  return Math.round((parsed + Number.EPSILON) * factor) / factor;
};

const completedCycleSql = (requestAlias = 'r', cycleAlias = 'pc') => `
  ${requestAlias}.status IN (${COMPLETED_STATUS_LIST})
  AND ${cycleAlias}.end_time IS NOT NULL
`;

const reworkCycleSql = (cycleAlias = 'pc') => `
  (
    COALESCE(${cycleAlias}.cycle_number, 1) > 1
    OR LOWER(COALESCE(
      to_jsonb(${cycleAlias})->>'type',
      to_jsonb(${cycleAlias})->>'cycle_type',
      ''
    )) = 'rework'
  )
`;

const plannedPrintHoursSql = (requestAlias = 'r') => `
  CASE
    WHEN ${requestAlias}.planned_start_date IS NOT NULL
     AND ${requestAlias}.planned_end_date IS NOT NULL
     AND ${requestAlias}.planned_end_date >= ${requestAlias}.planned_start_date
    THEN EXTRACT(EPOCH FROM (${requestAlias}.planned_end_date - ${requestAlias}.planned_start_date)) / 3600.0
    ELSE 0
  END
`;

const invalidPlannedDurationSql = (requestAlias = 'r') => `
  ${requestAlias}.planned_start_date IS NOT NULL
  AND ${requestAlias}.planned_end_date IS NOT NULL
  AND ${requestAlias}.planned_end_date < ${requestAlias}.planned_start_date
`;

const completedCycleHoursSql = (requestAlias = 'r', cycleAlias = 'pc') => `
  CASE
    WHEN ${completedCycleSql(requestAlias, cycleAlias)}
    THEN ${plannedPrintHoursSql(requestAlias)}
    ELSE 0
  END
`;

const completedReworkCycleHoursSql = (requestAlias = 'r', cycleAlias = 'pc') => `
  CASE
    WHEN ${completedCycleSql(requestAlias, cycleAlias)}
     AND ${reworkCycleSql(cycleAlias)}
    THEN ${plannedPrintHoursSql(requestAlias)}
    ELSE 0
  END
`;

const utilizationSql = (hoursSql, capacitySql) => `
  CASE
    WHEN GREATEST(COALESCE(${capacitySql}, 0), 0) > 0
    THEN ROUND((GREATEST(COALESCE(${hoursSql}, 0), 0)::NUMERIC / GREATEST(COALESCE(${capacitySql}, 0), 0)::NUMERIC) * 100, 1)
    ELSE 0
  END
`;

const logInvalidPlannedDurations = (label, rows = []) => {
  const count = rows.reduce((sum, row) => sum + parseInt(row.invalid_planned_duration_count || 0, 10), 0);
  if (count > 0) {
    console.error(`[Dashboard Metrics] ${label}: ${count} completed production cycle(s) have Planning End Date before Planning Start Date. Print Hours were clamped to 0.`);
  }
};

module.exports = {
  COMPLETED_STATUS_LIST,
  completedCycleSql,
  reworkCycleSql,
  plannedPrintHoursSql,
  invalidPlannedDurationSql,
  completedCycleHoursSql,
  completedReworkCycleHoursSql,
  utilizationSql,
  logInvalidPlannedDurations,
  roundNumber,
};
