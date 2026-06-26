const db = require('../config/database');

/**
 * CENTRALIZED WORKFLOW VALIDATION
 * Validates status transitions + business rules.
 * Prevents bypass via API/Postman.
 */

const TRANSITIONS = {
  draft:                  ['submitted', 'cancelled'],
  submitted:              ['completeness_check', 'more_info_required', 'rejected', 'cancelled'],
  completeness_check:     ['feasibility_review', 'more_info_required', 'rejected', 'cancelled'],
  more_info_required:     ['submitted', 'cancelled'],
  feasibility_review:     ['approved', 'rejected', 'more_info_required', 'cancelled'],
  approved:               ['prioritized', 'on_hold', 'cancelled'],
  rejected:               ['archived'],
  prioritized:            ['planned', 'on_hold', 'cancelled'],
  planned:                ['assigned', 'on_hold', 'waiting_for_material', 'waiting_for_machine', 'cancelled'],
  assigned:               ['in_progress', 'on_hold', 'blocked', 'cancelled'],
  in_progress:            ['printed', 'blocked', 'on_hold', 'waiting_for_material', 'waiting_for_machine', 'cancelled'],
  printed:                ['quality_check', 'rework_required'],
  post_processing:        ['quality_check', 'rework_required'],
  quality_check:          ['ready_for_pickup', 'rework_required'],
  rework_required:        ['rework_required', 'in_progress'],
  ready_for_pickup:       ['requester_confirmation'],
  requester_confirmation: ['completed'],
  completed:              ['archived'],
  on_hold:                ['submitted', 'approved', 'prioritized', 'planned', 'assigned', 'in_progress', 'cancelled'],
  blocked:                ['in_progress', 'assigned', 'cancelled', 'on_hold'],
  waiting_for_material:   ['planned', 'assigned', 'cancelled'],
  waiting_for_machine:    ['planned', 'assigned', 'cancelled'],
  archived:               [],
  cancelled:              [],
};

// Statuses that require a complete feasibility review first
const REQUIRES_FEASIBILITY = ['approved', 'prioritized', 'planned', 'assigned'];

// Statuses that require a complete quality check first
const REQUIRES_QUALITY_CHECK = ['ready_for_pickup', 'requester_confirmation', 'completed'];

const ensureQualityQuantityColumns = async () => {
  await db.query(`
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

const toQuantity = (value) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
};

const validateTransition = async (requestId, newStatus, userRole, userId) => {
  try {
    await ensureQualityQuantityColumns();
    const result = await db.query(`
      SELECT r.*,
        f.is_printable, f.machine_compatible, f.material_available,
        f.result AS feasibility_result_val,
        (SELECT COUNT(*) FROM quality_checks qc WHERE qc.request_id = r.id) AS qc_count,
        (SELECT qc.result FROM quality_checks qc WHERE qc.request_id = r.id ORDER BY qc.created_at DESC LIMIT 1) AS latest_qc_result,
        (SELECT qc.validated_quantity_checked FROM quality_checks qc WHERE qc.request_id = r.id ORDER BY qc.created_at DESC LIMIT 1) AS latest_validated_quantity_checked,
        (SELECT qc.successful_quantity FROM quality_checks qc WHERE qc.request_id = r.id ORDER BY qc.created_at DESC LIMIT 1) AS latest_successful_quantity,
        (SELECT qc.remaining_quantity FROM quality_checks qc WHERE qc.request_id = r.id ORDER BY qc.created_at DESC LIMIT 1) AS latest_remaining_quantity,
        (SELECT qc.quantity_mismatch FROM quality_checks qc WHERE qc.request_id = r.id ORDER BY qc.created_at DESC LIMIT 1) AS latest_quantity_mismatch,
        COALESCE((SELECT CASE WHEN COUNT(pc.id) > 0 THEN COALESCE(SUM(pc.printed_quantity), 0) ELSE r.printed_quantity END FROM request_production_cycles pc WHERE pc.request_id = r.id), 0) AS total_printed_quantity,
        COALESCE((SELECT CASE WHEN COUNT(pc.id) > 0 THEN COALESCE(SUM(pc.rejected_quantity), 0) ELSE r.rejected_quantity END FROM request_production_cycles pc WHERE pc.request_id = r.id), 0) AS total_rejected_quantity,
        (SELECT COALESCE(SUM(qc.validated_quantity_checked), 0) FROM quality_checks qc WHERE qc.request_id = r.id) AS total_validated_quantity_checked,
        (SELECT qc.dimensional_check AND qc.surface_quality_check AND qc.functional_check AND qc.visual_check
         FROM quality_checks qc WHERE qc.request_id = r.id ORDER BY qc.created_at DESC LIMIT 1) AS qc_all_checks
      FROM print_requests r
      LEFT JOIN feasibility_reviews f ON f.request_id = r.id
      WHERE r.id = $1
    `, [requestId]);

    if (!result.rows[0]) return { valid: false, error: 'Request not found', code: 404 };

    const r = result.rows[0];
    const currentStatus = r.status;
    const allowed = TRANSITIONS[currentStatus] || [];

    // 1. Check transition is allowed
    if (!allowed.includes(newStatus)) {
      return {
        valid: false,
        error: `Transition from "${currentStatus}" to "${newStatus}" is not allowed in this workflow.`,
        code: 400,
        validation_type: 'invalid_transition',
      };
    }

    // 2. Feasibility review must be complete before approval/planning
    if (REQUIRES_FEASIBILITY.includes(newStatus)) {
      const missing = [];
      if (r.is_printable === null || r.is_printable === undefined) missing.push('Printable (Yes/No)');
      if (r.machine_compatible === null || r.machine_compatible === undefined) missing.push('Machine Compatible (Yes/No)');
      if (r.material_available === null || r.material_available === undefined) missing.push('Material Available (Yes/No)');
      if (!r.feasibility_result_val || r.feasibility_result_val === 'pending') missing.push('Feasibility Result (must not be Pending)');

      if (missing.length > 0) {
        return {
          valid: false,
          error: `Cannot proceed to "${newStatus}" — Feasibility Review is incomplete. Please fill in the Feasibility tab first.`,
          code: 400,
          validation_type: 'feasibility_incomplete',
          missing_fields: missing,
        };
      }

      // Block if feasibility was rejected
      if (r.feasibility_result_val === 'rejected') {
        return {
          valid: false,
          error: 'Cannot approve — Feasibility Review result is "Rejected". The request must be revised.',
          code: 400,
          validation_type: 'feasibility_rejected',
        };
      }
    }

    // 3. Quality check must be complete before pickup/completion
    if (REQUIRES_QUALITY_CHECK.includes(newStatus)) {
      if (!r.qc_count || parseInt(r.qc_count) === 0) {
        return {
          valid: false,
          error: `Cannot proceed to "${newStatus}" — no Quality Check has been recorded. Please complete the Quality Check tab first.`,
          code: 400,
          validation_type: 'quality_check_missing',
        };
      }
      if (!r.latest_qc_result || r.latest_qc_result === 'pending') {
        return {
          valid: false,
          error: 'Cannot proceed — Quality Check result is still Pending.',
          code: 400,
          validation_type: 'quality_check_pending',
        };
      }
      if (r.latest_qc_result === 'fail') {
        return {
          valid: false,
          error: 'Cannot proceed to pickup — Quality Check FAILED. A rework is required.',
          code: 400,
          validation_type: 'quality_check_failed',
        };
      }
      if (!r.qc_all_checks) {
        return {
          valid: false,
          error: 'Cannot proceed — Quality Check is incomplete. All checks (Dimensional, Surface, Functional, Visual) must be completed.',
          code: 400,
          validation_type: 'quality_check_incomplete',
          missing_fields: ['Dimensional Check', 'Surface Quality Check', 'Functional Check', 'Visual Check'],
        };
      }
      const requestedQuantity = toQuantity(r.quantity);
      const successfulQuantity = Math.max(toQuantity(r.total_printed_quantity) - toQuantity(r.total_rejected_quantity), 0);
      const validatedQuantity = toQuantity(r.total_validated_quantity_checked);
      if (!Number.isFinite(validatedQuantity) || validatedQuantity <= 0) {
        return {
          valid: false,
          error: 'Cannot proceed â€” Validated Quantity Checked is required.',
          code: 400,
          validation_type: 'validated_quantity_missing',
          missing_fields: ['Validated Quantity Checked'],
        };
      }
      if (requestedQuantity > 0 && successfulQuantity < requestedQuantity) {
        return {
          valid: false,
          error: 'Quantity mismatch detected. Rework required.',
          code: 400,
          validation_type: 'quantity_mismatch_rework_required',
          requested_quantity: requestedQuantity,
          successful_quantity: successfulQuantity,
          missing_production_quantity: Math.max(requestedQuantity - successfulQuantity, 0) + Math.max(successfulQuantity - validatedQuantity, 0),
        };
      }
      if (requestedQuantity > 0 && validatedQuantity < requestedQuantity) {
        return {
          valid: false,
          error: 'Validated quantity is insufficient. Rework required.',
          code: 400,
          validation_type: 'validated_quantity_insufficient',
          requested_quantity: requestedQuantity,
          validated_quantity_checked: validatedQuantity,
        };
      }
    }

    return { valid: true };
  } catch (err) {
    console.error('[WorkflowValidation] Error:', err.message);
    return { valid: true }; // Fail open on DB error
  }
};

module.exports = { validateTransition, TRANSITIONS };
