const db = require('./database');

const migrate = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE print_requests
        ALTER COLUMN planned_start_date TYPE TIMESTAMPTZ
          USING planned_start_date::timestamptz,
        ALTER COLUMN planned_end_date TYPE TIMESTAMPTZ
          USING planned_end_date::timestamptz;
    `);

    await client.query('COMMIT');
    console.log('Migration v14 completed: planned dates now preserve datetime precision');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v14 failed:', err);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate().catch(console.error);
