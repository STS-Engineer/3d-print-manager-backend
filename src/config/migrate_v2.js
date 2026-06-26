/**
 * MIGRATION V2 — Completes the missing 35% of the spec:
 * - statuses table (configurable workflow)
 * - feasibility_reviews table
 * - quality_checks table
 * - audit_logs table
 * - post-processing columns
 * - material tracking columns (spool, consumption, cost)
 * - due date columns (rescheduled_due_date)
 * - archiving columns (archived_by, archive_date)
 * - planning board columns
 */

const db = require('./database');
require('dotenv').config();

const migrate_v2 = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // ─────────────────────────────────────────────
    // 1. CONFIGURABLE STATUSES TABLE
    // ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_statuses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(80) UNIQUE NOT NULL,
        label VARCHAR(120) NOT NULL,
        color VARCHAR(30) DEFAULT '#64748b',
        category VARCHAR(50) DEFAULT 'active',
        sort_order INTEGER DEFAULT 0,
        is_terminal BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Insert all spec statuses
    await client.query(`
      INSERT INTO workflow_statuses (code, label, color, category, sort_order, is_terminal) VALUES
        ('draft',                  'Draft',                    '#64748b', 'initial',    1,  false),
        ('submitted',              'Submitted',                '#3b82f6', 'validation', 2,  false),
        ('completeness_check',     'Completeness Check',       '#06b6d4', 'validation', 3,  false),
        ('feasibility_review',     'Feasibility Review',       '#8b5cf6', 'validation', 4,  false),
        ('more_info_required',     'More Info Required',       '#f59e0b', 'waiting',    5,  false),
        ('approved',               'Approved',                 '#22c55e', 'approved',   6,  false),
        ('rejected',               'Rejected',                 '#ef4444', 'terminal',   7,  true),
        ('prioritized',            'Prioritized',              '#f97316', 'planning',   8,  false),
        ('planned',                'Planned',                  '#06b6d4', 'planning',   9,  false),
        ('assigned',               'Assigned',                 '#a855f7', 'execution',  10, false),
        ('in_progress',            'In Progress',              '#3b82f6', 'execution',  11, false),
        ('printed',                'Printed',                  '#10b981', 'execution',  12, false),
        ('post_processing',        'Post-Processing',          '#06b6d4', 'execution',  13, false),
        ('quality_check',          'Quality Check',            '#f59e0b', 'execution',  14, false),
        ('ready_for_pickup',       'Ready for Pickup',         '#22c55e', 'delivery',   15, false),
        ('requester_confirmation', 'Awaiting Confirmation',    '#06b6d4', 'delivery',   16, false),
        ('completed',              'Completed',                '#22c55e', 'terminal',   17, true),
        ('archived',               'Archived',                 '#475569', 'terminal',   18, true),
        ('on_hold',                'On Hold',                  '#f59e0b', 'waiting',    19, false),
        ('blocked',                'Blocked',                  '#ef4444', 'waiting',    20, false),
        ('cancelled',              'Cancelled',                '#475569', 'terminal',   21, true),
        ('rework_required',        'Rework Required',          '#f97316', 'execution',  22, false),
        ('waiting_for_input',      'Waiting for Requester',    '#f59e0b', 'waiting',    23, false),
        ('waiting_for_material',   'Waiting for Material',     '#f59e0b', 'waiting',    24, false),
        ('waiting_for_machine',    'Waiting for Machine',      '#f59e0b', 'waiting',    25, false)
      ON CONFLICT (code) DO NOTHING;
    `);

    // ─────────────────────────────────────────────
    // 2. FEASIBILITY REVIEWS TABLE
    // ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS feasibility_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID REFERENCES print_requests(id) ON DELETE CASCADE,
        reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by_name VARCHAR(200),
        review_date TIMESTAMPTZ DEFAULT NOW(),
        is_printable BOOLEAN,
        machine_compatible BOOLEAN,
        material_available BOOLEAN,
        estimated_cost DECIMAL(10,2),
        estimated_duration_hours DECIMAL(8,2),
        technical_notes TEXT,
        result VARCHAR(30) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ─────────────────────────────────────────────
    // 3. QUALITY CHECKS TABLE
    // ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS quality_checks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID REFERENCES print_requests(id) ON DELETE CASCADE,
        checked_by UUID REFERENCES users(id) ON DELETE SET NULL,
        checked_by_name VARCHAR(200),
        check_date TIMESTAMPTZ DEFAULT NOW(),
        result VARCHAR(30) NOT NULL DEFAULT 'pending',
        dimensional_check BOOLEAN,
        surface_quality_check BOOLEAN,
        functional_check BOOLEAN,
        visual_check BOOLEAN,
        comments TEXT,
        deviation_notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ─────────────────────────────────────────────
    // 4. AUDIT LOGS TABLE
    // ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type VARCHAR(50) NOT NULL,
        entity_id UUID,
        action VARCHAR(50) NOT NULL,
        performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        performed_by_name VARCHAR(200),
        old_values JSONB,
        new_values JSONB,
        ip_address VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(performed_by);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    `);

    // ─────────────────────────────────────────────
    // 5. ADD MISSING COLUMNS TO print_requests
    // ─────────────────────────────────────────────

    // Post-processing
    const addCol = async (col, def) => {
      await client.query(`
        ALTER TABLE print_requests ADD COLUMN IF NOT EXISTS ${col} ${def};
      `);
    };

    await addCol('post_processing_required', 'BOOLEAN DEFAULT false');
    await addCol('post_processing_types', 'TEXT[]');
    await addCol('post_processing_time_actual', 'DECIMAL(8,2)');

    // Material tracking
    await addCol('spool_reference', 'VARCHAR(100)');
    await addCol('material_used_grams', 'DECIMAL(10,2)');
    await addCol('material_cost', 'DECIMAL(10,2)');
    await addCol('print_cost_total', 'DECIMAL(10,2)');

    // Due dates
    await addCol('rescheduled_due_date', 'DATE');
    await addCol('rescheduled_reason', 'TEXT');
    await addCol('rescheduled_by_name', 'VARCHAR(200)');

    // Archiving
    await addCol('archived_by', 'UUID');
    await addCol('archived_by_name', 'VARCHAR(200)');

    // Planning board
    await addCol('planned_start_date', 'DATE');
    await addCol('planned_end_date', 'DATE');
    await addCol('slot_order', 'INTEGER DEFAULT 0');

    // Feasibility
    await addCol('feasibility_result', 'VARCHAR(30)');
    await addCol('feasibility_comment', 'TEXT');
    await addCol('feasibility_by_name', 'VARCHAR(200)');
    await addCol('feasibility_date', 'TIMESTAMPTZ');

    // Waiting reason
    await addCol('waiting_reason', 'TEXT');

    // ─────────────────────────────────────────────
    // 6. MATERIAL STOCK MOVEMENTS
    // ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS material_movements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        material_id UUID REFERENCES materials(id) ON DELETE CASCADE,
        request_id UUID REFERENCES print_requests(id) ON DELETE SET NULL,
        movement_type VARCHAR(20) NOT NULL,
        quantity DECIMAL(10,2) NOT NULL,
        reference VARCHAR(100),
        notes TEXT,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query('COMMIT');
    console.log('✅ Migration V2 completed successfully.');
    console.log('New tables: workflow_statuses, feasibility_reviews, quality_checks, audit_logs, material_movements');
    console.log('New columns added to print_requests: post-processing, material tracking, due dates, archiving, planning, feasibility');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V2 failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate_v2().catch(console.error);