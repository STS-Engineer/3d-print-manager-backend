/**
 * MIGRATION V4
 * - materials: add available_quantity, reserved_quantity columns
 * - material_reservations table
 * - material_transactions table (history of all stock movements)
 * - print_requests: add info_required_at, info_required_reason columns
 */
const db = require('./database');
require('dotenv').config();

const migrate_v4 = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const addCol = async (table, col, def) => {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def};`);
    };

    // ── MATERIALS: add proper stock tracking columns ─────────────────────
    await addCol('materials', 'available_quantity', 'DECIMAL(10,2) DEFAULT 0');
    await addCol('materials', 'reserved_quantity',  'DECIMAL(10,2) DEFAULT 0');
    await addCol('materials', 'low_stock_threshold','DECIMAL(10,2) DEFAULT 200');

    // Sync available_quantity from stock_quantity for existing rows
    await client.query(`
      UPDATE materials
      SET available_quantity = stock_quantity,
          reserved_quantity = 0
      WHERE available_quantity = 0 AND stock_quantity > 0;
    `);

    // ── MATERIAL RESERVATIONS TABLE ───────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS material_reservations (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id       UUID REFERENCES print_requests(id) ON DELETE CASCADE,
        material_id      UUID REFERENCES materials(id) ON DELETE RESTRICT,
        spool_reference  VARCHAR(100),
        reserved_qty     DECIMAL(10,2) NOT NULL,
        consumed_qty     DECIMAL(10,2),
        released_qty     DECIMAL(10,2),
        status           VARCHAR(30) DEFAULT 'reserved',
        reserved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
        reserved_by_name VARCHAR(200),
        reserved_at      TIMESTAMPTZ DEFAULT NOW(),
        consumed_at      TIMESTAMPTZ,
        released_at      TIMESTAMPTZ,
        notes            TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mat_res_request  ON material_reservations(request_id);
      CREATE INDEX IF NOT EXISTS idx_mat_res_material ON material_reservations(material_id);
      CREATE INDEX IF NOT EXISTS idx_mat_res_status   ON material_reservations(status);
    `);

    // ── MATERIAL TRANSACTIONS TABLE (full audit trail) ────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS material_transactions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        material_id     UUID REFERENCES materials(id) ON DELETE CASCADE,
        request_id      UUID REFERENCES print_requests(id) ON DELETE SET NULL,
        reservation_id  UUID REFERENCES material_reservations(id) ON DELETE SET NULL,
        transaction_type VARCHAR(30) NOT NULL,
        quantity        DECIMAL(10,2) NOT NULL,
        quantity_before DECIMAL(10,2),
        quantity_after  DECIMAL(10,2),
        spool_reference VARCHAR(100),
        performed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
        performed_by_name VARCHAR(200),
        notes           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_mat_tx_material ON material_transactions(material_id);
      CREATE INDEX IF NOT EXISTS idx_mat_tx_request  ON material_transactions(request_id);
      CREATE INDEX IF NOT EXISTS idx_mat_tx_type     ON material_transactions(transaction_type);
    `);

    // ── PRINT_REQUESTS: info_required fields ─────────────────────────────
    await addCol('print_requests', 'info_required_at',     'TIMESTAMPTZ');
    await addCol('print_requests', 'info_required_reason', 'TEXT');
    await addCol('print_requests', 'last_edited_at',       'TIMESTAMPTZ');
    await addCol('print_requests', 'last_edited_by_name',  'VARCHAR(200)');

    await client.query('COMMIT');
    console.log('✅ Migration V4 completed.');
    console.log('New tables: material_reservations, material_transactions');
    console.log('New columns: materials.available_quantity, materials.reserved_quantity, print_requests.info_required_*');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V4 failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate_v4().catch(console.error);