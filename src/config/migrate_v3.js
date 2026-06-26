/**
 * MIGRATION V3 — 13 missing industrial points:
 * 1.  Printer + planned dates assignment (planning stage)
 * 2.  Material reservation (spool, reserved qty)
 * 3.  Blocking reasons table
 * 4.  Full KPI timestamps (assigned_at, printed_at, archived_at, etc.)
 * 5.  Multi-quantity tracking (printed_qty, rejected_qty, reprint_qty)
 * 6.  Reception confirmation fields
 * 7.  SLA / overdue automation (DB function)
 * 8.  Machine utilization (runtime, downtime)
 * 9.  File download audit log
 * 10. QC formal closure (qc_approved_by, qc_date)
 * 11. Priority metadata (business_impact, production_stop_risk)
 * 12. STL/file validation log
 * 13. Overdue auto-flag column
 */

const db = require('./database');
require('dotenv').config();

const migrate_v3 = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const addCol = async (table, col, def) => {
      await client.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def};`
      );
    };

    // ── 1. PLANNING: printer + material reservation at planning stage ──────
    await addCol('print_requests', 'printer_assigned_at',      'TIMESTAMPTZ');
    await addCol('print_requests', 'material_reserved',        'BOOLEAN DEFAULT false');
    await addCol('print_requests', 'material_reserved_qty',    'DECIMAL(10,2)');
    await addCol('print_requests', 'material_reserved_spool',  'VARCHAR(100)');
    await addCol('print_requests', 'material_reserved_at',     'TIMESTAMPTZ');
    await addCol('print_requests', 'material_reserved_by',     'VARCHAR(200)');

    // ── 2. FULL KPI TIMESTAMPS ─────────────────────────────────────────────
    await addCol('print_requests', 'assigned_at',       'TIMESTAMPTZ');
    await addCol('print_requests', 'in_progress_at',    'TIMESTAMPTZ');
    await addCol('print_requests', 'printed_at',        'TIMESTAMPTZ');
    await addCol('print_requests', 'qc_started_at',     'TIMESTAMPTZ');
    await addCol('print_requests', 'qc_completed_at',   'TIMESTAMPTZ');
    await addCol('print_requests', 'ready_at',          'TIMESTAMPTZ');
    await addCol('print_requests', 'archived_at',       'TIMESTAMPTZ');
    // Computed lead times (in hours) stored for fast KPI queries
    await addCol('print_requests', 'lead_time_hours',       'DECIMAL(10,2)');
    await addCol('print_requests', 'processing_time_hours', 'DECIMAL(10,2)');
    await addCol('print_requests', 'queue_time_hours',      'DECIMAL(10,2)');

    // ── 3. MULTI-QUANTITY TRACKING ─────────────────────────────────────────
    await addCol('print_requests', 'printed_quantity',  'INTEGER DEFAULT 0');
    await addCol('print_requests', 'rejected_quantity', 'INTEGER DEFAULT 0');
    await addCol('print_requests', 'reprint_quantity',  'INTEGER DEFAULT 0');
    await addCol('print_requests', 'final_quantity',    'INTEGER DEFAULT 0');

    // ── 4. FORMAL RECEPTION CONFIRMATION ──────────────────────────────────
    await addCol('print_requests', 'reception_confirmed_by',   'VARCHAR(200)');
    await addCol('print_requests', 'reception_confirmed_at',   'TIMESTAMPTZ');
    await addCol('print_requests', 'reception_comment',        'TEXT');
    await addCol('print_requests', 'reception_condition',      'VARCHAR(50)'); 

    // ── 5. SLA / OVERDUE ──────────────────────────────────────────────────
    await addCol('print_requests', 'is_overdue',            'BOOLEAN DEFAULT false');
    await addCol('print_requests', 'overdue_notified_at',   'TIMESTAMPTZ');
    await addCol('print_requests', 'sla_hours',             'INTEGER');
    await addCol('print_requests', 'sla_breach_at',         'TIMESTAMPTZ');

    // ── 6. PRIORITY METADATA ───────────────────────────────────────────────
    await addCol('print_requests', 'business_impact',       'VARCHAR(50)');
    await addCol('print_requests', 'production_stop_risk',  'BOOLEAN DEFAULT false');

    // ── 7. FORMAL QC CLOSURE ──────────────────────────────────────────────
    await addCol('print_requests', 'qc_approved_by_name',  'VARCHAR(200)');
    await addCol('print_requests', 'qc_date',              'TIMESTAMPTZ');
    await addCol('print_requests', 'qc_reference',         'VARCHAR(100)');

    // ── 8. MACHINE UTILIZATION ────────────────────────────────────────────
    await addCol('print_requests', 'machine_runtime_hours',   'DECIMAL(8,2)');
    await addCol('print_requests', 'machine_downtime_hours',  'DECIMAL(8,2)');
    await addCol('print_requests', 'machine_pause_reason',    'TEXT');

    // ── 9. FILE DOWNLOAD AUDIT ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS file_download_logs (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        attachment_id UUID REFERENCES request_attachments(id) ON DELETE CASCADE,
        request_id   UUID REFERENCES print_requests(id) ON DELETE CASCADE,
        downloaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
        downloaded_by_name VARCHAR(200),
        downloaded_at TIMESTAMPTZ DEFAULT NOW(),
        ip_address   VARCHAR(50)
      );
      CREATE INDEX IF NOT EXISTS idx_file_downloads_request
        ON file_download_logs(request_id);
      CREATE INDEX IF NOT EXISTS idx_file_downloads_user
        ON file_download_logs(downloaded_by);
    `);

    // ── 10. FILE VALIDATION LOG ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS file_validation_logs (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        attachment_id UUID REFERENCES request_attachments(id) ON DELETE CASCADE,
        request_id    UUID REFERENCES print_requests(id) ON DELETE CASCADE,
        is_valid      BOOLEAN NOT NULL DEFAULT false,
        file_size_ok  BOOLEAN,
        extension_ok  BOOLEAN,
        not_empty     BOOLEAN,
        validation_notes TEXT,
        validated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── 11. BLOCKING REASONS CATALOG ─────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS blocking_reasons (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code        VARCHAR(50) UNIQUE NOT NULL,
        label       VARCHAR(120) NOT NULL,
        category    VARCHAR(50) DEFAULT 'technical',
        is_active   BOOLEAN DEFAULT true
      );
      INSERT INTO blocking_reasons (code, label, category) VALUES
        ('stl_corrupt',       'STL file corrupted or unprintable',   'file'),
        ('stl_too_large',     'Part exceeds printer build volume',   'technical'),
        ('warping',           'Warping / adhesion failure',          'print_failure'),
        ('layer_shift',       'Layer shift during print',            'print_failure'),
        ('machine_failure',   'Machine failure / maintenance',       'machine'),
        ('material_empty',    'Material spool empty',                'material'),
        ('material_wrong',    'Wrong material loaded',               'material'),
        ('missing_info',      'Missing technical information',       'information'),
        ('design_issue',      'Design requires modification',        'design'),
        ('power_outage',      'Power outage',                        'infrastructure'),
        ('other',             'Other — see comment',                 'other')
      ON CONFLICT (code) DO NOTHING;
    `);

    // ── 12. SLA OVERDUE AUTOMATIC FLAG (DB function + trigger) ───────────
    await client.query(`
      CREATE OR REPLACE FUNCTION flag_overdue_requests()
      RETURNS void AS $$
      BEGIN
        UPDATE print_requests
        SET is_overdue = true
        WHERE approved_due_date < NOW()
          AND status NOT IN ('completed','archived','cancelled','rejected')
          AND (is_overdue = false OR is_overdue IS NULL);
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ── 13. INDEXES for KPI queries ───────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_requests_overdue
        ON print_requests(is_overdue, approved_due_date)
        WHERE status NOT IN ('completed','archived','cancelled','rejected');
      CREATE INDEX IF NOT EXISTS idx_requests_submitted_at
        ON print_requests(submitted_at);
      CREATE INDEX IF NOT EXISTS idx_requests_completion
        ON print_requests(completion_date)
        WHERE status = 'completed';
    `);

    await client.query('COMMIT');
    console.log('✅ Migration V3 completed.');
    console.log('Added: file_download_logs, file_validation_logs, blocking_reasons');
    console.log('New columns: KPI timestamps, material reservation, multi-qty, reception, SLA, QC closure, machine utilization');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V3 failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate_v3().catch(console.error);