const db = require('./database');
require('dotenv').config();

const migrate = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    console.log('Starting migration v25: add manual planning production fields...');

    await client.query(`
      ALTER TABLE print_requests
        ADD COLUMN IF NOT EXISTS production_material_usage_per_part DECIMAL(10,2),
        ADD COLUMN IF NOT EXISTS production_print_time_per_part_minutes DECIMAL(10,2),
        ADD COLUMN IF NOT EXISTS production_total_material_usage DECIMAL(12,2),
        ADD COLUMN IF NOT EXISTS production_total_print_time_minutes DECIMAL(12,2);
    `);

    await client.query('COMMIT');
    console.log('Migration v25 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v25 failed:', err);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate().catch(console.error);
