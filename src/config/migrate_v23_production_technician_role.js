const db = require('./database');
require('dotenv').config();

const migrate = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE users
      SET role = 'production_technician',
          updated_at = NOW()
      WHERE role IN ('coordinator', 'technician');
    `);

    await client.query('COMMIT');
    console.log('Production Technician role migration completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Production Technician role migration failed:', err);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate().catch(console.error);
