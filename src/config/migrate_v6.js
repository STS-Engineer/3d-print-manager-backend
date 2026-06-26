/**
 * MIGRATION V6
 * - print_requests: dynamic material price and cost tracking
 */
const db = require('./database');
require('dotenv').config();

const migrate_v6 = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE print_requests
        ADD COLUMN IF NOT EXISTS price_per_kg DECIMAL(10,2),
        ADD COLUMN IF NOT EXISTS estimated_cost DECIMAL(10,2),
        ADD COLUMN IF NOT EXISTS actual_cost DECIMAL(10,2);
    `);

    await client.query('COMMIT');
    console.log('Migration V6 completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration V6 failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate_v6().catch(console.error);
