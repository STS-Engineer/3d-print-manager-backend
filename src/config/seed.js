const db = require('./database');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const seed = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Admin user
    const adminHash = await bcrypt.hash('Admin123!', 10);
    await client.query(`
      INSERT INTO users (email, password_hash, first_name, last_name, department, role)
      VALUES
        ('admin@avocarbon.com', $1, 'Admin', 'System', 'IT', 'administrator'),
        ('wael.charaabi@avocarbon.com', $1, 'Wael', 'Charaabi', 'Industrial Engineering', 'production_technician'),
        ('salah.benachour@avocarbon.com', $1, 'Salah', 'Benachour', 'Management', 'manager'),
        ('technician@avocarbon.com', $1, 'Tech', 'Operator', 'Maintenance', 'production_technician'),
        ('requester@avocarbon.com', $1, 'Demo', 'Requester', 'Production', 'requester')
      ON CONFLICT (email) DO NOTHING;
    `, [adminHash]);

    // Printers
    await client.query(`
      INSERT INTO printers (name, model, technology, status, location)
      VALUES
        ('Printer-01', 'Prusa i3 MK3S+', 'FDM', 'available', 'Workshop A'),
        ('Printer-02', 'Bambu Lab X1C', 'FDM', 'available', 'Workshop A'),
        ('Printer-03', 'Formlabs Form 3', 'SLA', 'available', 'Workshop B'),
        ('Printer-04', 'Creality Ender 5', 'FDM', 'maintenance', 'Workshop A')
      ON CONFLICT DO NOTHING;
    `);

    // Materials
    await client.query(`
      INSERT INTO materials (name, type, color, brand, stock_quantity, unit)
      VALUES
        ('PLA Black', 'PLA', 'Black', 'Prusament', 2500, 'g'),
        ('PLA White', 'PLA', 'White', 'Prusament', 1800, 'g'),
        ('PLA Grey', 'PLA', 'Grey', 'Bambu Lab', 3000, 'g'),
        ('PETG Black', 'PETG', 'Black', 'Prusament', 1200, 'g'),
        ('ASA Grey', 'ASA', 'Grey', 'Prusament', 800, 'g'),
        ('Resin Grey', 'Resin', 'Grey', 'Formlabs', 500, 'ml')
      ON CONFLICT DO NOTHING;
    `);

    // Categories
    await client.query(`
      INSERT INTO request_categories (name, description)
      VALUES
        ('Prototype', 'Functional or visual prototype for validation'),
        ('Tooling / Jig', 'Assembly tool, fixture, or manufacturing jig'),
        ('Spare Part', 'Replacement or backup component'),
        ('Concept Model', 'Visual model for communication or review'),
        ('Production Aid', 'Supporting part used during production'),
        ('R&D Sample', 'Research and development test piece'),
        ('Other', 'Other type of request')
      ON CONFLICT DO NOTHING;
    `);

    await client.query('COMMIT');
    console.log('✅ Database seeded successfully.');
    console.log('');
    console.log('Default login credentials (password: Admin123!):');
    console.log('  admin@avocarbon.com        → Administrator');
    console.log('  wael.charaabi@avocarbon.com → Production Technician');
    console.log('  salah.benachour@avocarbon.com → Manager');
    console.log('  technician@avocarbon.com   → Production Technician');
    console.log('  requester@avocarbon.com    → Requester');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

seed().catch(console.error);
