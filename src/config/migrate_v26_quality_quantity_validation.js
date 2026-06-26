const db = require('./database');
require('dotenv').config();

const migrate = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    console.log('Starting migration v26: add quality check quantity validation fields...');

    await client.query(`
      ALTER TABLE quality_checks
        ADD COLUMN IF NOT EXISTS validated_quantity_checked INTEGER,
        ADD COLUMN IF NOT EXISTS successful_quantity INTEGER,
        ADD COLUMN IF NOT EXISTS remaining_quantity INTEGER,
        ADD COLUMN IF NOT EXISTS quantity_mismatch BOOLEAN DEFAULT false;
    `);

    await client.query('COMMIT');
    console.log('Migration v26 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v26 failed:', err);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate().catch(console.error);
