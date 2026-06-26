const db = require('./database');
const { ensureStlMetadataTable } = require('../services/stlMetadataService');

const migrate = async () => {
  const client = await db.getClient();
  try {
    console.log('Starting migration v15: STL metadata storage...');
    await client.query('BEGIN');
    await ensureStlMetadataTable(client);
    await client.query('COMMIT');
    console.log('Migration v15 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v15 failed:', err);
    throw err;
  } finally {
    client.release();
    await db.pool.end();
  }
};

migrate().catch(() => process.exit(1));
