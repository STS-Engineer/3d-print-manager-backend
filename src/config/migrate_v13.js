const db = require('./database');

const migrate = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE printers
        ADD COLUMN IF NOT EXISTS serial_number VARCHAR(120),
        ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS total_operating_hours DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_maintenance_date DATE,
        ADD COLUMN IF NOT EXISTS next_maintenance_date DATE,
        ADD COLUMN IF NOT EXISTS maintenance_interval_hours DECIMAL(10,2) DEFAULT 500,
        ADD COLUMN IF NOT EXISTS maintenance_interval_days INTEGER DEFAULT 90,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS printer_maintenance_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        printer_id UUID NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
        performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        performed_by_name VARCHAR(200),
        maintenance_type VARCHAR(100) NOT NULL DEFAULT 'preventive',
        status VARCHAR(40) NOT NULL DEFAULT 'completed',
        maintenance_date DATE NOT NULL DEFAULT CURRENT_DATE,
        completed_at TIMESTAMPTZ,
        notes TEXT,
        downtime_hours DECIMAL(8,2) DEFAULT 0,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_by_name VARCHAR(200),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_printer_maintenance_printer ON printer_maintenance_events(printer_id);
      CREATE INDEX IF NOT EXISTS idx_printer_maintenance_date ON printer_maintenance_events(maintenance_date);
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS update_printer_maintenance_updated_at ON printer_maintenance_events;
      CREATE TRIGGER update_printer_maintenance_updated_at
        BEFORE UPDATE ON printer_maintenance_events
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

      DROP TRIGGER IF EXISTS update_printers_updated_at ON printers;
      CREATE TRIGGER update_printers_updated_at
        BEFORE UPDATE ON printers
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);

    await client.query('COMMIT');
    console.log('Migration v13 completed: printer maintenance management');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v13 failed:', err);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate().catch(console.error);
