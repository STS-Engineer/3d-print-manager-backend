const db = require('./database');

const migrate = async () => {
  const client = await db.getClient();
  try {
    console.log('Starting migration v19: requested due datetime...');
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE print_requests
        ALTER COLUMN requested_due_date TYPE TIMESTAMPTZ
        USING requested_due_date::timestamptz;
    `);
    await client.query('COMMIT');
    console.log('Migration v19 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v19 failed:', err);
    throw err;
  } finally {
    client.release();
    await db.pool.end();
  }
};

migrate().catch(() => process.exit(1));
