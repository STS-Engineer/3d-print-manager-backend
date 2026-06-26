/**
 * MIGRATION V10
 * - source marker for imported Monday.com historical records
 * - import history table
 */
const db = require('./database');
require('dotenv').config();

const migrate_v10 = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE print_requests
        ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'application';
    `);

    await client.query(`
      UPDATE print_requests
      SET source = 'application'
      WHERE source IS NULL;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS monday_import_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_name VARCHAR(255),
        total_rows INTEGER DEFAULT 0,
        imported_count INTEGER DEFAULT 0,
        skipped_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        errors JSONB,
        imported_by UUID REFERENCES users(id) ON DELETE SET NULL,
        imported_by_name VARCHAR(200),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_print_requests_source ON print_requests(source);
      CREATE INDEX IF NOT EXISTS idx_monday_import_history_created ON monday_import_history(created_at);
    `);

    await client.query('COMMIT');
    console.log('Migration V10 completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration V10 failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate_v10().catch(console.error);
