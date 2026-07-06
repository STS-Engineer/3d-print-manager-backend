/**
 * Material Stock Controller
 * Dedicated endpoints for stock management:
 * - GET  /materials/:id/stock         → current stock details
 * - POST /materials/:id/reserve       → manual reservation
 * - POST /materials/:id/consume       → record consumption
 * - POST /materials/:id/adjust        → admin stock adjustment
 * - GET  /materials/:id/transactions  → movement history
 * - GET  /materials/stock-overview    → all materials with stock levels
 */

const db  = require('../config/database');
const {
  reserveMaterial,
  consumeMaterial,
  releaseReservation,
  syncMaterialReservationStock,
  checkMaterialLowStock,
} = require('../services/materialService');
const { createAuditLog } = require('../middleware/auditLog');

const getUserName = (u) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Unknown';

const signedQuantitySql = `
  CASE
    WHEN mt.transaction_type IN ('restock','release','stock_in') THEN mt.quantity
    WHEN mt.transaction_type IN ('reservation') THEN 0
    ELSE -mt.quantity
  END
`;

const riskCaseSql = `
  CASE
    WHEN COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200) THEN 'red'
    WHEN COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200) * 1.25 THEN 'orange'
    ELSE 'green'
  END
`;

const stockOverviewRiskCaseSql = `
  CASE
    WHEN GREATEST(0, COALESCE(m.stock_quantity, 0) - COALESCE(ar.reserved_qty, 0)) <= COALESCE(m.low_stock_threshold, 200) THEN 'red'
    WHEN GREATEST(0, COALESCE(m.stock_quantity, 0) - COALESCE(ar.reserved_qty, 0)) <= COALESCE(m.low_stock_threshold, 200) * 1.25 THEN 'orange'
    ELSE 'green'
  END
`;

const buildInventoryMaterialFilters = (query = {}, startIndex = 1, alias = 'm') => {
  const filters = [];
  const params = [];
  let i = startIndex;
  if (query.material_id) {
    filters.push(`${alias}.id = $${i++}`);
    params.push(query.material_id);
  }
  if (query.inventory_status === 'low_stock') {
    filters.push(`COALESCE(${alias}.available_quantity, ${alias}.stock_quantity, 0) <= COALESCE(${alias}.low_stock_threshold, 200)`);
  } else if (query.inventory_status === 'in_stock') {
    filters.push(`COALESCE(${alias}.available_quantity, ${alias}.stock_quantity, 0) > COALESCE(${alias}.low_stock_threshold, 200)`);
  }
  return {
    sql: filters.length ? ` AND ${filters.join(' AND ')}` : '',
    params,
  };
};

const buildInventoryTransactionFilters = (query = {}, startIndex = 1, requestAlias = 'r', txAlias = 'mt') => {
  const filters = [];
  const params = [];
  let i = startIndex;
  const add = (field, column) => {
    if (query[field]) {
      filters.push(`${requestAlias}.${column} = $${i++}`);
      params.push(query[field]);
    }
  };
  if (query.material_id) {
    filters.push(`${txAlias}.material_id = $${i++}`);
    params.push(query.material_id);
  }
  add('site_id', 'site_id');
  add('printer_id', 'printer_id');
  add('technician_id', 'assigned_technician_id');
  add('priority', 'priority');
  add('status', 'status');
  add('category_id', 'category_id');
  add('requester_id', 'requester_id');
  add('criticality', 'criticality');
  if (query.requester) {
    filters.push(`${requestAlias}.requester_name ILIKE $${i++}`);
    params.push(`%${query.requester}%`);
  }
  if (query.department) {
    filters.push(`${requestAlias}.requester_department ILIKE $${i++}`);
    params.push(`%${query.department}%`);
  }
  if (query.date_from) {
    filters.push(`${txAlias}.created_at::date >= $${i++}::date`);
    params.push(query.date_from);
  }
  if (query.date_to) {
    filters.push(`${txAlias}.created_at::date <= $${i++}::date`);
    params.push(query.date_to);
  }
  return {
    sql: filters.length ? ` AND ${filters.join(' AND ')}` : '',
    params,
  };
};

// ── GET stock overview for all materials ──────────────────────────────────────
exports.getStockOverview = async (req, res) => {
  try {
    const result = await db.query(`
      WITH consumption AS (
        SELECT material_id, COALESCE(SUM(quantity), 0) / 90.0 AS avg_daily_consumption
        FROM material_transactions
        WHERE transaction_type = 'consumption'
          AND created_at > NOW() - INTERVAL '90 days'
        GROUP BY material_id
      ),
      active_reserved AS (
        SELECT mr.material_id, COALESCE(SUM(mr.reserved_qty), 0) AS reserved_qty
        FROM material_reservations mr
        JOIN print_requests r ON r.id = mr.request_id
        WHERE mr.status = 'reserved'
          AND r.status NOT IN (
            'ready_for_pickup',
            'requester_confirmation',
            'waiting_customer_confirmation',
            'completed',
            'archived',
            'cancelled',
            'rejected'
          )
        GROUP BY mr.material_id
      )
      SELECT
        m.id, m.name, m.type, m.brand, m.color, m.unit,
        m.stock_quantity,
        GREATEST(0, COALESCE(m.stock_quantity, 0) - COALESCE(ar.reserved_qty, 0)) AS available_quantity,
        COALESCE(ar.reserved_qty, 0)                       AS reserved_quantity,
        COALESCE(m.low_stock_threshold, 200)               AS low_stock_threshold,
        CASE
          WHEN GREATEST(0, COALESCE(m.stock_quantity, 0) - COALESCE(ar.reserved_qty, 0)) <= COALESCE(m.low_stock_threshold, 200)
          THEN true ELSE false
        END AS is_low_stock,
        ${stockOverviewRiskCaseSql} AS risk_level,
        COALESCE(c.avg_daily_consumption, 0) AS avg_daily_consumption,
        CASE
          WHEN COALESCE(c.avg_daily_consumption, 0) > 0
          THEN ROUND((GREATEST(0, COALESCE(m.stock_quantity, 0) - COALESCE(ar.reserved_qty, 0))::NUMERIC / c.avg_daily_consumption)::NUMERIC, 1)
          ELSE NULL
        END AS days_of_coverage,
        COUNT(r.id) FILTER (WHERE r.status NOT IN ('completed','archived','requester_confirmation','waiting_customer_confirmation','cancelled','rejected')) AS active_requests
      FROM materials m
      LEFT JOIN consumption c ON c.material_id = m.id
      LEFT JOIN active_reserved ar ON ar.material_id = m.id
      LEFT JOIN print_requests r ON r.material_id = m.id
      WHERE m.is_active = true
      GROUP BY m.id, m.name, m.type, m.brand, m.color, m.unit,
               m.stock_quantity, m.available_quantity, m.reserved_quantity, m.low_stock_threshold,
               c.avg_daily_consumption, ar.reserved_qty
      ORDER BY is_low_stock DESC, m.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET single material stock details ─────────────────────────────────────────
exports.getMaterialStock = async (req, res) => {
  try {
    const { id } = req.params;
    const mat = await db.query(`
      WITH active_reserved AS (
        SELECT mr.material_id, COALESCE(SUM(mr.reserved_qty), 0) AS reserved_qty
        FROM material_reservations mr
        JOIN print_requests r ON r.id = mr.request_id
        WHERE mr.status = 'reserved'
          AND r.status NOT IN (
            'ready_for_pickup',
            'requester_confirmation',
            'waiting_customer_confirmation',
            'completed',
            'archived',
            'cancelled',
            'rejected'
          )
        GROUP BY mr.material_id
      )
      SELECT
        m.*,
        GREATEST(0, COALESCE(m.stock_quantity, 0) - COALESCE(ar.reserved_qty, 0)) AS available_quantity,
        COALESCE(ar.reserved_qty, 0) AS reserved_quantity
      FROM materials m
      LEFT JOIN active_reserved ar ON ar.material_id = m.id
      WHERE m.id = $1
    `, [id]);
    if (!mat.rows[0]) return res.status(404).json({ error: 'Material not found' });

    // Active reservations
    const reservations = await db.query(`
      SELECT mr.*, r.request_number, r.title
      FROM material_reservations mr
      JOIN print_requests r ON mr.request_id = r.id
      WHERE mr.material_id = $1
        AND mr.status = 'reserved'
        AND r.status NOT IN (
          'ready_for_pickup',
          'requester_confirmation',
          'waiting_customer_confirmation',
          'completed',
          'archived',
          'cancelled',
          'rejected'
        )
      ORDER BY mr.created_at DESC
    `, [id]).catch(() => ({ rows: [] }));

    res.json({
      ...mat.rows[0],
      active_reservations: reservations.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET transaction history ────────────────────────────────────────────────────
exports.getMaterialTransactions = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`
      SELECT mt.*, r.request_number
      FROM material_transactions mt
      LEFT JOIN print_requests r ON mt.request_id = r.id
      WHERE mt.material_id = $1
      ORDER BY mt.created_at DESC
      LIMIT 100
    `, [id]).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST admin stock adjustment ────────────────────────────────────────────────
exports.adjustStock = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { adjustment, reason } = req.body;

    if (!adjustment || isNaN(parseFloat(adjustment))) {
      return res.status(400).json({ error: 'adjustment (number) is required' });
    }

    const qty = parseFloat(adjustment);

    const mat = await client.query(
      'SELECT * FROM materials WHERE id = $1 FOR UPDATE', [id]
    );
    if (!mat.rows[0]) return res.status(404).json({ error: 'Material not found' });

    const m = mat.rows[0];
    const currentStock = parseFloat(m.stock_quantity || 0);
    const currentAvail = parseFloat(m.available_quantity ?? m.stock_quantity ?? 0);
    const newStock = Math.max(0, currentStock + qty);
    const newAvail = Math.max(0, currentAvail + qty);

    await client.query(
      `UPDATE materials
       SET stock_quantity     = $1,
           available_quantity = $2
       WHERE id = $3`,
      [newStock, newAvail, id]
    );
    const syncedStock = await syncMaterialReservationStock(client, id);

    // Log transaction
    await client.query(`
      INSERT INTO material_transactions
        (material_id, transaction_type, quantity, quantity_before, quantity_after,
         performed_by, performed_by_name, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      id,
      qty >= 0 ? 'restock' : 'adjustment',
      Math.abs(qty),
      currentStock,
      newStock,
      req.user.id,
      getUserName(req.user),
      reason || (qty >= 0 ? 'Manual restock' : 'Manual adjustment'),
    ]).catch(() => {});

    await createAuditLog({
      entityType: 'material', entityId: id,
      action: 'stock_adjustment',
      performedBy: req.user.id,
      performedByName: getUserName(req.user),
      oldValues: { stock_quantity: currentStock },
      newValues: { stock_quantity: newStock, adjustment: qty, reason },
    });

    await checkMaterialLowStock(client, id);

    await client.query('COMMIT');
    res.json({
      message: `Stock ${qty >= 0 ? 'increased' : 'decreased'} by ${Math.abs(qty)}${m.unit}`,
      previous_stock: currentStock,
      new_stock: newStock,
      new_available: syncedStock?.available_quantity ?? newAvail,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  } finally {
    client.release();
  }
};

// ── Recalculate stock from actual data ────────────────────────────────────────
// Recomputes available_quantity and reserved_quantity from reservations table
exports.recalculateStock = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Check if V4 columns exist
    let hasV4 = false;
    try {
      await client.query('SELECT available_quantity FROM materials LIMIT 0');
      hasV4 = true;
    } catch(_) {}

    if (!hasV4) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'V4 migration not applied. Run: npm run db:migrate:v4 first.'
      });
    }

    const released = await client.query(`
      UPDATE material_reservations mr
      SET
        status = 'released',
        released_qty = COALESCE(mr.released_qty, mr.reserved_qty),
        released_at = COALESCE(mr.released_at, NOW()),
        notes = COALESCE(mr.notes || E'\n', '') || 'Released during stock recalculation because the request is no longer in active production.'
      FROM print_requests r
      WHERE mr.request_id = r.id
        AND mr.status = 'reserved'
        AND r.status IN (
          'ready_for_pickup',
          'requester_confirmation',
          'waiting_customer_confirmation',
          'completed',
          'archived',
          'cancelled',
          'rejected'
        )
      RETURNING mr.id, mr.material_id, mr.reserved_qty
    `);

    if (released.rows.length) {
      const totalReleased = released.rows.reduce((sum, row) => sum + parseFloat(row.reserved_qty || 0), 0);
      console.log(`[Stock] Recalculate released ${totalReleased}g from ${released.rows.length} stale reservations`);
    }

    // Recalculate every material from active reservation records only.
    // Current stock is unchanged; cached available/reserved columns become projections.
    const updated = await client.query(`
      WITH active_reserved AS (
        SELECT mr.material_id, COALESCE(SUM(mr.reserved_qty), 0) AS reserved_qty
        FROM material_reservations mr
        JOIN print_requests r ON r.id = mr.request_id
        WHERE mr.status = 'reserved'
          AND r.status NOT IN (
            'ready_for_pickup',
            'requester_confirmation',
            'waiting_customer_confirmation',
            'completed',
            'archived',
            'cancelled',
            'rejected'
          )
        GROUP BY mr.material_id
      )
      UPDATE materials m
      SET
        reserved_quantity = COALESCE(ar.reserved_qty, 0),
        available_quantity = GREATEST(0, m.stock_quantity - COALESCE(ar.reserved_qty, 0))
      FROM active_reserved ar
      WHERE m.id = ar.material_id
        AND m.is_active = true
      RETURNING m.id, m.name, m.stock_quantity, m.reserved_quantity, m.available_quantity
    `);

    const cleared = await client.query(`
      UPDATE materials m
      SET
        reserved_quantity = 0,
        available_quantity = m.stock_quantity
      WHERE m.is_active = true
        AND NOT EXISTS (
          SELECT 1
          FROM material_reservations mr
          JOIN print_requests r ON r.id = mr.request_id
          WHERE mr.material_id = m.id
            AND mr.status = 'reserved'
            AND r.status NOT IN (
              'ready_for_pickup',
              'requester_confirmation',
              'waiting_customer_confirmation',
              'completed',
              'archived',
              'cancelled',
              'rejected'
            )
        )
      RETURNING m.id, m.name, m.stock_quantity, m.reserved_quantity, m.available_quantity
    `);

    const recalculatedMaterials = [...updated.rows, ...cleared.rows];

    for (const material of recalculatedMaterials) {
      await checkMaterialLowStock(client, material.id);
    }

    await client.query('COMMIT');

    res.json({
      message: 'Stock recalculated successfully',
      materials_updated: recalculatedMaterials.length,
      reservations_released: released.rows.length,
      results: recalculatedMaterials,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Stock] Recalculate error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

exports.getInventoryTransactions = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '250', 10), 1000);
    const result = await db.query(`
      SELECT
        mt.id,
        mt.created_at,
        mt.transaction_type,
        mt.quantity,
        ${signedQuantitySql} AS signed_quantity,
        mt.quantity_before,
        mt.quantity_after,
        mt.spool_reference,
        mt.performed_by_name,
        mt.notes,
        m.name AS material_name,
        m.type AS material_type,
        m.unit,
        r.request_number,
        COALESCE(r.request_number, mt.spool_reference, mt.notes) AS reference
      FROM material_transactions mt
      LEFT JOIN materials m ON mt.material_id = m.id
      LEFT JOIN print_requests r ON mt.request_id = r.id
      ORDER BY mt.created_at DESC
      LIMIT $1
    `, [limit]).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch (err) {
    console.error('[Inventory] Transactions error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getInventoryAnalytics = async (req, res) => {
  try {
    const materialFilter = buildInventoryMaterialFilters(req.query);
    const txFilter = buildInventoryTransactionFilters(req.query);
    const txAfterMaterialFilter = buildInventoryTransactionFilters(req.query, materialFilter.params.length + 1);
    const materialAfterTxFilter = buildInventoryMaterialFilters(req.query, txFilter.params.length + 1);
    const [
      kpis,
      missingCostMaterials,
      mostConsumed,
      byMonth,
      byType,
      bySite,
      lowStock,
      forecast,
    ] = await Promise.all([
      db.query(`
        WITH coverage AS (
          SELECT
            m.id,
            COALESCE(m.available_quantity, m.stock_quantity, 0) AS available_quantity,
            COALESCE(m.reserved_quantity, 0) AS reserved_quantity,
            CASE
              WHEN COALESCE(m.cost_per_unit, 0) > 0
              THEN COALESCE(m.stock_quantity, 0) * m.cost_per_unit
              ELSE 0
            END AS inventory_value,
            COALESCE(SUM(mt.quantity) FILTER (
              WHERE mt.transaction_type = 'consumption'
                AND mt.created_at > NOW() - INTERVAL '90 days'
            ), 0) / 90.0 AS avg_daily_consumption
          FROM materials m
          LEFT JOIN material_transactions mt ON mt.material_id = m.id
          WHERE m.is_active = true
            ${materialFilter.sql}
          GROUP BY m.id, m.available_quantity, m.stock_quantity, m.reserved_quantity, m.cost_per_unit
        )
        SELECT
          COUNT(*) AS total_materials,
          COUNT(*) FILTER (WHERE available_quantity <= COALESCE((SELECT low_stock_threshold FROM materials WHERE id = coverage.id), 200)) AS low_stock_materials,
          COALESCE(SUM(reserved_quantity), 0) AS reserved_material_quantity,
          COALESCE((
            SELECT SUM(mt.quantity)
            FROM material_transactions mt
            LEFT JOIN print_requests r ON mt.request_id = r.id
            WHERE mt.transaction_type = 'consumption'
              AND mt.created_at >= DATE_TRUNC('month', NOW())
              ${txAfterMaterialFilter.sql}
          ), 0) AS consumed_material_this_month,
          COALESCE(SUM(inventory_value), 0) AS inventory_value,
          ROUND(AVG(CASE WHEN avg_daily_consumption > 0 THEN available_quantity / avg_daily_consumption ELSE NULL END)::NUMERIC, 1) AS average_days_of_coverage
        FROM coverage
      `, [...materialFilter.params, ...txAfterMaterialFilter.params]).catch(() => ({ rows: [{}] })),
      db.query(`
        SELECT id, name, COALESCE(stock_quantity, 0) AS stock_quantity, cost_per_unit
        FROM materials
        WHERE is_active = true
          ${materialFilter.sql}
          AND COALESCE(stock_quantity, 0) > 0
          AND COALESCE(cost_per_unit, 0) <= 0
        ORDER BY name
      `, materialFilter.params).catch(() => ({ rows: [] })),
      db.query(`
        SELECT m.name AS material, m.unit, COALESCE(SUM(mt.quantity), 0) AS consumed
        FROM material_transactions mt
        JOIN materials m ON mt.material_id = m.id
        LEFT JOIN print_requests r ON mt.request_id = r.id
        WHERE mt.transaction_type = 'consumption'
          AND mt.created_at > NOW() - INTERVAL '90 days'
          ${txFilter.sql}
          ${materialAfterTxFilter.sql}
        GROUP BY m.id, m.name, m.unit
        ORDER BY consumed DESC
        LIMIT 10
      `, [...txFilter.params, ...materialAfterTxFilter.params]).catch(() => ({ rows: [] })),
      db.query(`
        SELECT DATE_TRUNC('month', mt.created_at)::DATE AS month, COALESCE(SUM(mt.quantity), 0) AS consumed
        FROM material_transactions mt
        JOIN materials m ON mt.material_id = m.id
        LEFT JOIN print_requests r ON mt.request_id = r.id
        WHERE mt.transaction_type = 'consumption'
          AND mt.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '11 months'
          ${txFilter.sql}
          ${materialAfterTxFilter.sql}
        GROUP BY DATE_TRUNC('month', mt.created_at)
        ORDER BY month
      `, [...txFilter.params, ...materialAfterTxFilter.params]).catch(() => ({ rows: [] })),
      db.query(`
        SELECT COALESCE(m.type, 'Unknown') AS material_type, COALESCE(SUM(mt.quantity), 0) AS consumed
        FROM material_transactions mt
        JOIN materials m ON mt.material_id = m.id
        LEFT JOIN print_requests r ON mt.request_id = r.id
        WHERE mt.transaction_type = 'consumption'
          ${txFilter.sql}
          ${materialAfterTxFilter.sql}
        GROUP BY COALESCE(m.type, 'Unknown')
        ORDER BY consumed DESC
      `, [...txFilter.params, ...materialAfterTxFilter.params]).catch(() => ({ rows: [] })),
      db.query(`
        SELECT COALESCE(s.name, 'Unassigned') AS site, COALESCE(SUM(mt.quantity), 0) AS consumed
        FROM material_transactions mt
        JOIN materials m ON mt.material_id = m.id
        LEFT JOIN print_requests r ON mt.request_id = r.id
        LEFT JOIN sites s ON r.site_id = s.id
        WHERE mt.transaction_type = 'consumption'
          ${txFilter.sql}
          ${materialAfterTxFilter.sql}
        GROUP BY COALESCE(s.name, 'Unassigned')
        ORDER BY consumed DESC
      `, [...txFilter.params, ...materialAfterTxFilter.params]).catch(() => ({ rows: [] })),
      db.query(`
        SELECT m.id, m.name AS material, m.type, m.unit,
               COALESCE(m.stock_quantity, 0) AS stock_quantity,
               COALESCE(m.reserved_quantity, 0) AS reserved_quantity,
               COALESCE(m.available_quantity, m.stock_quantity, 0) AS available_quantity,
               COALESCE(m.low_stock_threshold, 200) AS low_stock_threshold,
               ${riskCaseSql} AS risk_level
        FROM materials m
        WHERE m.is_active = true
          ${materialFilter.sql}
          AND COALESCE(m.available_quantity, m.stock_quantity, 0) <= COALESCE(m.low_stock_threshold, 200)
        ORDER BY available_quantity ASC, m.name
      `, materialFilter.params).catch(() => ({ rows: [] })),
      db.query(`
        WITH avg_usage AS (
          SELECT material_id, COALESCE(SUM(quantity), 0) / 90.0 AS avg_daily_usage
          FROM material_transactions
          WHERE transaction_type = 'consumption'
            AND created_at > NOW() - INTERVAL '90 days'
          GROUP BY material_id
        )
        SELECT m.name AS material, m.unit,
               COALESCE(m.available_quantity, m.stock_quantity, 0) AS available_quantity,
               COALESCE(a.avg_daily_usage, 0) AS avg_daily_usage,
               CASE WHEN COALESCE(a.avg_daily_usage, 0) > 0
                    THEN ROUND((COALESCE(m.available_quantity, m.stock_quantity, 0)::NUMERIC / a.avg_daily_usage)::NUMERIC, 1)
                    ELSE NULL
               END AS days_of_coverage
        FROM materials m
        LEFT JOIN avg_usage a ON a.material_id = m.id
        WHERE m.is_active = true
          ${materialFilter.sql}
        ORDER BY days_of_coverage ASC NULLS LAST, m.name
      `, materialFilter.params).catch(() => ({ rows: [] })),
    ]);

    if (missingCostMaterials.rows.length > 0) {
      console.warn('[Inventory] Material Cost Missing', missingCostMaterials.rows.map(m => ({
        id: m.id,
        name: m.name,
        stock_quantity: m.stock_quantity,
      })));
    }

    res.json({
      kpis: kpis.rows[0] || {},
      mostConsumed: mostConsumed.rows,
      consumptionByMonth: byMonth.rows,
      consumptionByMaterialType: byType.rows,
      consumptionBySite: bySite.rows,
      lowStockAlerts: lowStock.rows,
      materialForecast: forecast.rows,
    });
  } catch (err) {
    console.error('[Inventory] Analytics error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};
