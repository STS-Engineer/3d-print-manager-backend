/**
 * MIGRATION V9
 * - production cycle history for initial prints and reworks
 */
const db = require('./database');
require('dotenv').config();

const migrate_v9 = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS request_production_cycles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID NOT NULL REFERENCES print_requests(id) ON DELETE CASCADE,
        cycle_number INTEGER NOT NULL,
        printed_quantity INTEGER DEFAULT 0,
        rejected_quantity INTEGER DEFAULT 0,
        material_used DECIMAL(10,2) DEFAULT 0,
        actual_cost DECIMAL(10,2) DEFAULT 0,
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_by_name VARCHAR(200),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (request_id, cycle_number)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prod_cycles_request
      ON request_production_cycles(request_id);
    `);

    await client.query(`
      INSERT INTO request_production_cycles (
        request_id,
        cycle_number,
        printed_quantity,
        rejected_quantity,
        material_used,
        actual_cost,
        start_time,
        end_time,
        created_at
      )
      SELECT
        r.id,
        1,
        COALESCE(r.printed_quantity, 0),
        COALESCE(r.rejected_quantity, 0),
        COALESCE(r.material_used_grams, 0),
        COALESCE(r.actual_cost, 0),
        r.actual_start_time,
        r.actual_end_time,
        COALESCE(r.actual_end_time, r.created_at)
      FROM print_requests r
      WHERE NOT EXISTS (
        SELECT 1 FROM request_production_cycles pc WHERE pc.request_id = r.id
      )
      AND (
        COALESCE(r.printed_quantity, 0) > 0
        OR COALESCE(r.rejected_quantity, 0) > 0
        OR COALESCE(r.material_used_grams, 0) > 0
        OR COALESCE(r.actual_cost, 0) > 0
      );
    `);

    await client.query('COMMIT');
    console.log('Migration V9 completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration V9 failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate_v9().catch(console.error);
