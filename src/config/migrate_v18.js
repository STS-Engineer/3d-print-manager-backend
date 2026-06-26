const db = require('./database');
const {
  ensureStlMetadataTable,
  recalculateRequestStlMaterialEstimates,
} = require('../services/stlMetadataService');

const migrate = async () => {
  const client = await db.getClient();
  try {
    console.log('Starting migration v18: STL cost estimates...');
    await client.query('BEGIN');
    await ensureStlMetadataTable(client);
    const requests = await client.query(`
      SELECT DISTINCT r.id, r.material_preference, r.infill_percentage, r.layer_height,
             r.price_per_kg, p.name AS printer_name, p.model AS printer_model
      FROM print_requests r
      JOIN request_stl_metadata sm ON sm.request_id = r.id
      LEFT JOIN printers p ON r.printer_id = p.id
      WHERE sm.parse_status = 'valid'
    `);
    for (const request of requests.rows) {
      await recalculateRequestStlMaterialEstimates({
        requestId: request.id,
        materialPreference: request.material_preference,
        infillPercentage: request.infill_percentage,
        layerHeight: request.layer_height,
        printerName: request.printer_name,
        printerModel: request.printer_model,
        pricePerKg: request.price_per_kg,
        client,
      });
    }
    await client.query('COMMIT');
    console.log('Migration v18 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v18 failed:', err);
    throw err;
  } finally {
    client.release();
    await db.pool.end();
  }
};

migrate().catch(() => process.exit(1));
