/**
 * MIGRATION V5
 * - sites master data table
 * - print_requests.site_id required for every request
 */
const db = require('./database');
require('dotenv').config();

const migrate_v5 = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS sites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      INSERT INTO sites (name, description) VALUES
        ('SAME', 'SAME site'),
        ('SCEET', 'SCEET site')
      ON CONFLICT (name) DO NOTHING;
    `);

    await client.query(`
      ALTER TABLE print_requests
      ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites(id) ON DELETE RESTRICT;

      UPDATE print_requests
      SET site_id = (SELECT id FROM sites WHERE name = 'SAME' LIMIT 1)
      WHERE site_id IS NULL;

      ALTER TABLE print_requests
      ALTER COLUMN site_id SET NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_requests_site ON print_requests(site_id);
    `);

    await client.query('COMMIT');
    console.log('Migration V5 completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration V5 failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate_v5().catch(console.error);
