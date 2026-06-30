/**
 * Material Service - stock management with graceful degradation.
 * Works even if V4/V8 migration columns do not exist yet.
 */

const { sendMail } = require('./emailService');
const { createAuditLog } = require('../middleware/auditLog');
const { PRODUCTION_TECHNICIAN_ALIASES, roleSqlList } = require('../utils/roles');

const getUserName = (u = {}) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'System';

const inventoryAudit = async (client, {
  action,
  materialId,
  materialName,
  requestId,
  requestNumber,
  quantity,
  performedBy,
  performedByName,
  reason,
}) => {
  await createAuditLog({
    client,
    entityType: 'material',
    entityId: materialId,
    action,
    performedBy,
    performedByName,
    newValues: {
      material: materialName,
      quantity,
      request_id: requestId || null,
      reference: requestNumber || null,
      reason: reason || null,
    },
  });
};

let _v4ColumnsExist = null;
const checkV4Columns = async (client) => {
  if (_v4ColumnsExist !== null) return _v4ColumnsExist;
  try {
    await client.query('SELECT available_quantity FROM materials LIMIT 0');
    _v4ColumnsExist = true;
  } catch (_) {
    _v4ColumnsExist = false;
  }
  return _v4ColumnsExist;
};

let _lowStockNotifiedColumnExists = null;
const checkLowStockNotifiedColumn = async (client) => {
  if (_lowStockNotifiedColumnExists !== null) return _lowStockNotifiedColumnExists;
  try {
    await client.query('SELECT low_stock_notified_at FROM materials LIMIT 0');
    _lowStockNotifiedColumnExists = true;
  } catch (_) {
    _lowStockNotifiedColumnExists = false;
  }
  return _lowStockNotifiedColumnExists;
};

const getStockAlertRecipients = async (client) => {
  const result = await client.query(`
    SELECT id, email
    FROM users
    WHERE is_active = true
      AND role IN (${roleSqlList([...PRODUCTION_TECHNICIAN_ALIASES, 'administrator'])})
      AND email IS NOT NULL
  `);
  return result.rows;
};

const notifyLowStock = async (client, material) => {
  const recipients = await getStockAlertRecipients(client);
  if (recipients.length === 0) return;

  const available = parseFloat(material.available_quantity ?? material.stock_quantity ?? 0);
  const threshold = parseFloat(material.low_stock_threshold ?? 200);
  const unit = material.unit || 'g';
  const title = `Low Stock: ${material.name}`;
  const message = `${material.name} is below the minimum stock threshold. Available: ${available.toFixed(1)} ${unit}; threshold: ${threshold.toFixed(1)} ${unit}.`;

  for (const user of recipients) {
    await client.query(
      `INSERT INTO notifications (user_id, request_id, type, title, message)
       VALUES ($1, NULL, 'low_stock_alert', $2, $3)`,
      [user.id, title, message]
    ).catch((err) => console.error('[Material] Low stock notification failed:', err.message));
  }

  sendMail({
    to: recipients.map((u) => u.email),
    subject: title,
    text: message,
    html: `
      <p><strong>${material.name}</strong> is below the minimum stock threshold.</p>
      <p>Available: <strong>${available.toFixed(1)} ${unit}</strong><br/>
      Minimum threshold: <strong>${threshold.toFixed(1)} ${unit}</strong></p>
      <p>Please restock this material before planning new requests.</p>
    `,
  }).catch((err) => console.error('[Material] Low stock email failed:', err.message));
};

const checkMaterialLowStock = async (client, materialId) => {
  if (!materialId) return;

  const v4 = await checkV4Columns(client);
  const hasNotifiedColumn = await checkLowStockNotifiedColumn(client);
  if (!v4 || !hasNotifiedColumn) return;

  const result = await client.query(
    `SELECT id, name, unit, stock_quantity,
            COALESCE(available_quantity, stock_quantity) AS available_quantity,
            COALESCE(low_stock_threshold, 200) AS low_stock_threshold,
            low_stock_notified_at
     FROM materials
     WHERE id = $1 AND is_active = true
     FOR UPDATE`,
    [materialId]
  );
  const material = result.rows[0];
  if (!material) return;

  const available = parseFloat(material.available_quantity ?? 0);
  const threshold = parseFloat(material.low_stock_threshold ?? 200);
  const isLow = available <= threshold;
  const alreadyNotified = Boolean(material.low_stock_notified_at);

  if (isLow && !alreadyNotified) {
    await notifyLowStock(client, material);
    await client.query('UPDATE materials SET low_stock_notified_at = NOW() WHERE id = $1', [materialId]);
  } else if (!isLow && alreadyNotified) {
    await client.query('UPDATE materials SET low_stock_notified_at = NULL WHERE id = $1', [materialId]);
  }
};

const reserveMaterial = async (client, {
  requestId, materialId, spoolReference, reservedQty, performedBy, performedByName,
}) => {
  const qty = parseFloat(reservedQty);
  if (!qty || qty <= 0) return;

  const mat = await client.query(
    'SELECT id, name, stock_quantity FROM materials WHERE id = $1',
    [materialId]
  );
  if (!mat.rows[0]) throw new Error('Material not found');

  const v4 = await checkV4Columns(client);
  if (!v4) {
    console.log(`[Material] V4 columns not yet applied. Logged reservation of ${qty}g for request ${requestId}`);
    return;
  }

  const stockResult = await client.query(
    'SELECT available_quantity, reserved_quantity, stock_quantity FROM materials WHERE id = $1 FOR UPDATE',
    [materialId]
  );
  const m = stockResult.rows[0];
  const available = parseFloat(m.available_quantity ?? m.stock_quantity ?? 0);

  if (available < qty) {
    throw new Error(
      `Insufficient stock for "${mat.rows[0].name}". Requested: ${qty}g - Available: ${available}g. Please reduce quantity or restock.`
    );
  }

  await client.query(
    `UPDATE materials
     SET available_quantity = available_quantity - $1,
         reserved_quantity = COALESCE(reserved_quantity, 0) + $1
     WHERE id = $2`,
    [qty, materialId]
  );

  await client.query(
    `INSERT INTO material_reservations
       (request_id, material_id, spool_reference, reserved_qty, status,
        reserved_by, reserved_by_name)
     VALUES ($1, $2, $3, $4, 'reserved', $5, $6)
     ON CONFLICT DO NOTHING`,
    [requestId, materialId, spoolReference, qty, performedBy, performedByName]
  ).catch(() => {});

  await client.query(
    `INSERT INTO material_transactions
       (material_id, request_id, transaction_type, quantity,
        spool_reference, performed_by, performed_by_name, notes)
     VALUES ($1, $2, 'reservation', $3, $4, $5, $6, $7)`,
    [
      materialId,
      requestId,
      qty,
      spoolReference,
      performedBy,
      performedByName,
      `Reserved ${qty}g - spool ${spoolReference || 'N/A'}`,
    ]
  ).catch(() => {});

  const request = await client.query(
    'SELECT request_number FROM print_requests WHERE id = $1',
    [requestId]
  ).catch(() => ({ rows: [] }));
  await inventoryAudit(client, {
    action: 'stock_reserved',
    materialId,
    materialName: mat.rows[0].name,
    requestId,
    requestNumber: request.rows[0]?.request_number,
    quantity: qty,
    performedBy,
    performedByName,
    reason: `Reserved ${qty}g`,
  });

  await checkMaterialLowStock(client, materialId);
  console.log(`[Material] Reserved ${qty}g of "${mat.rows[0].name}" for request ${requestId}`);
};

const consumeMaterial = async (client, {
  requestId, materialId, actualConsumedQty, performedBy, performedByName,
}) => {
  if (!materialId || !actualConsumedQty) return;
  const qty = parseFloat(actualConsumedQty);
  if (!qty || qty <= 0) return;

  const v4 = await checkV4Columns(client);
  if (!v4) {
    console.log(`[Material] V4 columns not yet applied. Skipping consumption update for ${requestId}`);
    return;
  }

  const request = await client.query(
    'SELECT request_number FROM print_requests WHERE id = $1',
    [requestId]
  ).catch(() => ({ rows: [] }));

  const res = await client.query(
    `SELECT *
     FROM material_reservations
     WHERE request_id = $1 AND status = 'reserved'
     ORDER BY reserved_at ASC, id ASC
     LIMIT 1`,
    [requestId]
  ).catch(() => ({ rows: [] }));

  if (res.rows[0]) {
    const reservation = res.rows[0];
    const alreadyConsumedForReservation = await client.query(
      `SELECT id FROM material_transactions
       WHERE reservation_id = $1 AND transaction_type = 'consumption'
       LIMIT 1`,
      [reservation.id]
    ).catch(() => ({ rows: [] }));
    if (alreadyConsumedForReservation.rows[0]) return;

    const reserved = parseFloat(reservation.reserved_qty);
    const diff = reserved - qty;

    await client.query(
      `UPDATE material_reservations
       SET status = 'consumed',
           consumed_qty = $1,
           consumed_at = NOW(),
           released_qty = GREATEST(0, $2)
       WHERE id = $3`,
      [qty, diff, reservation.id]
    ).catch(() => {});

    await client.query(
      `UPDATE materials
       SET stock_quantity = GREATEST(0, stock_quantity - $1),
           available_quantity = GREATEST(0, COALESCE(available_quantity, stock_quantity) + GREATEST(0, $2)),
           reserved_quantity = GREATEST(0, COALESCE(reserved_quantity, 0) - $3)
       WHERE id = $4`,
      [qty, diff, reserved, reservation.material_id]
    );

    await client.query(
      `INSERT INTO material_transactions
         (material_id, request_id, reservation_id, transaction_type,
          quantity, performed_by, performed_by_name, notes)
       VALUES ($1, $2, $3, 'consumption', $4, $5, $6, $7)`,
      [
        reservation.material_id,
        requestId,
        reservation.id,
        qty,
        performedBy,
        performedByName,
        `Consumed ${qty}g (reserved: ${reserved}g - returned: ${Math.max(0, diff).toFixed(1)}g)`,
      ]
    ).catch(() => {});

    await inventoryAudit(client, {
      action: 'stock_consumed',
      materialId: reservation.material_id,
      requestId,
      requestNumber: request.rows[0]?.request_number,
      quantity: -qty,
      performedBy,
      performedByName,
      reason: `Consumed from reservation ${reservation.id}`,
    });

    await checkMaterialLowStock(client, reservation.material_id);
    console.log(`[Material] Consumed ${qty}g - returned ${Math.max(0, diff).toFixed(1)}g to stock`);
  } else {
    const alreadyConsumedWithoutOpenReservation = await client.query(
      `SELECT id FROM material_transactions
       WHERE request_id = $1
         AND transaction_type = 'consumption'
       LIMIT 1`,
      [requestId]
    ).catch(() => ({ rows: [] }));
    if (alreadyConsumedWithoutOpenReservation.rows[0]) return;

    const material = await client.query(
      'SELECT name FROM materials WHERE id = $1',
      [materialId]
    ).catch(() => ({ rows: [] }));

    await client.query(
      `UPDATE materials
       SET stock_quantity = GREATEST(0, stock_quantity - $1),
           available_quantity = GREATEST(0, COALESCE(available_quantity, stock_quantity) - $1)
       WHERE id = $2`,
      [qty, materialId]
    ).catch(() => {});

    await client.query(
      `INSERT INTO material_transactions
         (material_id, request_id, transaction_type, quantity,
          performed_by, performed_by_name, notes)
       VALUES ($1, $2, 'consumption', $3, $4, $5, $6)`,
      [materialId, requestId, qty, performedBy, performedByName, `Consumed ${qty}g - direct stock deduction`]
    ).catch(() => {});

    await inventoryAudit(client, {
      action: 'stock_consumed',
      materialId,
      materialName: material.rows[0]?.name,
      requestId,
      requestNumber: request.rows[0]?.request_number,
      quantity: -qty,
      performedBy,
      performedByName,
      reason: 'Direct stock deduction',
    });

    await checkMaterialLowStock(client, materialId);
    console.log(`[Material] Direct deduction ${qty}g (no prior reservation)`);
  }
};

const releaseReservation = async (client, {
  requestId, performedBy, performedByName, reason,
}) => {
  const v4 = await checkV4Columns(client);
  if (!v4) return;

  const res = await client.query(
    `SELECT *
     FROM material_reservations
     WHERE request_id = $1 AND status = 'reserved'
     LIMIT 1`,
    [requestId]
  ).catch(() => ({ rows: [] }));

  if (!res.rows[0]) return;

  const reservation = res.rows[0];
  const qty = parseFloat(reservation.reserved_qty);

  await client.query(
    `UPDATE material_reservations
     SET status = 'released',
         released_qty = $1,
         released_at = NOW()
     WHERE id = $2`,
    [qty, reservation.id]
  ).catch(() => {});

  await client.query(
    `UPDATE materials
     SET available_quantity = COALESCE(available_quantity, stock_quantity) + $1,
         reserved_quantity = GREATEST(0, COALESCE(reserved_quantity, 0) - $1)
     WHERE id = $2`,
    [qty, reservation.material_id]
  ).catch(() => {});

  await client.query(
    `INSERT INTO material_transactions
       (material_id, request_id, reservation_id, transaction_type,
        quantity, performed_by, performed_by_name, notes)
     VALUES ($1, $2, $3, 'release', $4, $5, $6, $7)`,
    [
      reservation.material_id,
      requestId,
      reservation.id,
      qty,
      performedBy,
      performedByName,
      `Reservation released - ${reason}`,
    ]
  ).catch(() => {});

  await inventoryAudit(client, {
    action: 'stock_released',
    materialId: reservation.material_id,
    requestId,
    quantity: qty,
    performedBy,
    performedByName,
    reason,
  });

  await checkMaterialLowStock(client, reservation.material_id);
  console.log(`[Material] Released ${qty}g back to stock`);
};

const releaseRemainingReservationAfterProduction = async (client, {
  requestId, performedBy, performedByName,
}) => {
  const v4 = await checkV4Columns(client);
  if (!v4) return { releasedQty: 0 };

  const reservations = await client.query(
    `SELECT mr.*, m.name AS material_name
     FROM material_reservations mr
     LEFT JOIN materials m ON m.id = mr.material_id
     WHERE mr.request_id = $1 AND mr.status = 'reserved'
     ORDER BY mr.reserved_at ASC, mr.id ASC
     FOR UPDATE OF mr`,
    [requestId]
  ).catch(() => ({ rows: [] }));

  if (!reservations.rows.length) return { releasedQty: 0 };

  const request = await client.query(
    'SELECT request_number FROM print_requests WHERE id = $1',
    [requestId]
  ).catch(() => ({ rows: [] }));

  let totalReleased = 0;
  for (const reservation of reservations.rows) {
    const qty = parseFloat(reservation.reserved_qty || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    totalReleased += qty;

    await client.query(
      `UPDATE material_reservations
       SET status = 'released',
           released_qty = $1,
           released_at = NOW(),
           notes = COALESCE(notes || E'\n', '') || $2
       WHERE id = $3`,
      [qty, 'Released at Completed Awaiting Confirmation; material was already consumed during production.', reservation.id]
    ).catch(() => {});

    await client.query(
      `UPDATE materials
       SET reserved_quantity = GREATEST(0, COALESCE(reserved_quantity, 0) - $1)
       WHERE id = $2`,
      [qty, reservation.material_id]
    ).catch(() => {});

    await client.query(
      `INSERT INTO material_transactions
         (material_id, request_id, reservation_id, transaction_type,
          quantity, performed_by, performed_by_name, notes)
       VALUES ($1, $2, $3, 'release', $4, $5, $6, $7)`,
      [
        reservation.material_id,
        requestId,
        reservation.id,
        qty,
        performedBy,
        performedByName,
        'Reservation released at Completed Awaiting Confirmation; no stock was returned or consumed.',
      ]
    ).catch(() => {});

    await inventoryAudit(client, {
      action: 'stock_released',
      materialId: reservation.material_id,
      materialName: reservation.material_name,
      requestId,
      requestNumber: request.rows[0]?.request_number,
      quantity: qty,
      performedBy,
      performedByName,
      reason: 'Reservation Released - Status: Completed Awaiting Confirmation',
    });

    await checkMaterialLowStock(client, reservation.material_id);
  }

  console.log(`[Material] Released ${totalReleased}g reserved material at Completed Awaiting Confirmation for request ${requestId}`);
  return { releasedQty: totalReleased };
};

const reserveMaterialForRequestStatus = async (client, {
  request,
  materialId,
  reservedQty,
  spoolReference,
  user,
}) => {
  if (!['planned', 'in_progress'].includes(request.status)) return;
  const targetMaterialId = materialId || request.material_id;
  const qty = parseFloat(reservedQty || request.material_reserved_qty || 0);
  if (!targetMaterialId || !qty || qty <= 0) return;

  const existing = await client.query(
    `SELECT id FROM material_reservations
     WHERE request_id = $1 AND status = 'reserved'
     LIMIT 1`,
    [request.id]
  ).catch(() => ({ rows: [] }));
  if (existing.rows[0]) return;

  await reserveMaterial(client, {
    requestId: request.id,
    materialId: targetMaterialId,
    spoolReference: spoolReference || request.material_reserved_spool,
    reservedQty: qty,
    performedBy: user?.id || null,
    performedByName: getUserName(user),
  });
};

const consumeMaterialForCompletedRequest = async (client, { request, user }) => {
  if (!['completed', 'archived'].includes(request.status)) return;
  if (!request.material_id) return;

  const openReservation = await client.query(
    `SELECT reserved_qty
     FROM material_reservations
     WHERE request_id = $1 AND status = 'reserved'
     ORDER BY reserved_at ASC, id ASC
     LIMIT 1`,
    [request.id]
  ).catch(() => ({ rows: [] }));
  if (!openReservation.rows[0]) return;

  const reservedQty = parseFloat(openReservation.rows[0].reserved_qty || 0);
  const qty = reservedQty;
  if (!qty || qty <= 0) return;

  await consumeMaterial(client, {
    requestId: request.id,
    materialId: request.material_id,
    actualConsumedQty: qty,
    performedBy: user?.id || null,
    performedByName: getUserName(user),
  });
};

module.exports = {
  reserveMaterial,
  consumeMaterial,
  releaseReservation,
  releaseRemainingReservationAfterProduction,
  reserveMaterialForRequestStatus,
  consumeMaterialForCompletedRequest,
  checkMaterialLowStock,
};
