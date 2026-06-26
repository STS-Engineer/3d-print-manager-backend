const db = require('./database');
require('dotenv').config();

const migrate = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    console.log('Starting migration v27: add production cycle cost tracking fields...');

    await client.query(`
      ALTER TABLE request_production_cycles
        ADD COLUMN IF NOT EXISTS requested_quantity INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS print_time_minutes DECIMAL(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS material_cost DECIMAL(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS machine_cost DECIMAL(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS fixed_cost DECIMAL(12,2) DEFAULT 0;
    `);

    await client.query('COMMIT');
    console.log('Migration v27 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v27 failed:', err);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate().catch(console.error);
