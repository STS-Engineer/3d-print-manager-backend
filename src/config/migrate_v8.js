/**
 * MIGRATION V8
 * - material minimum stock alert state
 */
const db = require('./database');
require('dotenv').config();

const migrate_v8 = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE materials
        ADD COLUMN IF NOT EXISTS low_stock_threshold DECIMAL(10,2) DEFAULT 200,
        ADD COLUMN IF NOT EXISTS low_stock_notified_at TIMESTAMPTZ;
    `);

    await client.query(`
      UPDATE materials
      SET low_stock_threshold = 200
      WHERE low_stock_threshold IS NULL;
    `);

    await client.query('COMMIT');
    console.log('Migration V8 completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration V8 failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate_v8().catch(console.error);
