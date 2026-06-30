const db = require('./src/config/database');

(async () => {
  const totals = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE production_total_material_usage IS NOT NULL) AS planned_with_material_totals,
      COUNT(*) FILTER (WHERE production_total_print_time_minutes IS NOT NULL) AS planned_with_print_totals,
      COUNT(*) FILTER (WHERE material_reserved_qty > 0) AS requests_with_active_reserved_amount
    FROM print_requests
    WHERE COALESCE(source, 'application') <> 'monday'
  `);
  const reservations = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'reserved') AS active_reservations,
      COALESCE(SUM(reserved_qty) FILTER (WHERE status = 'reserved'), 0) AS active_reserved_qty,
      COUNT(*) FILTER (WHERE status = 'consumed') AS consumed_reservations
    FROM material_reservations
  `).catch(() => ({ rows: [{ active_reservations: 0, active_reserved_qty: 0, consumed_reservations: 0 }] }));
  console.log(`planning-totals: ${JSON.stringify(totals.rows[0])}`);
  console.log(`reservations: ${JSON.stringify(reservations.rows[0])}`);
  process.exit(0);
})().catch((err) => {
  console.error(`verify failed: ${err.message}`);
  process.exit(1);
});
