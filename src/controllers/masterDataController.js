const db = require('../config/database');
const bcrypt = require('bcryptjs');
const { createAuditLog } = require('../middleware/auditLog');
const { checkMaterialLowStock } = require('../services/materialService');
const { normalizeRole } = require('../utils/roles');

const validCurrency = (value) => /^[A-Z]{3}$/.test(String(value || '').trim());
const positiveNumber = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0;
};
const actorName = (user) => [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || user.id;

// USERS
exports.getUsers = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, first_name, last_name, department, role, is_active, created_at FROM users ORDER BY first_name'
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.createUser = async (req, res) => {
  try {
    const { email, password, first_name, last_name, department, role } = req.body;
    const hash = await bcrypt.hash(password || 'ChangeMe123!', 10);
    const result = await db.query(`
      INSERT INTO users (email, password_hash, first_name, last_name, department, role)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, first_name, last_name, department, role
    `, [email.toLowerCase(), hash, first_name, last_name, department, normalizeRole(role || 'requester')]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, department, role, is_active, new_password } = req.body;

    // Admin can reset password without old password
    if (new_password) {
      const bcrypt = require('bcryptjs');
      if (new_password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      const hash = await bcrypt.hash(new_password, 10);
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
    }

    const result = await db.query(`
      UPDATE users SET
        first_name  = COALESCE($1, first_name),
        last_name   = COALESCE($2, last_name),
        department  = COALESCE($3, department),
        role        = COALESCE($4, role),
        is_active   = COALESCE($5, is_active)
      WHERE id = $6
      RETURNING id, email, first_name, last_name, department, role, is_active
    `, [first_name, last_name, department, role ? normalizeRole(role) : role, is_active, id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
};

// Admin: delete user (soft-delete — set inactive)
exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    // Prevent deleting yourself
    if (id === req.user.id)
      return res.status(400).json({ error: 'Cannot delete your own account' });
    await db.query('UPDATE users SET is_active = false WHERE id = $1', [id]);
    res.json({ message: 'User deactivated' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

// PRINTERS
exports.getPrinters = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.*, s.name AS site_name
      FROM printers p
      LEFT JOIN sites s ON p.site_id = s.id
      WHERE p.is_active = true
      ORDER BY p.name
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.createPrinter = async (req, res) => {
  try {
    const {
      name, model, technology, status, location, notes,
      serial_number, site_id, total_operating_hours,
      last_maintenance_date, next_maintenance_date,
      maintenance_interval_hours, maintenance_interval_days,
      cost_per_minute, print_speed, setup_factor, efficiency_factor,
    } = req.body;
    if (cost_per_minute !== undefined && cost_per_minute !== '' && !positiveNumber(cost_per_minute)) {
      return res.status(400).json({ error: 'Cost per minute must be greater than zero.' });
    }
    if (print_speed !== undefined && print_speed !== '' && !positiveNumber(print_speed)) {
      return res.status(400).json({ error: 'Print speed must be greater than zero.' });
    }
    if (setup_factor !== undefined && setup_factor !== '' && !positiveNumber(setup_factor)) {
      return res.status(400).json({ error: 'Setup factor must be greater than zero.' });
    }
    if (efficiency_factor !== undefined && efficiency_factor !== '' && !positiveNumber(efficiency_factor)) {
      return res.status(400).json({ error: 'Efficiency factor must be greater than zero.' });
    }
    const result = await db.query(`
      INSERT INTO printers (
        name, model, technology, status, location, notes,
        serial_number, site_id, total_operating_hours,
        last_maintenance_date, next_maintenance_date,
        maintenance_interval_hours, maintenance_interval_days, cost_per_minute,
        print_speed, setup_factor, efficiency_factor
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 0), $10, $11, COALESCE($12, 500), COALESCE($13, 90), COALESCE($14, 0.05), $15, $16, $17)
      RETURNING *
    `, [
      name, model, technology, status || 'available', location, notes,
      serial_number, site_id || null, total_operating_hours || 0,
      last_maintenance_date || null, next_maintenance_date || null,
      maintenance_interval_hours || 500, maintenance_interval_days || 90, cost_per_minute || null,
      print_speed || null, setup_factor || null, efficiency_factor || null,
    ]);
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.updatePrinter = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, model, technology, status, location, notes, is_active,
      serial_number, site_id, total_operating_hours,
      last_maintenance_date, next_maintenance_date,
      maintenance_interval_hours, maintenance_interval_days, cost_per_minute,
      print_speed, setup_factor, efficiency_factor,
    } = req.body;
    if (cost_per_minute !== undefined && cost_per_minute !== '' && !positiveNumber(cost_per_minute)) {
      return res.status(400).json({ error: 'Cost per minute must be greater than zero.' });
    }
    if (print_speed !== undefined && print_speed !== '' && !positiveNumber(print_speed)) {
      return res.status(400).json({ error: 'Print speed must be greater than zero.' });
    }
    if (setup_factor !== undefined && setup_factor !== '' && !positiveNumber(setup_factor)) {
      return res.status(400).json({ error: 'Setup factor must be greater than zero.' });
    }
    if (efficiency_factor !== undefined && efficiency_factor !== '' && !positiveNumber(efficiency_factor)) {
      return res.status(400).json({ error: 'Efficiency factor must be greater than zero.' });
    }
    const before = await db.query('SELECT * FROM printers WHERE id = $1', [id]);
    const result = await db.query(`
      UPDATE printers SET name = COALESCE($1,name), model = COALESCE($2,model),
        technology = COALESCE($3,technology), status = COALESCE($4,status),
        location = COALESCE($5,location), notes = COALESCE($6,notes),
        is_active = COALESCE($7,is_active),
        serial_number = COALESCE($8, serial_number),
        site_id = COALESCE($9, site_id),
        total_operating_hours = COALESCE($10, total_operating_hours),
        last_maintenance_date = COALESCE($11, last_maintenance_date),
        next_maintenance_date = COALESCE($12, next_maintenance_date),
        maintenance_interval_hours = COALESCE($13, maintenance_interval_hours),
        maintenance_interval_days = COALESCE($14, maintenance_interval_days),
        cost_per_minute = COALESCE($15, cost_per_minute),
        print_speed = COALESCE($16, print_speed),
        setup_factor = COALESCE($17, setup_factor),
        efficiency_factor = COALESCE($18, efficiency_factor)
      WHERE id = $19 RETURNING *
    `, [
      name, model, technology, status, location, notes, is_active,
      serial_number, site_id || null, total_operating_hours,
      last_maintenance_date || null, next_maintenance_date || null,
      maintenance_interval_hours, maintenance_interval_days, cost_per_minute || null,
      print_speed || null, setup_factor || null, efficiency_factor || null, id,
    ]);
    if (before.rows[0] && cost_per_minute !== undefined && String(before.rows[0].cost_per_minute) !== String(result.rows[0].cost_per_minute)) {
      await createAuditLog({
        entityType: 'printer',
        entityId: id,
        action: 'printer_cost_updated',
        performedBy: req.user.id,
        performedByName: [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || req.user.email,
        oldValues: { cost_per_minute: before.rows[0].cost_per_minute },
        newValues: { cost_per_minute: result.rows[0].cost_per_minute, printer: result.rows[0].name },
      });
    }
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.deletePrinter = async (req, res) => {
  try {
    const { id } = req.params;
    const inUse = await db.query(
      `SELECT COUNT(*) FROM print_requests WHERE printer_id = $1 AND status NOT IN ('completed','archived','requester_confirmation','cancelled')`,
      [id]
    );
    if (parseInt(inUse.rows[0].count) > 0)
      return res.status(400).json({ error: 'Cannot delete — printer has active jobs' });
    await db.query('UPDATE printers SET is_active = false WHERE id = $1', [id]);
    res.json({ message: 'Printer removed' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

// MATERIALS
exports.getMaterials = async (req, res) => {
  try {
    const result = await db.query(`
      WITH consumption AS (
        SELECT material_id, COALESCE(SUM(quantity), 0) / 90.0 AS avg_daily_consumption
        FROM material_transactions
        WHERE transaction_type = 'consumption'
          AND created_at > NOW() - INTERVAL '90 days'
        GROUP BY material_id
      )
      SELECT m.*,
        COALESCE(m.available_quantity, m.stock_quantity, 0) AS available_quantity,
        COALESCE(m.reserved_quantity, 0) AS reserved_quantity,
        CASE
          WHEN COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200) THEN true
          ELSE false
        END AS is_low_stock,
        CASE
          WHEN COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200) THEN 'red'
          WHEN COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200) * 1.25 THEN 'orange'
          ELSE 'green'
        END AS risk_level,
        COALESCE(c.avg_daily_consumption, 0) AS avg_daily_consumption,
        CASE
          WHEN COALESCE(c.avg_daily_consumption, 0) > 0
          THEN ROUND((COALESCE(m.available_quantity, m.stock_quantity, 0)::NUMERIC / c.avg_daily_consumption)::NUMERIC, 1)
          ELSE NULL
        END AS days_of_coverage
      FROM materials m
      LEFT JOIN consumption c ON c.material_id = m.id
      WHERE m.is_active = true
      ORDER BY is_low_stock DESC, m.name
    `).catch(() => db.query('SELECT * FROM materials WHERE is_active = true ORDER BY name'));
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.createMaterial = async (req, res) => {
  try {
    const { name, type, color, brand, stock_quantity, unit, low_stock_threshold, cost_per_unit, currency, density_g_cm3 } = req.body;
    if (cost_per_unit !== undefined && cost_per_unit !== '' && !positiveNumber(cost_per_unit)) {
      return res.status(400).json({ error: 'Cost per unit must be greater than zero.' });
    }
    if (density_g_cm3 !== undefined && density_g_cm3 !== '' && !positiveNumber(density_g_cm3)) {
      return res.status(400).json({ error: 'Density must be greater than zero.' });
    }
    if (currency !== undefined && currency !== '' && !validCurrency(currency)) {
      return res.status(400).json({ error: 'Currency must be a valid 3-letter code such as EUR.' });
    }
    const initialStock = stock_quantity || 0;
    const result = await db.query(`
      INSERT INTO materials
        (name, type, color, brand, stock_quantity, available_quantity, unit, low_stock_threshold, cost_per_unit, currency, density_g_cm3)
      VALUES ($1, $2, $3, $4, $5, $5, $6, $7, COALESCE($8, 0.025), COALESCE($9, 'EUR'), $10)
      RETURNING *
    `, [name, type, color, brand, initialStock, unit || 'g', low_stock_threshold || 200, cost_per_unit || null, currency || null, density_g_cm3 || null]);
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.updateMaterial = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, color, brand, stock_quantity, unit, is_active, low_stock_threshold, cost_per_unit, currency, density_g_cm3 } = req.body;
    if (cost_per_unit !== undefined && cost_per_unit !== '' && !positiveNumber(cost_per_unit)) {
      return res.status(400).json({ error: 'Cost per unit must be greater than zero.' });
    }
    if (currency !== undefined && currency !== '' && !validCurrency(currency)) {
      return res.status(400).json({ error: 'Currency must be a valid 3-letter code such as EUR.' });
    }
    if (density_g_cm3 !== undefined && density_g_cm3 !== '' && !positiveNumber(density_g_cm3)) {
      return res.status(400).json({ error: 'Density must be greater than zero.' });
    }
    const before = await db.query('SELECT * FROM materials WHERE id = $1', [id]);
    const threshold = low_stock_threshold === '' ? null : low_stock_threshold;
    const result = await db.query(`
      UPDATE materials SET name = COALESCE($1,name), type = COALESCE($2,type),
        color = COALESCE($3,color), brand = COALESCE($4,brand),
        stock_quantity = COALESCE($5,stock_quantity),
        available_quantity = COALESCE($5, stock_quantity),
        unit = COALESCE($6,unit),
        is_active = COALESCE($7,is_active),
        low_stock_threshold = COALESCE($8, low_stock_threshold),
        cost_per_unit = COALESCE($9, cost_per_unit),
        currency = COALESCE($10, currency),
        density_g_cm3 = COALESCE($11, density_g_cm3)
      WHERE id = $12 RETURNING *
    `, [name, type, color, brand, stock_quantity, unit, is_active, threshold, cost_per_unit || null, currency || null, density_g_cm3 || null, id]);
    if (before.rows[0] && low_stock_threshold !== undefined && String(before.rows[0].low_stock_threshold) !== String(result.rows[0].low_stock_threshold)) {
      await createAuditLog({
        entityType: 'material',
        entityId: id,
        action: 'threshold_changed',
        performedBy: req.user.id,
        performedByName: [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || req.user.email,
        oldValues: { low_stock_threshold: before.rows[0].low_stock_threshold },
        newValues: { low_stock_threshold: result.rows[0].low_stock_threshold, material: result.rows[0].name },
      });
    }
    if (before.rows[0] && (
      (cost_per_unit !== undefined && String(before.rows[0].cost_per_unit) !== String(result.rows[0].cost_per_unit)) ||
      (currency !== undefined && String(before.rows[0].currency) !== String(result.rows[0].currency))
    )) {
      await createAuditLog({
        entityType: 'material',
        entityId: id,
        action: 'material_cost_updated',
        performedBy: req.user.id,
        performedByName: [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || req.user.email,
        oldValues: {
          cost_per_unit: before.rows[0].cost_per_unit,
          currency: before.rows[0].currency,
        },
        newValues: {
          cost_per_unit: result.rows[0].cost_per_unit,
          currency: result.rows[0].currency,
          material: result.rows[0].name,
        },
      });
    }
    await checkMaterialLowStock(db, id);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.deleteMaterial = async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('UPDATE materials SET is_active = false WHERE id = $1', [id]);
    res.json({ message: 'Material removed' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

// CATEGORIES
exports.getCategories = async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true' && req.user?.role === 'administrator';
    const result = await db.query(`
      SELECT * FROM request_categories
      ${includeInactive ? '' : 'WHERE is_active = true'}
      ORDER BY is_active DESC, name
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.createCategory = async (req, res) => {
  try {
    const { name, description, is_active } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });
    const result = await db.query(
      'INSERT INTO request_categories (name, description, is_active) VALUES ($1, $2, COALESCE($3, true)) RETURNING *',
      [name.trim(), description, is_active]
    );
    await createAuditLog({
      entityType: 'category',
      entityId: result.rows[0].id,
      action: 'Category Created',
      performedBy: req.user.id,
      performedByName: actorName(req.user),
      newValues: result.rows[0],
      ipAddress: req.ip,
    });
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, is_active } = req.body;
    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const before = await db.query('SELECT * FROM request_categories WHERE id = $1', [id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Category not found' });

    const result = await db.query(`
      UPDATE request_categories SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        is_active = COALESCE($3, is_active)
      WHERE id = $4
      RETURNING *
    `, [name !== undefined ? String(name).trim() : null, description, is_active, id]);

    const action = before.rows[0].is_active && result.rows[0].is_active === false
      ? 'Category Disabled'
      : 'Category Updated';
    await createAuditLog({
      entityType: 'category',
      entityId: id,
      action,
      performedBy: req.user.id,
      performedByName: actorName(req.user),
      oldValues: before.rows[0],
      newValues: result.rows[0],
      ipAddress: req.ip,
    });

    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const before = await db.query('SELECT * FROM request_categories WHERE id = $1', [id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Category not found' });

    const usage = await db.query('SELECT COUNT(*) FROM print_requests WHERE category_id = $1', [id]);
    if (parseInt(usage.rows[0].count || 0, 10) > 0) {
      return res.status(409).json({
        error: 'This category is currently used by existing requests.',
        canDisable: true,
      });
    }

    await db.query('DELETE FROM request_categories WHERE id = $1', [id]);
    await createAuditLog({
      entityType: 'category',
      entityId: id,
      action: 'Category Deleted',
      performedBy: req.user.id,
      performedByName: actorName(req.user),
      oldValues: before.rows[0],
      ipAddress: req.ip,
    });
    res.json({ message: 'Category deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

// SITES
exports.getSites = async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM sites WHERE is_active = true ORDER BY name');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.createSite = async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Site name is required' });

    const result = await db.query(
      'INSERT INTO sites (name, description) VALUES ($1, $2) RETURNING *',
      [name.trim(), description]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Site already exists' });
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateSite = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, is_active } = req.body;
    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ error: 'Site name is required' });
    }

    const result = await db.query(`
      UPDATE sites SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        is_active = COALESCE($3, is_active),
        updated_at = NOW()
      WHERE id = $4
      RETURNING *
    `, [name ? name.trim() : null, description, is_active, id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Site not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Site already exists' });
    res.status(500).json({ error: 'Server error' });
  }
};

exports.deleteSite = async (req, res) => {
  try {
    const { id } = req.params;
    const activeSites = await db.query('SELECT COUNT(*) FROM sites WHERE is_active = true');
    if (parseInt(activeSites.rows[0].count) <= 1) {
      return res.status(400).json({ error: 'At least one active site is required' });
    }

    const result = await db.query(
      'UPDATE sites SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id',
      [id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Site not found' });
    res.json({ message: 'Site removed' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

// WORKFLOW STATUSES (configurable)
exports.getWorkflowStatuses = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM workflow_statuses WHERE is_active = true ORDER BY sort_order'
    );
    res.json(result.rows);
  } catch (err) {
    // Table may not exist yet (before migrate_v2)
    res.json([]);
  }
};

// BLOCKING REASONS CATALOG
exports.getBlockingReasons = async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM blocking_reasons WHERE is_active = true ORDER BY category, label"
    );
    res.json(result.rows);
  } catch (err) {
    // Table may not exist before migrate_v3
    res.json([]);
  }
};
