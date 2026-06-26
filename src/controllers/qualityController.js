const getUserName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Unknown';

const db = require('../config/database');
const { createAuditLog } = require('../middleware/auditLog');

const toQuantity = (value) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
};

const publicDbError = (err) => {
  if (!err) return 'Server error';
  return err.detail || err.message || 'Server error';
};

const ensureQualityQuantityColumns = async (clientOrDb = db) => {
  await clientOrDb.query(`
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

    ALTER TABLE quality_checks
      ADD COLUMN IF NOT EXISTS validated_quantity_checked INTEGER,
      ADD COLUMN IF NOT EXISTS successful_quantity INTEGER,
      ADD COLUMN IF NOT EXISTS remaining_quantity INTEGER,
      ADD COLUMN IF NOT EXISTS quantity_mismatch BOOLEAN DEFAULT false;
  `);
};

const ensureRequestQualityColumns = async (clientOrDb = db) => {
  await clientOrDb.query(`
    ALTER TABLE print_requests
      ADD COLUMN IF NOT EXISTS quality_result VARCHAR(50),
      ADD COLUMN IF NOT EXISTS quality_notes TEXT,
      ADD COLUMN IF NOT EXISTS rework_required BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS rework_reason TEXT;
  `);
};

const calculateMissingProductionQuantity = (requestedQuantity, totalSuccessfulQuantity, totalValidatedQuantity) => (
  Math.max(requestedQuantity - totalSuccessfulQuantity, 0)
  + Math.max(totalSuccessfulQuantity - totalValidatedQuantity, 0)
);

const getQualityQuantityTotals = async (client, requestId, currentValidatedQuantity = 0) => {
  const production = await client.query(
    `SELECT
       CASE WHEN COUNT(pc.id) > 0 THEN COALESCE(SUM(pc.printed_quantity), 0) ELSE COALESCE(MAX(r.printed_quantity), 0) END AS total_printed_quantity,
       CASE WHEN COUNT(pc.id) > 0 THEN COALESCE(SUM(pc.rejected_quantity), 0) ELSE COALESCE(MAX(r.rejected_quantity), 0) END AS total_rejected_quantity
     FROM print_requests r
     LEFT JOIN request_production_cycles pc ON pc.request_id = r.id
     WHERE r.id = $1`,
    [requestId]
  ).catch(() => ({ rows: [{}] }));

  const quality = await client.query(
    `SELECT COALESCE(SUM(validated_quantity_checked), 0) AS previous_validated_quantity
     FROM quality_checks
     WHERE request_id = $1`,
    [requestId]
  ).catch(() => ({ rows: [{}] }));

  const totalPrintedQuantity = toQuantity(production.rows[0]?.total_printed_quantity);
  const totalRejectedQuantity = toQuantity(production.rows[0]?.total_rejected_quantity);
  const totalSuccessfulQuantity = Math.max(totalPrintedQuantity - totalRejectedQuantity, 0);
  const totalValidatedQuantity = toQuantity(quality.rows[0]?.previous_validated_quantity) + toQuantity(currentValidatedQuantity);

  return {
    totalPrintedQuantity,
    totalRejectedQuantity,
    totalSuccessfulQuantity,
    totalValidatedQuantity,
  };
};

// GET all quality checks for a request
exports.getQualityChecks = async (req, res) => {
  try {
    const { id } = req.params;
    await ensureQualityQuantityColumns();
    const result = await db.query(
      `SELECT qc.*, u.email AS checker_email
       FROM quality_checks qc
       LEFT JOIN users u ON qc.checked_by = u.id
       WHERE qc.request_id = $1
       ORDER BY qc.created_at DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[Quality] Read failed:', err);
    res.status(500).json({ error: publicDbError(err) });
  }
};

// CREATE quality check
exports.createQualityCheck = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const {
      result, dimensional_check, surface_quality_check,
      functional_check, visual_check, comments, deviation_notes,
      validated_quantity_checked,
    } = req.body;

    if (!result) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Result is required' });
    }

    if (validated_quantity_checked === undefined || validated_quantity_checked === null || validated_quantity_checked === '') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Validated Quantity Checked is required.',
        validation_type: 'validated_quantity_missing',
      });
    }

    await ensureQualityQuantityColumns(client);
    await ensureRequestQualityColumns(client);

    const previous = await client.query(
      'SELECT status, quality_result, quality_notes, quantity, printed_quantity, rejected_quantity FROM print_requests WHERE id = $1',
      [id]
    );
    const request = previous.rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found' });
    }

    const requestedQuantity = toQuantity(request.quantity);
    const validatedQuantity = toQuantity(validated_quantity_checked);
    const totals = await getQualityQuantityTotals(client, id, validatedQuantity);
    const missingProductionQuantity = calculateMissingProductionQuantity(
      requestedQuantity,
      totals.totalSuccessfulQuantity,
      totals.totalValidatedQuantity
    );
    const quantityMismatch = requestedQuantity > 0 && (
      totals.totalSuccessfulQuantity < requestedQuantity
      || totals.totalValidatedQuantity < requestedQuantity
    );
    const effectiveResult = quantityMismatch ? 'fail' : result;

    const qc = await client.query(`
      INSERT INTO quality_checks
        (request_id, checked_by, checked_by_name, result,
         dimensional_check, surface_quality_check, functional_check,
         visual_check, validated_quantity_checked, successful_quantity,
         remaining_quantity, quantity_mismatch, comments, deviation_notes)
      VALUES ($1,$2,$3,$4,$5::boolean,$6::boolean,$7::boolean,$8::boolean,$9,$10,$11,$12,$13,$14) RETURNING *
    `, [
      id, req.user.id, getUserName(req.user),
      effectiveResult,
      dimensional_check === true || dimensional_check === 'true',
      surface_quality_check === true || surface_quality_check === 'true',
      functional_check === true || functional_check === 'true',
      visual_check === true || visual_check === 'true',
      validatedQuantity,
      totals.totalSuccessfulQuantity,
      missingProductionQuantity,
      quantityMismatch,
      comments, deviation_notes,
    ]);

    // Update request quality fields
    await client.query(`
      UPDATE print_requests SET
        quality_result = $1::varchar(50),
        quality_notes = $2,
        status = CASE WHEN $1::varchar = 'fail' THEN 'rework_required'::varchar(80) ELSE status END,
        rework_required = CASE WHEN $1::varchar = 'fail' THEN true ELSE false END,
        rework_reason = CASE WHEN $1::varchar = 'fail' THEN COALESCE($4::text, $2::text, rework_reason) ELSE rework_reason END
      WHERE id = $3
    `, [effectiveResult, comments, id, deviation_notes]);

    if (effectiveResult === 'fail') {
      await client.query(
        `INSERT INTO status_history (request_id, from_status, to_status, changed_by, changed_by_name, comment)
         VALUES ($1, $2, 'rework_required', $3, $4, $5)`,
        [id, request.status, req.user.id, getUserName(req.user), 'Quality Check failed. Rework required.']
      );
    }

    await createAuditLog({
      client,
      entityType: 'quality_check', entityId: id,
      action: 'create',
      performedBy: req.user.id,
      performedByName: getUserName(req.user),
      oldValues: previous.rows[0] ? {
        quality_result: previous.rows[0].quality_result,
        quality_notes: previous.rows[0].quality_notes,
      } : null,
      newValues: {
        quality_result: effectiveResult,
        quality_notes: comments,
        status: effectiveResult === 'fail' ? 'rework_required' : undefined,
        rework_required: effectiveResult === 'fail' ? true : false,
        dimensional_check: dimensional_check === true || dimensional_check === 'true',
        surface_quality_check: surface_quality_check === true || surface_quality_check === 'true',
        functional_check: functional_check === true || functional_check === 'true',
        visual_check: visual_check === true || visual_check === 'true',
        validated_quantity_checked: validatedQuantity,
        total_printed_quantity: totals.totalPrintedQuantity,
        total_rejected_quantity: totals.totalRejectedQuantity,
        successful_quantity: totals.totalSuccessfulQuantity,
        total_validated_quantity_checked: totals.totalValidatedQuantity,
        missing_production_quantity: missingProductionQuantity,
        quantity_mismatch: quantityMismatch,
        deviation_notes,
      },
    });

    await client.query('COMMIT');
    res.status(201).json(qc.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Quality] Save failed:', err);
    res.status(500).json({ error: publicDbError(err) });
  } finally {
    client.release();
  }
};
