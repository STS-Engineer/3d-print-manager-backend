const reworkRequestSql = (alias = 'r') => {
  const requestId = alias ? `${alias}.id` : 'print_requests.id';

  return `(
    EXISTS (
      SELECT 1
      FROM request_production_cycles pc_rework
      WHERE pc_rework.request_id = ${requestId}
        AND (
          COALESCE(pc_rework.cycle_number, 1) > 1
          OR LOWER(COALESCE(
            to_jsonb(pc_rework)->>'type',
            to_jsonb(pc_rework)->>'cycle_type',
            ''
          )) = 'rework'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM status_history sh_rework
      WHERE sh_rework.request_id = ${requestId}
        AND sh_rework.to_status = 'rework_required'
    )
  )`;
};

const reworkRateSql = (alias = 'r', denominatorCondition = null) => {
  const numeratorCondition = denominatorCondition
    ? `${denominatorCondition} AND ${reworkRequestSql(alias)}`
    : reworkRequestSql(alias);
  const denominator = denominatorCondition
    ? `COUNT(*) FILTER (WHERE ${denominatorCondition})`
    : 'COUNT(*)';

  return `
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE ${numeratorCondition})
    / NULLIF(${denominator}, 0),
    1
  )
`;
};

module.exports = {
  reworkRequestSql,
  reworkRateSql,
};
