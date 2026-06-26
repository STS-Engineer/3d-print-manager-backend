const db = require('./database');
require('dotenv').config();

const createTables = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // USERS
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        department VARCHAR(100),
        role VARCHAR(50) NOT NULL DEFAULT 'requester',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // PRINTERS
    await client.query(`
      CREATE TABLE IF NOT EXISTS printers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        model VARCHAR(100),
        technology VARCHAR(50),
        status VARCHAR(50) DEFAULT 'available',
        location VARCHAR(100),
        notes TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // MATERIALS
    await client.query(`
      CREATE TABLE IF NOT EXISTS materials (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        type VARCHAR(50),
        color VARCHAR(50),
        brand VARCHAR(100),
        stock_quantity DECIMAL(10,2) DEFAULT 0,
        unit VARCHAR(20) DEFAULT 'g',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // REQUEST CATEGORIES
    await client.query(`
      CREATE TABLE IF NOT EXISTS request_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT true
      );
    `);

    // SITES
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

    // PRINT REQUESTS
    await client.query(`
      CREATE TABLE IF NOT EXISTS print_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_number VARCHAR(20) UNIQUE NOT NULL,

        -- Identification
        title VARCHAR(255) NOT NULL,
        requester_id UUID REFERENCES users(id) ON DELETE SET NULL,
        requester_name VARCHAR(200),
        requester_department VARCHAR(100),
        project_reference VARCHAR(100),
        customer_reference VARCHAR(100),
        site_id UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,

        -- Description
        purpose TEXT,
        part_description TEXT,
        quantity INTEGER DEFAULT 1,
        functional_requirement TEXT,
        visual_requirement TEXT,
        category_id UUID REFERENCES request_categories(id) ON DELETE SET NULL,
        criticality VARCHAR(50) DEFAULT 'normal',
        use_environment TEXT,

        -- Technical data
        dimensions VARCHAR(200),
        scale VARCHAR(50),
        tolerance VARCHAR(100),
        surface_finish VARCHAR(100),
        strength_requirement TEXT,
        color_preference VARCHAR(100),
        material_preference VARCHAR(100),
        infill_percentage INTEGER,
        layer_height DECIMAL(4,2),
        orientation TEXT,

        -- Planning & Priority
        priority VARCHAR(50) DEFAULT 'normal',
        priority_reason TEXT,
        requested_due_date TIMESTAMPTZ,
        approved_due_date DATE,
        estimated_printing_time DECIMAL(8,2),
        estimated_post_processing_time DECIMAL(8,2),
        estimated_total_lead_time DECIMAL(8,2),
        price_per_kg DECIMAL(10,2),
        estimated_cost DECIMAL(10,2),
        actual_cost DECIMAL(10,2),

        -- Execution
        assigned_technician_id UUID REFERENCES users(id) ON DELETE SET NULL,
        printer_id UUID REFERENCES printers(id) ON DELETE SET NULL,
        material_id UUID REFERENCES materials(id) ON DELETE SET NULL,
        batch_reference VARCHAR(100),
        actual_start_time TIMESTAMPTZ,
        actual_end_time TIMESTAMPTZ,
        actual_duration DECIMAL(8,2),
        post_processing_details TEXT,
        quality_result VARCHAR(50),
        quality_notes TEXT,
        scrap_count INTEGER DEFAULT 0,
        rework_required BOOLEAN DEFAULT false,
        rework_reason TEXT,

        -- Closure
        completion_date TIMESTAMPTZ,
        delivery_confirmation BOOLEAN DEFAULT false,
        requester_confirmation BOOLEAN DEFAULT false,
        lessons_learned TEXT,
        archive_date TIMESTAMPTZ,

        -- Status & Workflow
        status VARCHAR(80) DEFAULT 'draft',
        rejection_reason TEXT,
        blocking_reason TEXT,
        on_hold_reason TEXT,
        cancellation_reason TEXT,

        -- Timestamps
        submitted_at TIMESTAMPTZ,
        validated_at TIMESTAMPTZ,
        approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // REQUEST ATTACHMENTS
    await client.query(`
      CREATE TABLE IF NOT EXISTS request_attachments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID REFERENCES print_requests(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        file_type VARCHAR(50),
        file_size INTEGER,
        file_path VARCHAR(500) NOT NULL,
        uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
        uploaded_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // STATUS HISTORY
    await client.query(`
      CREATE TABLE IF NOT EXISTS status_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID REFERENCES print_requests(id) ON DELETE CASCADE,
        from_status VARCHAR(80),
        to_status VARCHAR(80) NOT NULL,
        changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        changed_by_name VARCHAR(200),
        comment TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // NOTIFICATIONS
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        request_id UUID REFERENCES print_requests(id) ON DELETE CASCADE,
        type VARCHAR(100) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // COMMENTS
    await client.query(`
      CREATE TABLE IF NOT EXISTS request_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID REFERENCES print_requests(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        user_name VARCHAR(200),
        content TEXT NOT NULL,
        is_internal BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_requests_status ON print_requests(status);
      CREATE INDEX IF NOT EXISTS idx_requests_requester ON print_requests(requester_id);
      CREATE INDEX IF NOT EXISTS idx_requests_technician ON print_requests(assigned_technician_id);
      CREATE INDEX IF NOT EXISTS idx_requests_priority ON print_requests(priority);
      CREATE INDEX IF NOT EXISTS idx_requests_due_date ON print_requests(approved_due_date);
      CREATE INDEX IF NOT EXISTS idx_requests_created ON print_requests(created_at);
      CREATE INDEX IF NOT EXISTS idx_requests_site ON print_requests(site_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
      CREATE INDEX IF NOT EXISTS idx_status_history_request ON status_history(request_id);
    `);

    // Auto-update updated_at trigger
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ language 'plpgsql';

      DROP TRIGGER IF EXISTS update_print_requests_updated_at ON print_requests;
      CREATE TRIGGER update_print_requests_updated_at
        BEFORE UPDATE ON print_requests
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

      DROP TRIGGER IF EXISTS update_users_updated_at ON users;
      CREATE TRIGGER update_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);

    await client.query('COMMIT');
    console.log('✅ Database migration completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

createTables().catch(console.error);
