const db = require('./database');
const { FIXED_COST } = require('../services/costConfig');

async function migrate() {
  const client = await db.getClient();
  try {
    console.log('Starting migration v21: quantity-aware STL request totals...');
    await client.query('BEGIN');

    const result = await client.query(
      `
      WITH stl_totals AS (
        SELECT
          r.id,
          COALESCE(r.quantity, 1) AS quantity,
          COALESCE(SUM(sm.estimated_material_usage_g), 0) AS material_usage_per_part,
          COALESCE(SUM(sm.estimated_print_time_minutes), 0) AS print_minutes_per_part,
          COALESCE(SUM(sm.stl_material_cost), 0) AS material_cost_per_part,
          COALESCE(SUM(sm.stl_time_cost), 0) AS machine_cost_per_part
        FROM print_requests r
        JOIN request_stl_metadata sm ON sm.request_id = r.id
        WHERE sm.parse_status = 'valid'
        GROUP BY r.id, r.quantity
      )
      UPDATE print_requests r
      SET material_reserved_qty = ROUND((s.material_usage_per_part * s.quantity)::NUMERIC, 1),
          estimated_printing_time = ROUND((s.print_minutes_per_part * s.quantity)::NUMERIC, 1),
          estimated_cost = ROUND(((s.material_cost_per_part * s.quantity) + (s.machine_cost_per_part * s.quantity) + $1)::NUMERIC, 2)
      FROM stl_totals s
      WHERE r.id = s.id
        AND (s.material_usage_per_part > 0 OR s.print_minutes_per_part > 0)
      RETURNING r.id
      `,
      [FIXED_COST]
    );

    await client.query('COMMIT');
    console.log(`Migration v21 completed successfully. Updated ${result.rowCount} request(s).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration v21 failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
}

migrate();
