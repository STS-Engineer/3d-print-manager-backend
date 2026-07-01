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
const USER_DELETE_BLOCKED_FALLBACK_MESSAGE = 'This user has historical data and cannot be deleted. Please deactivate the account instead.';
const USER_REFERENCE_LABELS = {
  audit_logs: 'Audit Logs',
  feasibility_reviews: 'Feasibility Reviews',
  file_download_logs: 'File Download Logs',
  material_movements: 'Material Movements',
  material_reservations: 'Material Reservations',
  material_transactions: 'Material Transactions',
  monday_import_history: 'Monday Import History',
  notifications: 'Notifications',
  print_requests: 'Print Requests',
  printer_maintenance_events: 'Printer Maintenance Events',
  quality_checks: 'Quality Checks',
  request_comments: 'Request Comments',
  request_production_cycles: 'Production Cycles',
  status_history: 'Status History',
};

const safeIdentifier = (value) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
};

const safeQualifiedIdentifier = (value) => value.split('.').map(safeIdentifier).join('.');
const safeColumn = (columnName, alias = 't') => `${alias}.${safeIdentifier(columnName)}`;

const tableKey = (tableName) => tableName.includes('.') ? tableName.split('.').pop() : tableName;
const hasColumn = (columns, columnName) => columns.includes(columnName);

const humanizeTableName = (tableName) => {
  const key = tableKey(tableName);
  if (USER_REFERENCE_LABELS[key]) return USER_REFERENCE_LABELS[key];
  return key
    .split('_')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

const buildUserDeleteBlockedMessage = (references, totalReferences) => {
  const lines = references.flatMap(ref => [
    `• ${humanizeTableName(ref.table)} (${ref.count})`,
    `  Example: ${ref.example || ref.fallbackExample || 'Record unavailable'}`,
    '',
  ]);
  return [
    'This user cannot be deleted because historical data still references this account.',
    '',
    'References found:',
    '',
    ...lines,
    `Total References: ${totalReferences}`,
    '',
    'Recommended Action',
    '',
    'Deactivate this account from:',
    '',
    'Administration -> Users',
    '',
    'Historical records must remain linked to the original user for traceability.',
    '',
    'Physical deletion is only permitted for users with no historical references.',
  ].join('\n');
};

const buildCoalesceExpression = (parts, fallback) => `COALESCE(${[...parts, fallback].join(', ')})`;

const getExampleConfig = (tableName, columns) => {
  const key = tableKey(tableName);
  const joins = [];
  const parts = [];
  const fallback = hasColumn(columns, 'id') ? `${safeColumn('id')}::text` : `'Record unavailable'`;
  const addColumn = (columnName) => {
    if (hasColumn(columns, columnName)) parts.push(`NULLIF(${safeColumn(columnName)}::text, '')`);
  };
  const addRequestJoin = () => {
    if (hasColumn(columns, 'request_id')) {
      joins.push('LEFT JOIN print_requests r ON r.id = t.request_id');
      parts.push("NULLIF(r.request_number::text, '')");
    }
  };

  switch (key) {
    case 'print_requests':
      addColumn('request_number');
      addColumn('title');
      break;
    case 'quality_checks':
      addRequestJoin();
      parts.push(`'Quality Check ' || ${fallback}`);
      break;
    case 'request_production_cycles':
      if (hasColumn(columns, 'cycle_number')) parts.push(`'Cycle #' || ${safeColumn('cycle_number')}::text`);
      addRequestJoin();
      break;
    case 'feasibility_reviews':
      addRequestJoin();
      addColumn('result');
      break;
    case 'request_comments':
      parts.push(`'Comment ' || ${fallback}`);
      break;
    case 'audit_logs':
      addColumn('action');
      break;
    case 'notifications':
      addColumn('title');
      addColumn('type');
      break;
    case 'material_transactions':
      addRequestJoin();
      addColumn('spool_reference');
      addColumn('transaction_type');
      break;
    case 'material_movements':
      addRequestJoin();
      addColumn('reference');
      addColumn('movement_type');
      break;
    case 'material_reservations':
      addRequestJoin();
      addColumn('spool_reference');
      addColumn('status');
      break;
    case 'printer_maintenance_events':
      if (hasColumn(columns, 'maintenance_type') && hasColumn(columns, 'maintenance_date')) {
        parts.push(`${safeColumn('maintenance_type')}::text || ' maintenance on ' || ${safeColumn('maintenance_date')}::text`);
      }
      parts.push(`'Maintenance Event ' || ${fallback}`);
      break;
    case 'status_history':
      if (hasColumn(columns, 'to_status')) parts.push(`'Status changed to ' || ${safeColumn('to_status')}::text`);
      addColumn('from_status');
      break;
    case 'file_download_logs':
      if (hasColumn(columns, 'attachment_id')) {
        joins.push('LEFT JOIN request_attachments a ON a.id = t.attachment_id');
        parts.push("NULLIF(a.original_name::text, '')");
        parts.push("NULLIF(a.file_name::text, '')");
      }
      addRequestJoin();
      break;
    case 'monday_import_history':
      addColumn('file_name');
      break;
    case 'request_attachments':
      addColumn('original_name');
      addColumn('file_name');
      break;
    case 'notification_history':
      addColumn('subject');
      addColumn('type');
      break;
    case 'request_satisfaction_surveys':
      addRequestJoin();
      if (hasColumn(columns, 'overall_rating')) parts.push(`'Satisfaction rating ' || ${safeColumn('overall_rating')}::text`);
      break;
    default:
      ['request_number', 'title', 'subject', 'name', 'file_name', 'original_name', 'reference', 'action', 'type', 'status'].forEach(addColumn);
      addRequestJoin();
      break;
  }

  return {
    joins: [...new Set(joins)].join(' '),
    expression: buildCoalesceExpression(parts, fallback),
  };
};

const getOrderExpression = (columns) => {
  const orderColumns = ['created_at', 'updated_at', 'check_date', 'review_date', 'downloaded_at', 'reserved_at', 'maintenance_date'];
  const found = orderColumns.find(columnName => hasColumn(columns, columnName));
  const fallback = hasColumn(columns, 'id') ? `${safeColumn('id')} ASC` : '1';
  return found ? `${safeColumn(found)} DESC NULLS LAST, ${fallback}` : fallback;
};

const getUserReferenceCounts = async (userId) => {
  const references = await db.query(`
    SELECT
      c.conrelid::regclass::text AS table_name,
      a.attname AS column_name,
      ARRAY(
        SELECT ca.attname
        FROM pg_attribute ca
        WHERE ca.attrelid = c.conrelid
          AND ca.attnum > 0
          AND NOT ca.attisdropped
      ) AS columns
    FROM pg_constraint c
    JOIN unnest(c.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
    JOIN unnest(c.confkey) WITH ORDINALITY AS fk(attnum, ord) ON ck.ord = fk.ord
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck.attnum
    JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = fk.attnum
    WHERE c.contype = 'f'
      AND c.confrelid = 'users'::regclass
      AND fa.attname = 'id'
    ORDER BY table_name, column_name
  `);

  const referencesByTable = references.rows.reduce((acc, ref) => {
    if (!acc[ref.table_name]) {
      acc[ref.table_name] = {
        table: ref.table_name,
        columns: ref.columns || [],
        referenceColumns: [],
      };
    }
    if (!acc[ref.table_name].referenceColumns.includes(ref.column_name)) {
      acc[ref.table_name].referenceColumns.push(ref.column_name);
    }
    return acc;
  }, {});

  const counts = [];
  for (const ref of Object.values(referencesByTable)) {
    const tableName = ref.table;
    const columns = ref.columns || [];
    const example = getExampleConfig(tableName, columns);
    const where = ref.referenceColumns.map(columnName => `${safeColumn(columnName)} = $1`).join(' OR ');
    const count = await db.query(
      `
        SELECT COUNT(*) OVER()::int AS count, ${example.expression} AS example
        FROM ${safeQualifiedIdentifier(tableName)} t
        ${example.joins}
        WHERE ${where}
        ORDER BY ${getOrderExpression(columns)}
        LIMIT 1
      `,
      [userId]
    );
    counts.push({
      table: tableName,
      columns: ref.referenceColumns,
      count: count.rows[0]?.count || 0,
      example: count.rows[0]?.example || null,
    });
  }

  return counts;
};

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

// Admin: physically delete only users with no historical references.
exports.deleteUser = async (req, res) => {
  const { id } = req.params;
  console.info('[Admin] User delete requested', { userId: id, requestedBy: req.user?.id });

  try {
    // Prevent deleting yourself
    if (id === req.user.id) {
      console.warn('[Admin] User deletion blocked: self-delete attempt', { userId: id });
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const before = await db.query('SELECT id, email, first_name, last_name FROM users WHERE id = $1', [id]);
    if (!before.rows[0]) {
      console.warn('[Admin] User deletion failed: user not found', { userId: id });
      return res.status(404).json({ error: 'User not found' });
    }

    const referenceCounts = await getUserReferenceCounts(id);
    const blockingReferencesByTable = referenceCounts.reduce((acc, ref) => {
      if (ref.count > 0) {
        if (!acc[ref.table]) acc[ref.table] = { table: ref.table, count: 0, examples: [] };
        acc[ref.table].count += ref.count;
        if (ref.example) acc[ref.table].examples.push(ref.example);
      }
      return acc;
    }, {});
    const blockingReferences = Object.values(blockingReferencesByTable)
      .map(ref => ({
        table: ref.table,
        count: ref.count,
        example: ref.examples[0] || null,
      }))
      .sort((a, b) => humanizeTableName(a.table).localeCompare(humanizeTableName(b.table)));
    const totalReferences = blockingReferences.reduce((sum, ref) => sum + ref.count, 0);

    if (blockingReferences.length > 0) {
      console.warn('[Admin] User deletion blocked: historical data exists', {
        userId: id,
        blockingTables: blockingReferences,
        totalReferences,
      });
      return res.status(409).json({
        error: buildUserDeleteBlockedMessage(blockingReferences, totalReferences),
        blockingTables: blockingReferences,
        totalReferences,
      });
    }

    const result = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (!result.rows[0]) {
      console.warn('[Admin] User deletion failed: user not found during delete', { userId: id });
      return res.status(404).json({ error: 'User not found' });
    }

    console.info('[Admin] User deletion succeeded', { userId: id });
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('[Admin] User deletion SQL error', {
      userId: id,
      code: err.code,
      detail: err.detail,
      message: err.message,
    });

    if (err.code === '23503') {
      return res.status(409).json({ error: USER_DELETE_BLOCKED_FALLBACK_MESSAGE });
    }

    res.status(500).json({ error: 'Server error' });
  }
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
