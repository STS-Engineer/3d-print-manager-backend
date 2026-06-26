const db = require('../config/database');

const ensureStlMetadataTable = async (client = db) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS request_stl_metadata (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id UUID NOT NULL REFERENCES print_requests(id) ON DELETE CASCADE,
      attachment_id UUID NOT NULL UNIQUE REFERENCES request_attachments(id) ON DELETE CASCADE,
      file_name VARCHAR(255) NOT NULL,
      file_size INTEGER,
      parse_status VARCHAR(30) NOT NULL DEFAULT 'not_analyzed',
      error_message TEXT,
      units VARCHAR(20) NOT NULL DEFAULT 'mm',
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await client.query('CREATE INDEX IF NOT EXISTS idx_request_stl_metadata_request ON request_stl_metadata(request_id)');
};

const analyzeAndStoreStlMetadata = async ({ attachment, client = db }) => {
  await ensureStlMetadataTable(client);
  const result = await client.query(`
    INSERT INTO request_stl_metadata (
      request_id, attachment_id, file_name, file_size, parse_status, error_message
    )
    VALUES ($1,$2,$3,$4,'not_analyzed',NULL)
    ON CONFLICT (attachment_id) DO UPDATE SET
      file_name = EXCLUDED.file_name,
      file_size = EXCLUDED.file_size,
      parse_status = 'not_analyzed',
      error_message = NULL,
      updated_at = NOW()
    RETURNING *
  `, [
    attachment.request_id,
    attachment.id,
    attachment.original_name,
    attachment.file_size,
  ]);
  return result.rows[0];
};

const refreshRequestStlMetadata = async () => [];
const updateRequestTotalsFromStl = async () => null;

module.exports = {
  ensureStlMetadataTable,
  analyzeAndStoreStlMetadata,
  refreshRequestStlMetadata,
  updateRequestTotalsFromStl,
  parseStlBuffer: () => null,
};
