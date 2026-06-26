const db = require('./database');
const {
  ensureStlMetadataTable,
  recalculateRequestStlMaterialEstimates,
} = require('../services/stlMetadataService');

const migrate = async () => {
  const client = await db.getClient();
  try {
    console.log('Starting migration v16: STL material estimates...');
    await client.query('BEGIN');
    await ensureStlMetadataTable(client);
    const requests = await client.query(`
      SELECT DISTINCT r.id, r.material_preference, r.infill_percentage
      FROM print_requests r
      JOIN request_stl_metadata sm ON sm.request_id = r.id
      WHERE sm.parse_status = 'valid'
    `);
    for (const request of requests.rows) {
      await recalculateRequestStlMaterialEstimates({
        requestId: request.id,
        materialPreference: request.material_preference,
        infillPercentage: request.infill_percentage,
        client,
      });
    }
    await client.query('COMMIT');
    console.log('Migration v16 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v16 failed:', err);
    throw err;
  } finally {
    client.release();
    await db.pool.end();
  }
};

migrate().catch(() => process.exit(1));
