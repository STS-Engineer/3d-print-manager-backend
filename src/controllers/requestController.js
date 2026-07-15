const db = require('../config/database');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { validateTransition } = require('../services/workflowValidation');
const {
  reserveMaterial,
  consumeMaterial,
  releaseReservation,
  releaseRemainingReservationAfterProduction,
  consumeMaterialForCompletedRequest,
} = require('../services/materialService');
const { sendRequesterStatusEmail, REQUESTER_STATUS_EMAILS } = require('../services/emailService');
const { recordNotificationHistory } = require('../services/notificationHistoryService');
const { ensureSatisfactionTable } = require('../services/satisfactionService');
const { createAuditLog } = require('../middleware/auditLog');
const { PRODUCTION_TECHNICIAN, PRODUCTION_TECHNICIAN_ALIASES, roleSqlList } = require('../utils/roles');
const {
  getConfiguredRates,
  calculateConfiguredCost,
} = require('../services/costCalculationService');
const { uploadDir } = require('../config/uploadStorage');

// Safe user name helper
const getUserName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Unknown User';

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const publicDbError = (err) => err?.detail || err?.message || 'Server error';
const isDev = process.env.NODE_ENV !== 'production';
const devLog = (...args) => {
  if (isDev) console.log(...args);
};
const nullIfBlank = (value) => value === '' ? null : value;
const isAdministrator = (user) => user?.role === 'administrator';
const normalizeRequestPayload = (body = {}) => ({
  ...body,
  category_id: nullIfBlank(body.category_id),
  requested_due_date: nullIfBlank(body.requested_due_date),
  site_id: nullIfBlank(body.site_id),
  material_id: nullIfBlank(body.material_id),
  printer_id: nullIfBlank(body.printer_id),
  material_reserved_qty: nullIfBlank(body.material_reserved_qty),
  price_per_kg: nullIfBlank(body.price_per_kg),
});

const ensureRequestFormColumns = async (client) => {
  await client.query(`
    ALTER TABLE print_requests
      ADD COLUMN IF NOT EXISTS project_reference VARCHAR(100),
      ADD COLUMN IF NOT EXISTS customer_reference VARCHAR(100),
      ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS requested_due_date TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS material_id UUID REFERENCES materials(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS printer_id UUID REFERENCES printers(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS material_reserved_qty DECIMAL(10,2),
      ADD COLUMN IF NOT EXISTS price_per_kg DECIMAL(10,2);
  `);
};

const calculatePlannedDurationHours = (startTime, endTime) => {
  if (!startTime || !endTime) return null;
  const start = new Date(startTime);
  const end = new Date(endTime);
  const hours = (end.getTime() - start.getTime()) / 3600000;
  return Number.isFinite(hours) ? hours : null;
};

const calculatePlannedEndDate = (startTime, totalPrintTimeMinutes) => {
  const minutes = parseFloat(totalPrintTimeMinutes);
  if (!startTime || !Number.isFinite(minutes) || minutes <= 0) return null;
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + (minutes * 60000)).toISOString();
};

const REQUESTER_EMAIL_STATUSES = new Set([
  'requester_confirmation',
  'awaiting_requester_confirmation',
  'more_info_required',
  'info_required',
  'rejected',
]);

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());

const buildRequestUrl = (requestId) => {
  const baseUrl = process.env.FRONTEND_URL || process.env.APP_URL || process.env.CLIENT_URL;
  if (!baseUrl || !requestId) return null;
  return `${baseUrl.replace(/\/$/, '')}/requests/${requestId}`;
};

const getNotificationStatus = (mailResult) => {
  if (mailResult?.skipped) return 'skipped';
  return 'success';
};

const notifyActorOfEmailResult = async (client, {
  actorId,
  requestId,
  status,
  recipientEmail,
  reason,
}) => {
  if (!actorId) return;
  const sent = status === 'success';
  const title = sent ? 'Email notification sent' : 'Email notification not sent';
  const recipientText = recipientEmail ? ` Recipient: ${recipientEmail}.` : '';
  const reasonText = reason ? ` Reason: ${reason}.` : '';
  await client.query(
    `INSERT INTO notifications (user_id, request_id, type, title, message)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      actorId,
      requestId,
      sent ? 'requester_email_sent' : 'requester_email_failed',
      title,
      `${title} for requester.${recipientText}${reasonText}`,
    ]
  ).catch((err) => console.error('[Email] Failed to create email result notification:', err.message));
};

const processRequesterStatusEmailJob = async ({
  requestId,
  requesterId,
  requesterUser,
  requesterUserId,
  requesterEmail,
  requestNumber,
  status,
  subject,
  notificationType,
  updatedRequest,
  previousRequest,
  actorId,
  infoRequiredReason,
  comment,
  rejectionReason,
}) => {
  let emailStatus = 'failed';
  let emailReason = null;
  let providerMessageId = null;

  try {
    if (!requesterId) {
      emailStatus = 'skipped';
      emailReason = 'missing_requester_id';
      console.warn('[Email] Requester notification skipped: missing requester_id.', {
        requestId,
        requestNumber,
        status,
      });
    } else if (!requesterUser) {
      emailStatus = 'skipped';
      emailReason = 'requester_user_not_found';
      console.warn('[Email] Requester notification skipped: requester user not found.', {
        requestId,
        requestNumber,
        requesterId,
        status,
      });
    } else if (requesterUser.status !== 'Active') {
      emailStatus = 'skipped';
      emailReason = 'requester_user_inactive';
      console.log('[Email] Email skipped for inactive user.', {
        userId: requesterUser.id,
        email: requesterEmail || null,
        notificationType,
        date: new Date().toISOString(),
      });
    } else if (!isValidEmail(requesterEmail)) {
      emailStatus = 'skipped';
      emailReason = 'missing_or_invalid_requester_email';
      console.warn('[Email] Requester notification skipped: requester email missing or invalid.', {
        requestId,
        requestNumber,
        requesterId,
        recipient: requesterEmail || null,
        status,
      });
    } else {
      const mailResult = await sendRequesterStatusEmail({
        status,
        to: requesterUser,
        requestNumber,
        partTitle: updatedRequest.title || previousRequest.title,
        completionDate: updatedRequest.completion_date || updatedRequest.ready_at || new Date(),
        requestUrl: buildRequestUrl(requestId),
        productionComments: infoRequiredReason || comment || updatedRequest.info_required_reason || previousRequest.info_required_reason,
        rejectionReason: rejectionReason || comment || updatedRequest.rejection_reason || previousRequest.rejection_reason,
      });
      emailStatus = getNotificationStatus(mailResult);
      emailReason = mailResult?.reason || null;
      providerMessageId = mailResult?.messageId || null;

      if (emailStatus === 'success') {
        console.log('[Email] Requester notification sent.', {
          requestId,
          requestNumber,
          recipient: requesterEmail,
          status,
          messageId: providerMessageId,
        });
      } else {
        console.warn('[Email] Requester notification skipped.', {
          requestId,
          requestNumber,
          recipient: requesterEmail,
          status,
          reason: emailReason || 'unknown',
        });
      }
    }
  } catch (emailErr) {
    emailStatus = 'failed';
    emailReason = emailErr.message;
    console.error('[Email Notification Failed]', {
      requestId,
      requestNumber,
      recipient: requesterEmail,
      status,
      reason: emailErr.message,
    });
  }

  await recordNotificationHistory(db, {
    requestId,
    recipientUserId: requesterUserId,
    recipientEmail: requesterEmail,
    type: notificationType,
    subject,
    status: emailStatus,
    reason: emailReason,
    providerMessageId,
    metadata: {
      requestNumber,
      workflowStatus: status,
      actorId,
    },
  });

  await notifyActorOfEmailResult(db, {
    actorId,
    requestId,
    status: emailStatus,
    recipientEmail: requesterEmail,
    reason: emailReason,
  });
};

const addNumber = (value) => ({
  __op: 'add_number',
  value,
});

const AUDIT_REQUEST_FIELDS = [
  'request_number','title','status','priority','priority_reason',
  'requested_due_date','approved_due_date','planned_start_date','planned_end_date',
  'assigned_technician_id','printer_id','material_id','batch_reference',
  'quantity','printed_quantity','rejected_quantity','reprint_quantity','final_quantity',
  'production_material_usage_per_part','production_print_time_per_part_minutes',
  'production_total_material_usage','production_total_print_time_minutes',
  'material_reserved_qty','material_reserved_spool','material_used_grams',
  'actual_start_time','actual_end_time','actual_duration',
  'price_per_kg','actual_cost','lead_time_hours',
  'quality_result','quality_notes','qc_reference','scrap_count',
  'rework_required','rework_reason','rejection_reason','blocking_reason',
  'on_hold_reason','cancellation_reason','info_required_reason',
  'business_impact','production_stop_risk','reception_comment','reception_condition',
  'requester_confirmation','reception_confirmed_by','reception_confirmed_at',
  'completion_date','archive_date','lessons_learned',
];

const STATUS_AUDIT_ACTIONS = {
  draft: 'request_created',
  submitted: 'request_submitted',
  completeness_check: 'completeness_check',
  feasibility_review: 'feasibility_review',
  approved: 'request_approved',
  rejected: 'request_rejected',
  prioritized: 'request_prioritized',
  planned: 'request_planned',
  assigned: 'request_assigned',
  in_progress: 'production_started',
  printed: 'request_printed',
  quality_check: 'quality_check_started',
  rework_required: 'rework_required',
  requester_confirmation: 'waiting_customer_confirmation',
  completed: 'request_completed',
  archived: 'request_archived',
  cancelled: 'request_cancelled',
  blocked: 'request_blocked',
  on_hold: 'request_on_hold',
  more_info_required: 'more_info_required',
};

const normalizeAuditValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
};

const valuesEqualForAudit = (a, b) => {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (a instanceof Date || b instanceof Date) {
    const da = new Date(a);
    const db = new Date(b);
    return !Number.isNaN(da.getTime()) && !Number.isNaN(db.getTime()) && da.getTime() === db.getTime();
  }
  return String(a) === String(b);
};

const buildAuditDiff = (before = {}, after = {}, fields = AUDIT_REQUEST_FIELDS, extras = {}) => {
  const oldValues = {};
  const newValues = {};
  fields.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(before, field) && !Object.prototype.hasOwnProperty.call(after, field)) return;
    if (valuesEqualForAudit(before[field], after[field])) return;
    oldValues[field] = normalizeAuditValue(before[field]);
    newValues[field] = normalizeAuditValue(after[field]);
  });
  Object.entries(extras).forEach(([field, value]) => {
    newValues[field] = normalizeAuditValue(value);
  });
  return { oldValues, newValues };
};

const hasAuditChanges = (diff) =>
  Object.keys(diff.oldValues || {}).length > 0 || Object.keys(diff.newValues || {}).length > 0;

const ensureProductionCycleCostColumns = async (client) => {
  await client.query(`
    ALTER TABLE request_production_cycles
      ADD COLUMN IF NOT EXISTS requested_quantity INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS print_time_minutes DECIMAL(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS material_cost DECIMAL(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS machine_cost DECIMAL(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS fixed_cost DECIMAL(12,2) DEFAULT 0;
  `);
};

const createRequestAuditLog = async (client, {
  requestId,
  action,
  user,
  before,
  after,
  fields,
  extras,
  ipAddress,
}) => {
  const diff = buildAuditDiff(before, after, fields, extras);
  if (!hasAuditChanges(diff)) return;
  await createAuditLog({
    client,
    entityType: 'print_request',
    entityId: requestId,
    action,
    performedBy: user?.id || null,
    performedByName: user ? getUserName(user) : 'System',
    oldValues: diff.oldValues,
    newValues: diff.newValues,
    ipAddress,
  });
};

const createProductionCycle = async (client, {
  requestId,
  requestedQty,
  printedQty,
  rejectedQty,
  materialUsed,
  printTimeMinutes,
  materialCost,
  machineCost,
  fixedCost,
  actualCost,
  startTime,
  endTime,
  createdBy,
  createdByName,
}) => {
  await ensureProductionCycleCostColumns(client);
  const openCycle = await client.query(
    `SELECT *
     FROM request_production_cycles
     WHERE request_id = $1 AND end_time IS NULL
     ORDER BY cycle_number DESC
     LIMIT 1`,
    [requestId]
  ).catch(() => ({ rows: [] }));

  if (openCycle.rows[0] && (printedQty > 0 || rejectedQty > 0 || materialUsed > 0 || endTime)) {
    const result = await client.query(
      `UPDATE request_production_cycles
       SET requested_quantity = $2,
           printed_quantity = $3,
           rejected_quantity = $4,
           material_used = $5,
           print_time_minutes = $6,
           material_cost = $7,
           machine_cost = $8,
           fixed_cost = $9,
           actual_cost = $10,
           start_time = COALESCE(start_time, $11),
           end_time = $12,
           created_by = COALESCE(created_by, $13),
           created_by_name = COALESCE(created_by_name, $14)
       WHERE id = $1
       RETURNING *`,
      [
        openCycle.rows[0].id,
        requestedQty || 0,
        printedQty || 0,
        rejectedQty || 0,
        materialUsed || 0,
        printTimeMinutes || 0,
        materialCost || 0,
        machineCost || 0,
        fixedCost || 0,
        actualCost || 0,
        startTime || null,
        endTime || null,
        createdBy || null,
        createdByName || null,
      ]
    ).catch((err) => {
      console.warn('[Production] Cycle update skipped:', err.message);
      return { rows: [] };
    });
    return result.rows[0] || null;
  }

  const cycleResult = await client.query(
    `SELECT COALESCE(MAX(cycle_number), 0) + 1 AS next_cycle
     FROM request_production_cycles
     WHERE request_id = $1`,
    [requestId]
  ).catch(() => ({ rows: [{ next_cycle: null }] }));

  const cycleNumber = cycleResult.rows[0]?.next_cycle;
  if (!cycleNumber) return null;

  const result = await client.query(
    `INSERT INTO request_production_cycles (
       request_id, cycle_number, requested_quantity, printed_quantity, rejected_quantity,
       material_used, print_time_minutes, material_cost, machine_cost, fixed_cost,
       actual_cost, start_time, end_time, created_by, created_by_name
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      requestId,
      cycleNumber,
      requestedQty || 0,
      printedQty || 0,
      rejectedQty || 0,
      materialUsed || 0,
      printTimeMinutes || 0,
      materialCost || 0,
      machineCost || 0,
      fixedCost || 0,
      actualCost || 0,
      startTime || null,
      endTime || null,
      createdBy || null,
      createdByName || null,
    ]
  ).catch((err) => {
    console.warn('[Production] Cycle history skipped:', err.message);
    return { rows: [] };
  });

  return result.rows[0] || null;
};

const startProductionCycle = async (client, {
  requestId,
  requestedQty,
  startTime,
  createdBy,
  createdByName,
}) => {
  await ensureProductionCycleCostColumns(client);
  const openCycle = await client.query(
    `SELECT id
     FROM request_production_cycles
     WHERE request_id = $1 AND end_time IS NULL
     LIMIT 1`,
    [requestId]
  ).catch(() => ({ rows: [] }));
  if (openCycle.rows[0]) return openCycle.rows[0];

  return createProductionCycle(client, {
    requestId,
    requestedQty,
    printedQty: 0,
    rejectedQty: 0,
    materialUsed: 0,
    actualCost: 0,
    startTime,
    endTime: null,
    createdBy,
    createdByName,
  });
};

const getProductionQuantityTotals = async (client, requestId, requestedQuantity) => {
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
    `SELECT COALESCE(SUM(validated_quantity_checked), 0) AS total_validated_quantity_checked
     FROM quality_checks
     WHERE request_id = $1`,
    [requestId]
  ).catch(() => ({ rows: [{}] }));

  const totalPrintedQuantity = parseInt(production.rows[0]?.total_printed_quantity || 0, 10);
  const totalRejectedQuantity = parseInt(production.rows[0]?.total_rejected_quantity || 0, 10);
  const totalSuccessfulQuantity = Math.max(totalPrintedQuantity - totalRejectedQuantity, 0);
  const totalValidatedQuantity = parseInt(quality.rows[0]?.total_validated_quantity_checked || 0, 10);
  const requested = parseInt(requestedQuantity || 0, 10);
  const missingProductionQuantity = Math.max(requested - totalSuccessfulQuantity, 0)
    + Math.max(totalSuccessfulQuantity - totalValidatedQuantity, 0);

  return {
    totalPrintedQuantity,
    totalRejectedQuantity,
    totalSuccessfulQuantity,
    totalValidatedQuantity,
    missingProductionQuantity,
  };
};

const REQUEST_NUMBER_LOCK_NAMESPACE = 303030;

const generateRequestNumber = async (client) => {
  const year = new Date().getFullYear();
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [REQUEST_NUMBER_LOCK_NAMESPACE, year]);

  const pattern = `^3DP-${year}-([0-9]+)$`;
  const result = await client.query(
    `SELECT COALESCE(MAX(CAST(substring(request_number FROM $1) AS INTEGER)), 0) AS max_sequence
     FROM print_requests
     WHERE request_number ~ $2`,
    [pattern, pattern]
  );
  const nextSequence = parseInt(result.rows[0].max_sequence, 10) + 1;
  return `3DP-${year}-${String(nextSequence).padStart(4, '0')}`;
};

const createStatusHistory = async (client, requestId, fromStatus, toStatus, userId, userName, comment) => {
  await client.query(
    `INSERT INTO status_history (request_id, from_status, to_status, changed_by, changed_by_name, comment)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [requestId, fromStatus, toStatus, userId, userName, comment]
  );
};

// GET all requests (with filters)
exports.getRequests = async (req, res) => {
  try {
    const {
      status, priority, requester_id, technician_id, department,
      category_id, printer_id, material_id, site_id, requester, criticality, date_from, date_to, search, overdue, blocked,
      page = 1, limit = 20, sort = 'created_at', order = 'DESC'
    } = req.query;

    let conditions = [];
    let params = [];
    let idx = 1;

    if (req.user.role === 'requester') {
      conditions.push(`r.requester_id = $${idx++}`);
      params.push(req.user.id);
    }

    if (status)      { conditions.push(`r.status = $${idx++}`);                   params.push(status); }
    if (priority)    { conditions.push(`r.priority = $${idx++}`);                 params.push(priority); }
    if (requester_id){ conditions.push(`r.requester_id = $${idx++}`);             params.push(requester_id); }
    if (technician_id){ conditions.push(`r.assigned_technician_id = $${idx++}`);  params.push(technician_id); }
    if (department)  { conditions.push(`r.requester_department ILIKE $${idx++}`); params.push(`%${department}%`); }
    if (category_id) { conditions.push(`r.category_id = $${idx++}`);             params.push(category_id); }
    if (printer_id)  { conditions.push(`r.printer_id = $${idx++}`);              params.push(printer_id); }
    if (material_id) { conditions.push(`r.material_id = $${idx++}`);             params.push(material_id); }
    if (site_id)     { conditions.push(`r.site_id = $${idx++}`);                 params.push(site_id); }
    if (criticality) { conditions.push(`r.criticality = $${idx++}`);             params.push(criticality); }
    if (requester)   { conditions.push(`r.requester_name ILIKE $${idx++}`);      params.push(`%${requester}%`); }
    if (date_from)   { conditions.push(`COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.planned_start_date, r.created_at)::date >= $${idx++}::date`); params.push(date_from); }
    if (date_to)     { conditions.push(`COALESCE(r.completion_date, r.ready_at, r.actual_end_time, r.planned_start_date, r.created_at)::date <= $${idx++}::date`); params.push(date_to); }
    if (blocked === 'true') { conditions.push(`r.status = 'blocked'`); }
    if (overdue === 'true') {
      conditions.push(`r.status NOT IN ('completed','archived','requester_confirmation','waiting_customer_confirmation','cancelled','rejected')
        AND (
          (r.requested_due_date IS NOT NULL AND r.requested_due_date < CURRENT_DATE)
          OR (r.approved_due_date IS NOT NULL AND r.approved_due_date < CURRENT_DATE)
        )`);
    }
    if (search) {
      const s1 = idx++, s2 = idx++, s3 = idx++, s4 = idx++, s5 = idx++;
      conditions.push(`(r.title ILIKE $${s1} OR r.request_number ILIKE $${s2} OR r.part_description ILIKE $${s3} OR r.requester_name ILIKE $${s4} OR r.project_reference ILIKE $${s5})`);
      const term = `%${search}%`;
      params.push(term, term, term, term, term);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const validSorts = ['created_at','approved_due_date','priority','status','request_number','title'];
    const sortCol = validSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'ASC' ? 'ASC' : 'DESC';

    const countResult = await db.query(`SELECT COUNT(*) FROM print_requests r ${where}`, params);
    const total = parseInt(countResult.rows[0].count);

    const result = await db.query(`
      SELECT r.*,
        u.first_name || ' ' || u.last_name AS requester_full_name,
        t.first_name || ' ' || t.last_name AS technician_full_name,
        p.name AS printer_name,
        m.name AS material_name,
        c.name AS category_name,
        s.name AS site_name,
        CASE WHEN r.status NOT IN ('completed','archived','requester_confirmation','waiting_customer_confirmation','cancelled','rejected')
          AND (
            (r.requested_due_date IS NOT NULL AND r.requested_due_date < CURRENT_DATE)
            OR (r.approved_due_date IS NOT NULL AND r.approved_due_date < CURRENT_DATE)
          )
          THEN true ELSE false END AS is_overdue
      FROM print_requests r
      LEFT JOIN users u ON r.requester_id = u.id
      LEFT JOIN users t ON r.assigned_technician_id = t.id
      LEFT JOIN printers p ON r.printer_id = p.id
      LEFT JOIN materials m ON r.material_id = m.id
      LEFT JOIN request_categories c ON r.category_id = c.id
      LEFT JOIN sites s ON r.site_id = s.id
      ${where}
      ORDER BY r.${sortCol} ${sortOrder}
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, parseInt(limit), offset]);

    res.json({ requests: result.rows, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET single request
exports.getRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`
      SELECT r.*,
        u.first_name || ' ' || u.last_name AS requester_full_name,
        u.email AS requester_email,
        t.first_name || ' ' || t.last_name AS technician_full_name,
        p.name AS printer_name, p.technology AS printer_technology, p.cost_per_minute AS printer_cost_per_minute,
        m.name AS material_name, m.type AS material_type, m.unit AS material_unit,
        m.stock_quantity AS material_stock_quantity,
        COALESCE(m.available_quantity, m.stock_quantity) AS material_available_quantity,
        COALESCE(m.reserved_quantity, 0) AS material_reserved_quantity,
        m.cost_per_unit AS material_cost_per_unit, m.currency AS material_currency,
        c.name AS category_name,
        s.name AS site_name
      FROM print_requests r
      LEFT JOIN users u ON r.requester_id = u.id
      LEFT JOIN users t ON r.assigned_technician_id = t.id
      LEFT JOIN printers p ON r.printer_id = p.id
      LEFT JOIN materials m ON r.material_id = m.id
      LEFT JOIN request_categories c ON r.category_id = c.id
      LEFT JOIN sites s ON r.site_id = s.id
      WHERE r.id = $1
    `, [id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Request not found' });
    const req_data = result.rows[0];
    if (req.user.role === 'requester' && req_data.requester_id !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    const attachments = await db.query('SELECT * FROM request_attachments WHERE request_id = $1 ORDER BY uploaded_at', [id]);
    const comments = await db.query(
      `SELECT rc.*, CASE WHEN rc.is_internal AND $2 NOT IN ('production_technician','coordinator','technician','manager','administrator') THEN NULL ELSE rc.content END AS content
       FROM request_comments rc WHERE rc.request_id = $1 ORDER BY rc.created_at`,
      [id, req.user.role]
    );
    const history = await db.query('SELECT * FROM status_history WHERE request_id = $1 ORDER BY created_at', [id]);
    const feasibility = await db.query(
      `SELECT id, request_id, reviewed_by, reviewed_by_name, review_date,
              is_printable, machine_compatible, material_available,
              technical_notes, result, created_at
       FROM feasibility_reviews
       WHERE request_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [id]
    ).catch(() => ({ rows: [] }));
    await ensureProductionCycleCostColumns(db);
    const productionCycles = await db.query(
      `SELECT pc.*,
              COALESCE(NULLIF(pc.requested_quantity, 0),
                       CASE WHEN pc.cycle_number = 1 THEN r.quantity ELSE pc.printed_quantity END,
                       0) AS requested_quantity,
              COALESCE(NULLIF(pc.material_used, 0),
                       CASE WHEN pc.cycle_number = 1 THEN r.production_total_material_usage ELSE 0 END,
                       0) AS material_reserved,
              COALESCE((
                SELECT qc.validated_quantity_checked
                FROM quality_checks qc
                WHERE qc.request_id = pc.request_id
                ORDER BY qc.created_at ASC
                OFFSET GREATEST(pc.cycle_number - 1, 0)
                LIMIT 1
              ), 0) AS validated_quantity,
              COALESCE(NULLIF(pc.print_time_minutes, 0),
                       CASE WHEN pc.cycle_number = 1 THEN r.production_total_print_time_minutes ELSE 0 END,
                       0) AS print_time_minutes,
              COALESCE(NULLIF(pc.material_cost, 0),
                       COALESCE(pc.material_used, 0) * COALESCE(m.cost_per_unit, r.price_per_kg / 1000.0, 0),
                       0) AS material_cost,
              COALESCE(NULLIF(pc.machine_cost, 0),
                       COALESCE(NULLIF(pc.print_time_minutes, 0),
                                CASE WHEN pc.cycle_number = 1 THEN r.production_total_print_time_minutes ELSE 0 END,
                                0) * COALESCE(p.cost_per_minute, 0),
                       0) AS machine_cost,
              COALESCE(pc.fixed_cost, 0) AS fixed_cost,
              COALESCE(NULLIF(pc.actual_cost, 0),
                       COALESCE(NULLIF(pc.material_cost, 0), COALESCE(pc.material_used, 0) * COALESCE(m.cost_per_unit, r.price_per_kg / 1000.0, 0), 0)
                       + COALESCE(NULLIF(pc.machine_cost, 0),
                                  COALESCE(NULLIF(pc.print_time_minutes, 0),
                                           CASE WHEN pc.cycle_number = 1 THEN r.production_total_print_time_minutes ELSE 0 END,
                                           0) * COALESCE(p.cost_per_minute, 0),
                                  0)
                       + COALESCE(pc.fixed_cost, 0),
                       0) AS actual_cost,
              u.first_name || ' ' || u.last_name AS created_by_full_name
       FROM request_production_cycles pc
       LEFT JOIN print_requests r ON pc.request_id = r.id
       LEFT JOIN materials m ON r.material_id = m.id
       LEFT JOIN printers p ON r.printer_id = p.id
       LEFT JOIN users u ON pc.created_by = u.id
       WHERE pc.request_id = $1
       ORDER BY pc.cycle_number`,
      [id]
    ).catch(() => ({ rows: [] }));
    await ensureSatisfactionTable(db);
    const satisfaction = await db.query(
      `SELECT * FROM request_satisfaction_surveys WHERE request_id = $1`,
      [id]
    ).catch(() => ({ rows: [] }));
    const qualityTotals = await db.query(
      `SELECT COALESCE(SUM(validated_quantity_checked), 0) AS total_validated_quantity_checked
       FROM quality_checks
       WHERE request_id = $1`,
      [id]
    ).catch(() => ({ rows: [{ total_validated_quantity_checked: 0 }] }));
    const latestQualityCheck = await db.query(
      `SELECT id, result, successful_quantity, validated_quantity_checked, remaining_quantity, quantity_mismatch, created_at, check_date
       FROM quality_checks
       WHERE request_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [id]
    ).catch(() => ({ rows: [] }));
    const productionCycleSummary = productionCycles.rows.reduce((summary, cycle) => ({
      total_printed_quantity: summary.total_printed_quantity + parseInt(cycle.printed_quantity || 0, 10),
      total_rejected_quantity: summary.total_rejected_quantity + parseInt(cycle.rejected_quantity || 0, 10),
      total_material_used: summary.total_material_used + parseFloat(cycle.material_used || 0),
      total_print_time_minutes: summary.total_print_time_minutes + parseFloat(cycle.print_time_minutes || 0),
      total_material_cost: summary.total_material_cost + parseFloat(cycle.material_cost || 0),
      total_machine_cost: summary.total_machine_cost + parseFloat(cycle.machine_cost || 0),
      total_fixed_cost: summary.total_fixed_cost + parseFloat(cycle.fixed_cost || 0),
      total_actual_cost: summary.total_actual_cost + parseFloat(cycle.actual_cost || 0),
    }), {
      total_printed_quantity: 0,
      total_rejected_quantity: 0,
      total_material_used: 0,
      total_print_time_minutes: 0,
      total_material_cost: 0,
      total_machine_cost: 0,
      total_fixed_cost: 0,
      total_actual_cost: 0,
    });
    const aggregatePrintedQuantity = productionCycles.rows.length > 0
      ? productionCycleSummary.total_printed_quantity
      : parseInt(req_data.printed_quantity || 0, 10);
    const aggregateRejectedQuantity = productionCycles.rows.length > 0
      ? productionCycleSummary.total_rejected_quantity
      : parseInt(req_data.rejected_quantity || 0, 10);
    const totalSuccessfulQuantity = Math.max(
      aggregatePrintedQuantity - aggregateRejectedQuantity,
      0
    );
    const totalValidatedQuantity = parseInt(qualityTotals.rows[0]?.total_validated_quantity_checked || 0, 10);
    const requestedQuantity = parseInt(req_data.quantity || 0, 10);
    const missingProductionQuantity = Math.max(requestedQuantity - totalSuccessfulQuantity, 0)
      + Math.max(totalSuccessfulQuantity - totalValidatedQuantity, 0);
    const feasibilityRow = feasibility.rows[0] || null;
    const feasibilityReview = feasibilityRow ? {
      id: feasibilityRow.id,
      requestId: feasibilityRow.request_id,
      reviewedBy: feasibilityRow.reviewed_by,
      reviewedByName: feasibilityRow.reviewed_by_name,
      reviewDate: feasibilityRow.review_date,
      isPrintable: feasibilityRow.is_printable,
      machineCompatible: feasibilityRow.machine_compatible,
      materialAvailable: feasibilityRow.material_available,
      technicalNotes: feasibilityRow.technical_notes,
      result: feasibilityRow.result,
      createdAt: feasibilityRow.created_at,
    } : null;

    res.json({
      ...req_data,
      attachments: attachments.rows,
      comments: comments.rows.filter(c => c.content !== null),
      statusHistory: history.rows,
      feasibilityReview,
      latestQualityCheck: latestQualityCheck.rows[0] || null,
      productionCycles: productionCycles.rows,
      productionSummary: {
        total_printed_quantity: aggregatePrintedQuantity,
        total_rejected_quantity: aggregateRejectedQuantity,
        total_successful_quantity: totalSuccessfulQuantity,
        total_validated_quantity_checked: totalValidatedQuantity,
        missing_production_quantity: missingProductionQuantity,
        total_material_used: productionCycles.rows.length > 0 ? productionCycleSummary.total_material_used : parseFloat(req_data.material_used_grams || 0),
        total_print_time_minutes: productionCycleSummary.total_print_time_minutes,
        total_material_cost: productionCycleSummary.total_material_cost,
        total_machine_cost: productionCycleSummary.total_machine_cost,
        total_fixed_cost: productionCycleSummary.total_fixed_cost,
        total_actual_cost: productionCycles.rows.length > 0 ? productionCycleSummary.total_actual_cost : parseFloat(req_data.actual_cost || 0),
        rework_count: Math.max(0, productionCycles.rows.length - 1),
      },
      satisfaction: satisfaction.rows[0] || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.submitSatisfactionSurvey = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await ensureSatisfactionTable(client);
    const { id } = req.params;
    const {
      overall_rating,
      quality_rating,
      delivery_rating,
      communication_rating,
      fulfillment_result,
      recommendation_score,
      comment,
    } = req.body;

    const requestResult = await client.query(
      'SELECT id, requester_id, status, requester_confirmation, reception_confirmed_at FROM print_requests WHERE id = $1',
      [id]
    );
    const request = requestResult.rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found' });
    }
    if (request.requester_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the requester can submit satisfaction feedback.' });
    }
    if (!['completed', 'archived'].includes(request.status) && !request.requester_confirmation && !request.reception_confirmed_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Satisfaction survey is available only after reception is confirmed.' });
    }

    const ratings = [overall_rating, quality_rating, delivery_rating, communication_rating].map(v => parseInt(v, 10));
    if (ratings.some(v => !Number.isInteger(v) || v < 1 || v > 5)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'All ratings must be between 1 and 5.' });
    }
    if (!['fully_met','partially_met','not_met'].includes(fulfillment_result)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid fulfillment result.' });
    }
    if (!['yes','maybe','no'].includes(recommendation_score)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid recommendation score.' });
    }
    if (comment && String(comment).length > 1000) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Comment must be 1000 characters or fewer.' });
    }

    const inserted = await client.query(`
      INSERT INTO request_satisfaction_surveys (
        request_id, requester_id, overall_rating, quality_rating, delivery_rating,
        communication_rating, fulfillment_result, recommendation_score, comment
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      id,
      req.user.id,
      ratings[0],
      ratings[1],
      ratings[2],
      ratings[3],
      fulfillment_result,
      recommendation_score,
      comment ? String(comment).trim() : null,
    ]).catch((err) => {
      if (err.code === '23505') {
        const duplicate = new Error('This request has already been rated.');
        duplicate.statusCode = 409;
        throw duplicate;
      }
      throw err;
    });

    await client.query('COMMIT');
    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Server error' });
  } finally {
    client.release();
  }
};

// CREATE request
exports.createRequest = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const requestNumber = await generateRequestNumber(client);
    const payload = normalizeRequestPayload(req.body);
    devLog('[RequestCreate] Payload:', payload);
    const {
      title, purpose, part_description, quantity, functional_requirement,
      visual_requirement, category_id, criticality, use_environment,
      dimensions, scale, tolerance, surface_finish, strength_requirement,
      color_preference, material_preference, infill_percentage, layer_height,
      orientation, priority, priority_reason, requested_due_date,
      project_reference, customer_reference, site_id,
      material_id, printer_id, material_reserved_qty, price_per_kg
    } = payload;

    if (!site_id) {
      await client.query('ROLLBACK');
      devLog('[RequestCreate] Validation failed:', { error: 'Site is required' });
      return res.status(400).json({ error: 'Site is required' });
    }

    const site = await client.query('SELECT id FROM sites WHERE id = $1 AND is_active = true', [site_id]);
    if (!site.rows[0]) {
      await client.query('ROLLBACK');
      devLog('[RequestCreate] Validation failed:', { error: 'Invalid site', site_id });
      return res.status(400).json({ error: 'Invalid site' });
    }
    devLog('[RequestCreate] Validation passed:', { site_id, category_id, requested_due_date });

    const result = await client.query(`
      INSERT INTO print_requests (
        request_number, title, requester_id, requester_name, requester_department,
        project_reference, customer_reference, site_id, purpose, part_description, quantity,
        functional_requirement, visual_requirement, category_id, criticality, use_environment,
        dimensions, scale, tolerance, surface_finish, strength_requirement,
        color_preference, material_preference, infill_percentage, layer_height, orientation,
        priority, priority_reason, requested_due_date, material_id, printer_id,
        material_reserved_qty, price_per_kg, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,'draft')
      RETURNING *
    `, [
      requestNumber, title, req.user.id,
      getUserName(req.user),
      req.user.department, project_reference, customer_reference,
      site_id, purpose, part_description, quantity || 1,
      functional_requirement, visual_requirement, category_id, criticality, use_environment,
      dimensions, scale, tolerance, surface_finish, strength_requirement,
      color_preference, material_preference, infill_percentage, layer_height, orientation,
      priority || 'normal', priority_reason, requested_due_date,
      material_id || null, printer_id || null, material_reserved_qty || null,
      price_per_kg || null
    ]);
    devLog('[RequestCreate] Inserted request:', {
      id: result.rows[0]?.id,
      request_number: result.rows[0]?.request_number,
      status: result.rows[0]?.status,
    });

    await createStatusHistory(client, result.rows[0].id, null, 'draft', req.user.id,
      getUserName(req.user), 'Request created');

    await createRequestAuditLog(client, {
      requestId: result.rows[0].id,
      action: 'request_created',
      user: req.user,
      before: {},
      after: result.rows[0],
      fields: AUDIT_REQUEST_FIELDS,
      extras: { status_comment: 'Request created' },
      ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    });

    await client.query('COMMIT');

    const newReqId = result.rows[0].id;
    const newReqNum = result.rows[0].request_number;
    // Notify production technicians, admins AND managers of new request
    db.query(`SELECT id, role FROM users WHERE role IN (${roleSqlList([...PRODUCTION_TECHNICIAN_ALIASES, 'administrator', 'manager'])}) AND is_active = true`)
      .then(users => {
        users.rows.forEach(u => {
          db.query(
            `INSERT INTO notifications (user_id, request_id, type, title, message) VALUES ($1,$2,'new_request',$3,$4)`,
            [u.id, newReqId, `New request ${newReqNum}`,
             `${getUserName(req.user)} submitted a new 3D print request: "${result.rows[0].title}"`]
          ).catch(() => {});
        });
      }).catch(() => {});

    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[RequestCreate] Failed:', {
      message: err.message,
      detail: err.detail,
      code: err.code,
      stack: isDev ? err.stack : undefined,
    });
    res.status(500).json({ error: publicDbError(err) });
  } finally {
    client.release();
  }
};

// UPDATE request fields
exports.updateRequest = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const payload = normalizeRequestPayload(req.body);
    devLog('[RequestUpdate] Payload:', { id, payload });
    const existing = await client.query('SELECT * FROM print_requests WHERE id = $1', [id]);
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }

    const r = existing.rows[0];
    if (req.user.role === 'requester') {
      if (r.requester_id !== req.user.id) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Access denied' });
      }
      if (!isAdministrator(req.user) && !['draft','more_info_required'].includes(r.status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Cannot edit a request with status "${r.status}"` });
      }
    }
    if (req.user.role === 'manager') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Managers have read-only access' });
    }

    const fields = [
      'title','purpose','part_description','quantity','functional_requirement',
      'visual_requirement','category_id','criticality','use_environment',
      'dimensions','scale','tolerance','surface_finish','strength_requirement',
      'color_preference','material_preference','infill_percentage','layer_height',
      'orientation','priority','priority_reason','requested_due_date','approved_due_date',
      'project_reference','customer_reference','site_id',
      'price_per_kg','actual_cost',
      'assigned_technician_id','printer_id','material_id','batch_reference',
      'production_material_usage_per_part','production_print_time_per_part_minutes',
      'production_total_material_usage','production_total_print_time_minutes',
      'post_processing_details','quality_result','quality_notes','scrap_count',
      'rework_required','rework_reason','lessons_learned'
    ];

    const updates = [];
    const values = [];
    let idx = 1;
    fields.forEach(f => {
      const val = payload[f];
      if (val !== undefined) {
        if (typeof val === 'boolean') {
          updates.push(`${f} = $${idx++}::boolean`);
        } else {
          updates.push(`${f} = $${idx++}`);
        }
        values.push(val);
      }
    });

    if (payload.site_id !== undefined) {
      const site = await client.query('SELECT id FROM sites WHERE id = $1 AND is_active = true', [payload.site_id]);
      if (!site.rows[0]) {
        await client.query('ROLLBACK');
        devLog('[RequestUpdate] Validation failed:', { id, error: 'Invalid site', site_id: payload.site_id });
        return res.status(400).json({ error: 'Invalid site' });
      }
    }
    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No fields to update' });
    }

    // last_edited columns only exist after V4 migration
    let _hasLastEdited = false;
    try { await client.query('SELECT last_edited_at FROM print_requests LIMIT 0'); _hasLastEdited = true; } catch(_) {}
    if (_hasLastEdited) {
      updates.push('last_edited_at = NOW()');
      updates.push(`last_edited_by_name = $${idx++}`);
      values.push(getUserName(req.user));
    }
    values.push(id);

    const result = await client.query(
      `UPDATE print_requests SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`, values
    );

    await createRequestAuditLog(client, {
      requestId: id,
      action: 'request_update',
      user: req.user,
      before: r,
      after: result.rows[0],
      fields: fields.filter(f => payload[f] !== undefined),
      ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    });

    const driverAudit = [
      { field: 'material_id', action: 'material_changed', label: 'Material Changed' },
      { field: 'printer_id', action: 'printer_changed', label: 'Printer Changed' },
      { field: 'quantity', action: 'quantity_changed', label: 'Quantity Changed' },
    ];
    for (const item of driverAudit) {
      if (payload[item.field] !== undefined && String(r[item.field] ?? '') !== String(result.rows[0][item.field] ?? '')) {
        await createAuditLog({
          client,
          entityType: 'print_request',
          entityId: id,
          action: item.action,
          performedBy: req.user.id,
          performedByName: getUserName(req.user),
          oldValues: { [item.field]: r[item.field] },
          newValues: { [item.field]: result.rows[0][item.field] },
          ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
        });
      }
    }
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[RequestUpdate] Failed:', {
      message: err.message,
      detail: err.detail,
      code: err.code,
      stack: isDev ? err.stack : undefined,
    });
    res.status(500).json({ error: publicDbError(err) });
  } finally {
    client.release();
  }
};

// STATUS TRANSITION — single destructuring, no duplicates
exports.updateStatus = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;

    // ── SINGLE destructuring of ALL body fields ──────────────────────────
    const {
      status,
      comment,
      rejection_reason,
      blocking_reason,
      on_hold_reason,
      cancellation_reason,
      approved_due_date,
      assigned_technician_id,
      actual_start_time,
      actual_end_time,
      quality_result,
      quality_notes,
      scrap_count,
      rework_required,
      rework_reason,
      lessons_learned,
      priority,
      priority_reason,
      quantity: bodyQuantity,
      printer_id: bodyPrinterId,
      material_id: bodyMaterialId,
      planned_start_date,
      planned_end_date,
      planned_end_manually_adjusted,
      production_material_usage_per_part,
      production_print_time_per_part_minutes,
      production_total_material_usage,
      production_total_print_time_minutes,
      material_reserved_qty,
      material_reserved_spool,
      material_used_grams,
      price_per_kg,
      printed_quantity,
      rejected_quantity,
      reprint_quantity,
      final_quantity,
      reception_comment,
      reception_condition,
      machine_runtime_hours,
      machine_downtime_hours,
      machine_pause_reason,
      business_impact,
      production_stop_risk,
      sla_hours,
      qc_reference,
      info_required_reason,
    } = req.body;
    devLog('[RequestStatus] Payload:', { id, body: req.body });

    const existing = await client.query('SELECT * FROM print_requests WHERE id = $1', [id]);
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const r = existing.rows[0];
    const statusChanged = r.status !== status;

    // ── Workflow validation ──────────────────────────────────────────────
    const validation = await validateTransition(id, status, req.user.role, req.user.id);
    devLog('[RequestStatus] Validation result:', { id, status, validation });
    if (!validation.valid) {
      await client.query('ROLLBACK');
      return res.status(validation.code || 400).json({
        error: validation.error,
        validation_type: validation.validation_type,
        missing_fields: validation.missing_fields,
      });
    }

    // ── Permission checks ────────────────────────────────────────────────
    if (req.user.role === 'requester') {
      if (r.requester_id !== req.user.id) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Access denied' });
      }
      const requesterAllowed = {
        submitted: ['draft','more_info_required'],
        completed: ['requester_confirmation'],
      };
      if (!requesterAllowed[status]) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not allowed' });
      }
      if (!requesterAllowed[status].includes(r.status)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: `Cannot move to "${status}" from "${r.status}"` });
      }
    }

    if (req.user.role === 'manager') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Managers cannot change request status' });
    }

    // ── Build extra updates ──────────────────────────────────────────────
    const extraUpdates = {};

    if (status === 'submitted')        { extraUpdates.submitted_at = 'NOW()'; }
    if (status === 'approved') {
      extraUpdates.approved_at = 'NOW()';
      if (approved_due_date) extraUpdates.approved_due_date = approved_due_date;
      if (sla_hours)         extraUpdates.sla_hours = sla_hours;
      if (approved_due_date) extraUpdates.sla_breach_at = approved_due_date;
    }
    if (status === 'prioritized') {
      if (priority)        extraUpdates.priority        = priority;
      if (priority_reason) extraUpdates.priority_reason = priority_reason;
    }
    if (status === 'assigned') {
      extraUpdates.assigned_at = 'NOW()';
      if (assigned_technician_id) extraUpdates.assigned_technician_id = assigned_technician_id;
    }
    if (status === 'planned') {
      const effectiveMaterialId = bodyMaterialId || r.material_id;
      const effectivePrinterId = bodyPrinterId || r.printer_id;
      const effectiveQuantity = parseFloat(bodyQuantity !== undefined ? bodyQuantity : r.quantity);
      const totalMaterialUsageInput = production_total_material_usage !== undefined
        ? production_total_material_usage
        : production_material_usage_per_part;
      const totalPrintTimeInput = production_total_print_time_minutes !== undefined
        ? production_total_print_time_minutes
        : production_print_time_per_part_minutes;
      const totalMaterialUsage = roundMoney(parseFloat(totalMaterialUsageInput));
      const totalPrintTimeMinutes = roundMoney(parseFloat(totalPrintTimeInput));

      if (!effectiveMaterialId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Material is required before moving the request to Planned.' });
      }
      if (!effectivePrinterId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Printer is required before moving the request to Planned.' });
      }
      if (!Number.isFinite(totalMaterialUsage) || totalMaterialUsage <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Total Material Usage is required and must be greater than zero.' });
      }
      if (!Number.isFinite(totalPrintTimeMinutes) || totalPrintTimeMinutes <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Total Print Time is required and must be greater than zero.' });
      }
      if (!Number.isFinite(effectiveQuantity) || effectiveQuantity <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Request quantity must be greater than zero.' });
      }
      if (!planned_start_date) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Planned Start DateTime is required for planning.' });
      }
      if (bodyPrinterId)      extraUpdates.printer_id         = bodyPrinterId;
      if (bodyMaterialId)     extraUpdates.material_id        = bodyMaterialId;
      if (bodyQuantity !== undefined) extraUpdates.quantity   = bodyQuantity;

      const rates = await getConfiguredRates({
        materialId: effectiveMaterialId,
        printerId: effectivePrinterId,
        client,
      });
      if (!rates.materialCostPerUnit || !rates.printerCostPerMinute) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot calculate production cost because material or printer cost configuration is missing.' });
      }
      const plannedCost = calculateConfiguredCost({
        materialUsage: totalMaterialUsage,
        printTimeMinutes: totalPrintTimeMinutes,
        materialCostPerUnit: rates.materialCostPerUnit,
        printerCostPerMinute: rates.printerCostPerMinute,
        includeFixedCost: true,
      });
      if (!plannedCost) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Unable to calculate production cost from planning data.' });
      }
      const calculatedPlannedEndDate = calculatePlannedEndDate(planned_start_date, totalPrintTimeMinutes);
      if (!calculatedPlannedEndDate) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Unable to calculate Planned End DateTime from Planned Start and Total Print Time.' });
      }
      const receivedPlannedEndDate = planned_end_date ? new Date(planned_end_date) : null;
      if (receivedPlannedEndDate && Number.isNaN(receivedPlannedEndDate.getTime())) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Planned End DateTime is invalid.' });
      }
      const plannedEndDiffMinutes = receivedPlannedEndDate
        ? Math.abs(receivedPlannedEndDate.getTime() - new Date(calculatedPlannedEndDate).getTime()) / 60000
        : 0;
      const hasManualPlannedEnd = Boolean(planned_end_manually_adjusted) && receivedPlannedEndDate && plannedEndDiffMinutes >= 1;
      const effectivePlannedEndDate = hasManualPlannedEnd
        ? receivedPlannedEndDate.toISOString()
        : calculatedPlannedEndDate;
      const plannedDuration = calculatePlannedDurationHours(planned_start_date, effectivePlannedEndDate);
      if (plannedDuration === null || plannedDuration <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Planned End DateTime must be greater than Planned Start DateTime.' });
      }

      extraUpdates.planned_start_date = planned_start_date;
      extraUpdates.planned_end_date = effectivePlannedEndDate;
      extraUpdates.production_material_usage_per_part = totalMaterialUsage;
      extraUpdates.production_print_time_per_part_minutes = totalPrintTimeMinutes;
      extraUpdates.production_total_material_usage = totalMaterialUsage;
      extraUpdates.production_total_print_time_minutes = totalPrintTimeMinutes;
      extraUpdates.material_reserved_qty = totalMaterialUsage;
      extraUpdates.actual_cost = plannedCost.totalCost;

      await createAuditLog({
        client,
        entityType: 'print_request',
        entityId: id,
        action: 'manual_planning_data_entered',
        performedBy: req.user.id,
        performedByName: getUserName(req.user),
        newValues: {
          material_id: effectiveMaterialId,
          printer_id: effectivePrinterId,
          quantity: effectiveQuantity,
          production_material_usage_per_part: totalMaterialUsage,
          production_print_time_per_part_minutes: totalPrintTimeMinutes,
          production_total_material_usage: totalMaterialUsage,
          production_total_print_time_minutes: totalPrintTimeMinutes,
          material_cost: plannedCost.materialCost,
          machine_cost: plannedCost.machineCost,
          fixed_cost: plannedCost.fixedCost,
          total_cost: plannedCost.totalCost,
          calculated_planned_end_date: calculatedPlannedEndDate,
          planned_end_date: effectivePlannedEndDate,
        },
      });
      if (hasManualPlannedEnd) {
        await createAuditLog({
          client,
          entityType: 'print_request',
          entityId: id,
          action: 'planned_end_manually_adjusted',
          performedBy: req.user.id,
          performedByName: getUserName(req.user),
          oldValues: { planned_end_date: calculatedPlannedEndDate },
          newValues: { planned_end_date: effectivePlannedEndDate },
        });
      }
      if (effectiveMaterialId && extraUpdates.material_reserved_qty) {
        try {
          await reserveMaterial(client, {
            requestId: id, materialId: effectiveMaterialId,
            spoolReference: material_reserved_spool,
            reservedQty: parseFloat(extraUpdates.material_reserved_qty),
            performedBy: req.user.id,
            performedByName: getUserName(req.user),
          });
          extraUpdates.material_reserved       = true;
          extraUpdates.material_reserved_spool = material_reserved_spool;
          extraUpdates.material_reserved_qty   = extraUpdates.material_reserved_qty;
          extraUpdates.material_reserved_at    = 'NOW()';
          extraUpdates.material_reserved_by    = getUserName(req.user);
        } catch (stockErr) {
          await createAuditLog({
            client,
            entityType: 'print_request',
            entityId: id,
            action: 'inventory_risk_detected',
            performedBy: req.user.id,
            performedByName: getUserName(req.user),
            newValues: {
              severity: 'High',
              risk: 'Insufficient Stock',
              message: stockErr.message,
              material_id: effectiveMaterialId,
              required_material: extraUpdates.material_reserved_qty,
            },
          });
        }
      }
    }
    if (status === 'in_progress') {
      extraUpdates.actual_start_time = actual_start_time || 'NOW()';
      if (r.status === 'rework_required') {
        const requestedQty = parseFloat(r.quantity || 0);
        const totals = await getProductionQuantityTotals(client, id, requestedQty);
        const remainingQty = totals.missingProductionQuantity;
        const plannedTotalMaterialUsage = parseFloat(r.production_total_material_usage || r.production_material_usage_per_part || 0);
        const additionalReservedMaterial = Number.isFinite(plannedTotalMaterialUsage)
          ? roundMoney(plannedTotalMaterialUsage)
          : 0;
        if (remainingQty > 0 && additionalReservedMaterial > 0) {
          try {
            await reserveMaterial(client, {
              requestId: id,
              materialId: r.material_id,
              spoolReference: material_reserved_spool || r.material_reserved_spool,
              reservedQty: additionalReservedMaterial,
              performedBy: req.user.id,
              performedByName: getUserName(req.user),
            });
            extraUpdates.material_reserved = true;
            extraUpdates.material_reserved_qty = addNumber(additionalReservedMaterial);
            extraUpdates.material_reserved_at = 'NOW()';
            extraUpdates.material_reserved_by = getUserName(req.user);
            await createAuditLog({
              client,
              entityType: 'print_request',
              entityId: id,
              action: 'additional_material_reserved',
              performedBy: req.user.id,
              performedByName: getUserName(req.user),
              newValues: {
                missing_production_quantity: remainingQty,
                total_material_usage: plannedTotalMaterialUsage,
                additional_reserved_material: additionalReservedMaterial,
              },
            });
          } catch (stockErr) {
            const stock = await client.query(
              `SELECT COALESCE(available_quantity, stock_quantity, 0) AS available_quantity,
                      COALESCE(reserved_quantity, 0) AS reserved_quantity
               FROM materials WHERE id = $1`,
              [r.material_id]
            ).catch(() => ({ rows: [{}] }));
            await client.query('ROLLBACK');
            const available = parseFloat(stock.rows[0]?.available_quantity || 0);
            const reserved = parseFloat(stock.rows[0]?.reserved_quantity || 0);
            return res.status(400).json({
              error: 'Inventory Risk. Insufficient material available for rework production.',
              validation_type: 'rework_inventory_risk',
              available_stock: available,
              reserved_stock: reserved,
              additional_reservation_required: additionalReservedMaterial,
              missing_material_quantity: Math.max(additionalReservedMaterial - available, 0),
            });
          }
        }
        await startProductionCycle(client, {
          requestId: id,
          requestedQty: remainingQty,
          startTime: actual_start_time || new Date(),
          createdBy: req.user.id,
          createdByName: getUserName(req.user),
        });
      }
    }
    if (status === 'printed') {
      const printedEndTime = actual_end_time || new Date();
      extraUpdates.actual_end_time = printedEndTime;
      const printedStartTime = actual_start_time || r.actual_start_time;
      let actualHoursDataIssue = false;
      if (printedStartTime) {
        const durationHours = (new Date(printedEndTime).getTime() - new Date(printedStartTime).getTime()) / 3600000;
        if (Number.isFinite(durationHours)) {
          if (durationHours >= 0) {
            extraUpdates.actual_duration = roundMoney(durationHours);
          } else {
            actualHoursDataIssue = true;
            extraUpdates.actual_duration = 0;
            await createAuditLog({
              client,
              entityType: 'print_request',
              entityId: id,
              action: 'actual_hours_data_issue',
              performedBy: req.user.id,
              performedByName: getUserName(req.user),
              newValues: {
                actual_start_time: printedStartTime,
                actual_end_time: printedEndTime,
                warning: 'actual_end_time is earlier than actual_start_time; actual_duration was set to 0.',
              },
              ipAddress: req.ip,
            });
          }
        }
      }
      const cyclePrintedQty = printed_quantity !== undefined ? parseInt(printed_quantity, 10) : 0;
      const cycleRejectedQty = rejected_quantity !== undefined ? parseInt(rejected_quantity, 10) : 0;
      let cycleMaterialUsed = 0;
      let cyclePrintTimeMinutes = 0;
      let cycleMaterialCost = 0;
      let cycleMachineCost = 0;
      let cycleFixedCost = 0;
      let cycleActualCost = null;

      if (printed_quantity  !== undefined) {
        extraUpdates.printed_quantity = addNumber(Number.isFinite(cyclePrintedQty) ? cyclePrintedQty : 0);
      }
      if (rejected_quantity !== undefined) {
        const rejectedQty = Number.isFinite(cycleRejectedQty) ? cycleRejectedQty : 0;
        extraUpdates.rejected_quantity = addNumber(rejectedQty);
        extraUpdates.scrap_count = addNumber(rejectedQty);
      }
      if (reprint_quantity  !== undefined) extraUpdates.reprint_quantity  = reprint_quantity;
      if (machine_runtime_hours  !== undefined) extraUpdates.machine_runtime_hours  = machine_runtime_hours;
      if (machine_downtime_hours !== undefined) extraUpdates.machine_downtime_hours = machine_downtime_hours;
      if (machine_pause_reason) extraUpdates.machine_pause_reason = machine_pause_reason;
      {
        const activeReservation = await client.query(
          `SELECT reserved_qty
           FROM material_reservations
           WHERE request_id = $1 AND status = 'reserved'
           ORDER BY reserved_at ASC, id ASC
           LIMIT 1`,
          [id]
        ).catch(() => ({ rows: [] }));
        // Validate vs the current production cycle reservation, not the request's cumulative reservation total.
        const reservedQty = parseFloat(activeReservation.rows[0]?.reserved_qty || r.material_reserved_qty || 0);
        const rawMaterialUsed = material_used_grams;
        const parsedMaterialUsed = parseFloat(rawMaterialUsed);
        const hasActualMaterialUsed = rawMaterialUsed !== undefined
          && rawMaterialUsed !== null
          && String(rawMaterialUsed).trim() !== ''
          && Number.isFinite(parsedMaterialUsed)
          && parsedMaterialUsed > 0;
        const consumedQty = hasActualMaterialUsed ? parsedMaterialUsed : reservedQty;
        if (reservedQty > 0 && consumedQty > reservedQty * 1.1) {
          // Allow 10% tolerance, block beyond that
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Material used (${consumedQty}g) exceeds reserved quantity (${reservedQty}g) by more than 10%. Please adjust the quantity or reserve more material.`,
            validation_type: 'material_exceeded',
          });
        }
        cycleMaterialUsed = consumedQty;
        extraUpdates.material_used_grams = addNumber(consumedQty);
        // Consume from stock (pass material_id from the request record)
        await consumeMaterial(client, {
          requestId: id,
          materialId: r.material_id,
          actualConsumedQty: consumedQty,
          performedBy: req.user.id,
          performedByName: getUserName(req.user),
        }).catch(err => console.warn('[Material] Consume warning:', err.message));

        // Notify production technicians if consumed != reserved (significant diff > 5g)
        if (reservedQty > 0 && Math.abs(consumedQty - reservedQty) > 5) {
          const diff = consumedQty - reservedQty;
          const coords = await client.query(
            `SELECT id FROM users WHERE role IN (${roleSqlList([...PRODUCTION_TECHNICIAN_ALIASES, 'administrator'])}) AND is_active = true`
          );
          for (const c of coords.rows) {
            await client.query(
              `INSERT INTO notifications (user_id, request_id, type, title, message)
               VALUES ($1, $2, 'material_variance', $3, $4)`,
              [c.id, id,
               `${r.request_number} — Material variance`,
               `Consumed: ${consumedQty}g vs Reserved: ${reservedQty}g (${diff > 0 ? '+' : ''}${diff.toFixed(1)}g variance)`]
            ).catch(() => {});
          }
        }
      }

      const requestedQty = parseFloat(r.quantity || 0);
      const quantityTotalsBeforeCycle = await getProductionQuantityTotals(client, id, requestedQty);
      const remainingBeforeCycle = quantityTotalsBeforeCycle.missingProductionQuantity;
      const cycleTargetQuantity = r.rework_required && remainingBeforeCycle > 0
        ? remainingBeforeCycle
        : requestedQty;
      const plannedTotalMaterialUsage = parseFloat(r.production_total_material_usage || r.production_material_usage_per_part || 0);
      const plannedTotalPrintTimeMinutes = parseFloat(r.production_total_print_time_minutes || r.production_print_time_per_part_minutes || 0);
      if (Number.isFinite(cycleTargetQuantity) && cycleTargetQuantity > 0
        && Number.isFinite(plannedTotalMaterialUsage) && plannedTotalMaterialUsage > 0
        && Number.isFinite(plannedTotalPrintTimeMinutes) && plannedTotalPrintTimeMinutes > 0
        && r.material_id && r.printer_id) {
        const rates = await getConfiguredRates({
          materialId: r.material_id,
          printerId: r.printer_id,
          client,
        });
        const cycleCost = calculateConfiguredCost({
          materialUsage: roundMoney(plannedTotalMaterialUsage),
          printTimeMinutes: roundMoney(plannedTotalPrintTimeMinutes),
          materialCostPerUnit: rates.materialCostPerUnit,
          printerCostPerMinute: rates.printerCostPerMinute,
          includeFixedCost: true,
        });
        if (cycleCost) {
          cyclePrintTimeMinutes = roundMoney(plannedTotalPrintTimeMinutes);
          cycleMaterialCost = cycleCost.materialCost;
          cycleMachineCost = cycleCost.machineCost;
          cycleFixedCost = cycleCost.fixedCost;
          cycleActualCost = cycleCost.totalCost;
        }
      }

      await createProductionCycle(client, {
        requestId: id,
        requestedQty: Number.isFinite(cycleTargetQuantity) ? cycleTargetQuantity : 0,
        printedQty: Number.isFinite(cyclePrintedQty) ? cyclePrintedQty : 0,
        rejectedQty: Number.isFinite(cycleRejectedQty) ? cycleRejectedQty : 0,
        materialUsed: cycleMaterialUsed,
        printTimeMinutes: cyclePrintTimeMinutes,
        materialCost: cycleMaterialCost,
        machineCost: cycleMachineCost,
        fixedCost: cycleFixedCost,
        actualCost: cycleActualCost,
        startTime: printedStartTime,
        endTime: printedEndTime,
        createdBy: req.user.id,
        createdByName: getUserName(req.user),
      });
      const rejectedQty = Number.isFinite(cycleRejectedQty) ? cycleRejectedQty : 0;
      const successfulQty = Math.max((Number.isFinite(cyclePrintedQty) ? cyclePrintedQty : 0) - rejectedQty, 0);
      const reportedQty = successfulQty + rejectedQty;
      const yieldPercent = reportedQty > 0 ? roundMoney((successfulQty / reportedQty) * 100) : null;
      await createAuditLog({
        client,
        entityType: 'print_request',
        entityId: id,
        action: 'production_report_submitted',
        performedBy: req.user.id,
        performedByName: getUserName(req.user),
        newValues: {
          requested_quantity: Number.isFinite(requestedQty) ? requestedQty : null,
          requested_quantity_for_cycle: Number.isFinite(cycleTargetQuantity) ? cycleTargetQuantity : null,
          remaining_quantity_before_cycle: remainingBeforeCycle,
          printed_quantity: successfulQty,
          rejected_quantity: rejectedQty,
          reported_quantity: reportedQty,
          quantity_delta: Number.isFinite(requestedQty) ? reportedQty - requestedQty : null,
          yield_percent: yieldPercent,
          actual_hours_data_issue: actualHoursDataIssue || undefined,
        },
      });
    }
    if (status === 'quality_check')    { extraUpdates.qc_started_at = 'NOW()'; }
    if (status === 'ready_for_pickup') {
      extraUpdates.ready_at = 'NOW()';
      await releaseRemainingReservationAfterProduction(client, {
        requestId: id,
        performedBy: req.user.id,
        performedByName: getUserName(req.user),
      }).catch((err) => {
        console.warn('[Material] Completed Awaiting Confirmation release warning:', err.message);
      });
      extraUpdates.material_reserved = false;
      extraUpdates.material_reserved_qty = 0;
    }
    if (status === 'requester_confirmation') {
      extraUpdates.ready_at = 'NOW()';
      extraUpdates.completion_date = r.completion_date || 'NOW()';
      extraUpdates.lead_time_hours = `ROUND(EXTRACT(EPOCH FROM (NOW() - submitted_at))/3600, 2)`;
    }
    if (status === 'completed') {
      extraUpdates.completion_date        = 'NOW()';
      extraUpdates.requester_confirmation = true;
      extraUpdates.reception_confirmed_by = getUserName(req.user);
      extraUpdates.reception_confirmed_at = 'NOW()';
      if (reception_comment)   extraUpdates.reception_comment   = reception_comment;
      if (reception_condition) extraUpdates.reception_condition = reception_condition;
      if (final_quantity !== undefined) extraUpdates.final_quantity = final_quantity;
      if (lessons_learned) extraUpdates.lessons_learned = lessons_learned;
      extraUpdates.lead_time_hours = `ROUND(EXTRACT(EPOCH FROM (NOW() - submitted_at))/3600, 2)`;
    }
    if (status === 'archived')         { extraUpdates.archive_date = 'NOW()'; }

    // Reason fields
    if (status === 'more_info_required') {
      extraUpdates.info_required_at = 'NOW()';
      if (info_required_reason) extraUpdates.info_required_reason = info_required_reason;
    }
    if (rejection_reason)    extraUpdates.rejection_reason    = rejection_reason;
    if (blocking_reason)     extraUpdates.blocking_reason     = blocking_reason;
    if (on_hold_reason)      extraUpdates.on_hold_reason      = on_hold_reason;
    if (cancellation_reason) extraUpdates.cancellation_reason = cancellation_reason;
    if (rework_reason)       extraUpdates.rework_reason       = rework_reason;

    // Release reservation on cancel/reject
    if (['cancelled','rejected'].includes(status)) {
      await releaseReservation(client, {
        requestId: id, performedBy: req.user.id,
        performedByName: getUserName(req.user),
        reason: `Request ${status}`,
      }).catch(() => {});
    }

    // Quality fields
    if (quality_result) {
      extraUpdates.quality_result      = quality_result;
      extraUpdates.qc_approved_by_name = getUserName(req.user);
      extraUpdates.qc_date             = 'NOW()';
    }
    if (quality_notes)              extraUpdates.quality_notes  = quality_notes;
    if (qc_reference)               extraUpdates.qc_reference   = qc_reference;
    if (scrap_count !== undefined)  extraUpdates.scrap_count    = scrap_count;
    if (rework_required !== undefined) extraUpdates.rework_required = rework_required;
    if (business_impact)                    extraUpdates.business_impact      = business_impact;
    if (production_stop_risk !== undefined) extraUpdates.production_stop_risk = production_stop_risk;

    // ── Build SET clause ─────────────────────────────────────────────────
    const setClause = [`status = $1`];
    const values    = [status];
    let idx = 2;
    Object.entries(extraUpdates).forEach(([k, v]) => {
      if (v === 'NOW()') {
        setClause.push(`${k} = NOW()`);
      } else if (typeof v === 'string' && v.startsWith('ROUND(')) {
        setClause.push(`${k} = ${v}`);
      } else if (v && typeof v === 'object' && v.__op === 'add_number') {
        setClause.push(`${k} = COALESCE(${k}, 0) + $${idx++}`);
        values.push(v.value);
      } else if (v === null || v === undefined) {
        // skip nulls
      } else if (typeof v === 'boolean') {
        setClause.push(`${k} = $${idx++}::boolean`);
        values.push(v);
      } else {
        setClause.push(`${k} = $${idx++}`);
        values.push(v);
      }
    });
    values.push(id);

    const result = await client.query(
      `UPDATE print_requests SET ${setClause.join(', ')} WHERE id = $${idx} RETURNING *`, values
    );

    if (['requester_confirmation', 'completed', 'archived'].includes(status)) {
      await consumeMaterialForCompletedRequest(client, {
        request: result.rows[0],
        user: req.user,
      }).catch(err => console.warn('[Material] Final reservation release warning:', err.message));
    }

    await createStatusHistory(client, id, r.status, status, req.user.id,
      getUserName(req.user), comment);

    await createRequestAuditLog(client, {
      requestId: id,
      action: STATUS_AUDIT_ACTIONS[status] || (statusChanged ? 'status_change' : 'status_update'),
      user: req.user,
      before: r,
      after: result.rows[0],
      fields: ['status', ...Object.keys(extraUpdates)],
      extras: comment ? { status_comment: comment } : undefined,
      ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    });

    // ── Notifications ────────────────────────────────────────────────────
    let requesterEmailJob = null;

    if (statusChanged && REQUESTER_EMAIL_STATUSES.has(status)) {
      const updatedRequest = result.rows[0];
      const requestNumber = updatedRequest.request_number || r.request_number || id;
      const notificationType = `requester_status_${status}`;
      const subject = REQUESTER_STATUS_EMAILS[status]?.subject || '3D Print Request Update';
      let requesterUser = null;
      let requesterEmail = null;
      let requesterUserId = r.requester_id || null;

      if (r.requester_id) {
        const requester = await client.query(
          `SELECT id, email, is_active,
                  CASE WHEN is_active = true THEN 'Active' ELSE 'Inactive' END AS status
           FROM users
           WHERE id = $1`,
          [r.requester_id]
        );
        requesterUser = requester.rows[0] || null;
        requesterUserId = requesterUser?.id || r.requester_id;
        requesterEmail = requesterUser?.email || null;
      }

      requesterEmailJob = {
        requestId: id,
        requesterId: r.requester_id || null,
        requesterUser,
        requesterUserId,
        requesterEmail,
        requestNumber,
        status,
        subject,
        notificationType,
        updatedRequest,
        previousRequest: r,
        actorId: req.user.id,
        infoRequiredReason: info_required_reason,
        comment,
        rejectionReason: rejection_reason,
      };
    }

    const notifData = {
      approved:               { to: 'requester',    msg: 'Your request has been approved and will be planned soon.' },
      rejected:               { to: 'requester',    msg: `Your request has been rejected. Reason: ${rejection_reason || 'See production comments.'}` },
      assigned:               { to: 'both',         msg: 'Request assigned — technician can now start.' },
      completed:              { to: 'production',   msg: 'Request confirmed complete by requester.' },
      more_info_required:     { to: 'requester',    msg: 'Additional information is required. Please edit and resubmit your request.' },
      ready_for_pickup:       { to: 'requester',    msg: 'Your printed part is completed and awaiting your confirmation.' },
      requester_confirmation: { to: 'requester',    msg: 'Your part is awaiting your confirmation to close the request.' },
      blocked:                { to: 'production',   msg: `Request is blocked: ${blocking_reason || 'See production comments.'}` },
      on_hold:                { to: 'requester',    msg: 'Your request has been put on hold.' },
      cancelled:              { to: 'requester',    msg: 'Your request has been cancelled.' },
      submitted:              { to: 'production',   msg: `New request submitted by ${r.requester_name || 'requester'}. Please review.` },
      rework_required:        { to: 'production',   msg: 'Rework required on request — production flagged an issue.' },
      archived:               { to: 'requester',    msg: 'Your request has been archived.' },
      in_progress:            { to: 'production',   msg: `Printing started on request ${r.request_number}: "${r.title}"` },
      printed:                { to: 'production',   msg: `Printing completed on ${r.request_number}. Quality check pending.` },
      ready_for_pickup:       { to: 'production',   msg: `Request ${r.request_number} is completed by production and awaiting requester confirmation.` },
      requester_confirmation: { to: 'requester',    msg: `Request ${r.request_number} is awaiting your receipt confirmation.` },
    };

    // Manager notification events — all important workflow milestones
    const MANAGER_EVENTS = [
      'submitted',          // new request
      'approved',           // validated
      'rejected',           // rejected
      'in_progress',        // printing started
      'printed',            // printing done
      'quality_check',      // QC started
      'completed',          // request completed
      'archived',           // archived
      'blocked',            // blocked
      'rework_required',    // rework needed
    ];

    const nd = notifData[status];
    if (nd) {
      const baseTitle = `${r.request_number} — ${nd.msg.substring(0, 60)}`;
      const sendNotif = async (userId) => {
        if (!userId) return;
        await client.query(
          `INSERT INTO notifications (user_id, request_id, type, title, message) VALUES ($1,$2,$3,$4,$5)`,
          [userId, id, `status_${status}`, baseTitle, nd.msg]
        );
      };
      if (nd.to === 'requester' || nd.to === 'both') await sendNotif(r.requester_id);
      if (nd.to === 'production' || nd.to === 'both') {
        const coords = await client.query(`SELECT id FROM users WHERE role IN (${roleSqlList([...PRODUCTION_TECHNICIAN_ALIASES, 'administrator'])}) AND is_active = true`);
        for (const c of coords.rows) await sendNotif(c.id);
        if (status === 'assigned') await sendNotif(assigned_technician_id || r.assigned_technician_id);
      }
      if (['blocked','rework_required'].includes(status)) await sendNotif(r.requester_id);

      // Notify managers for key events
      if (MANAGER_EVENTS.includes(status)) {
        const managers = await client.query(
          `SELECT id FROM users WHERE role = 'manager' AND is_active = true`
        );
        for (const m of managers.rows) await sendNotif(m.id);
      }
    }

    await client.query('COMMIT');
    res.json(result.rows[0]);

    if (requesterEmailJob) {
      setImmediate(() => {
        processRequesterStatusEmailJob(requesterEmailJob)
          .catch((err) => console.error('[Email] Post-commit requester email job failed:', err.message));
      });
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[RequestStatus] Failed:', {
      message: err.message,
      detail: err.detail,
      code: err.code,
      stack: isDev ? err.stack : undefined,
    });
    res.status(500).json({ error: publicDbError(err) });
  } finally {
    client.release();
  }
};

// Add comment
exports.addComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { content, is_internal } = req.body;
    if (!content) return res.status(400).json({ error: 'Content required' });
    const result = await db.query(
      `INSERT INTO request_comments (request_id, user_id, user_name, content, is_internal) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, req.user.id, getUserName(req.user),
       content, is_internal && [PRODUCTION_TECHNICIAN,'manager','administrator'].includes(req.user.role)]
    );
    await createAuditLog({
      entityType: 'print_request',
      entityId: id,
      action: 'comment_added',
      performedBy: req.user.id,
      performedByName: getUserName(req.user),
      newValues: {
        comment_id: result.rows[0].id,
        content,
        is_internal: result.rows[0].is_internal,
      },
      ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// Delete request
exports.deleteRequest = async (req, res) => {
  if (!isAdministrator(req.user)) {
    return res.status(403).json({ error: 'Only administrators can delete requests' });
  }

  const client = await db.getClient();
  const filesToDelete = [];
  const requestUploadDir = path.resolve(uploadDir, req.params.id);
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const existing = await client.query('SELECT * FROM print_requests WHERE id = $1', [id]);
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const r = existing.rows[0];

    const attachments = await client.query(
      'SELECT id, file_path FROM request_attachments WHERE request_id = $1',
      [id]
    );
    attachments.rows.forEach((attachment) => {
      if (!attachment.file_path) return;
      const resolvedPath = path.resolve(attachment.file_path);
      if (resolvedPath.startsWith(path.resolve(uploadDir))) filesToDelete.push(resolvedPath);
    });

    await releaseRemainingReservationAfterProduction(client, {
      requestId: id,
      performedBy: req.user.id,
      performedByName: getUserName(req.user),
    }).catch((err) => {
      console.warn('[Material] Delete reservation release warning:', err.message);
    });

    await createAuditLog({
      client,
      entityType: 'print_request',
      entityId: id,
      action: 'request_deleted',
      performedBy: req.user.id,
      performedByName: getUserName(req.user),
      oldValues: r,
      ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    });

    const deleteIfPresent = async (sql, params = [id]) => {
      await client.query(sql, params).catch((err) => {
        if (!['42P01', '42703'].includes(err.code)) throw err;
      });
    };
    const attachmentIds = attachments.rows.map(a => a.id);

    if (attachmentIds.length) {
      await deleteIfPresent('DELETE FROM file_validation_logs WHERE attachment_id = ANY($1::uuid[])', [attachmentIds]);
      await deleteIfPresent('DELETE FROM file_download_logs WHERE attachment_id = ANY($1::uuid[])', [attachmentIds]);
    }
    await deleteIfPresent('DELETE FROM file_download_logs WHERE request_id = $1');
    await deleteIfPresent('DELETE FROM request_stl_metadata WHERE request_id = $1');
    await deleteIfPresent('DELETE FROM notification_history WHERE request_id = $1');
    await deleteIfPresent('DELETE FROM notifications WHERE request_id = $1');
    await deleteIfPresent('DELETE FROM request_satisfaction_surveys WHERE request_id = $1');
    await deleteIfPresent('DELETE FROM quality_checks WHERE request_id = $1');
    await deleteIfPresent('DELETE FROM request_production_cycles WHERE request_id = $1');
    await deleteIfPresent('UPDATE material_transactions SET request_id = NULL, reservation_id = NULL WHERE request_id = $1 OR reservation_id IN (SELECT id FROM material_reservations WHERE request_id = $1)');
    await deleteIfPresent('DELETE FROM material_reservations WHERE request_id = $1');
    await deleteIfPresent('DELETE FROM request_comments WHERE request_id = $1');
    await deleteIfPresent('DELETE FROM status_history WHERE request_id = $1');
    await deleteIfPresent('DELETE FROM request_attachments WHERE request_id = $1');
    await client.query('DELETE FROM print_requests WHERE id = $1', [id]);
    await client.query('COMMIT');

    for (const filePath of filesToDelete) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    if (requestUploadDir.startsWith(path.resolve(uploadDir)) && fs.existsSync(requestUploadDir)) {
      fs.rmSync(requestUploadDir, { recursive: true, force: true });
    }

    res.json({ message: 'Request deleted' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[RequestDelete] Failed:', {
      message: err.message,
      detail: err.detail,
      code: err.code,
      stack: isDev ? err.stack : undefined,
    });
    res.status(500).json({ error: publicDbError(err) });
  } finally {
    client.release();
  }
};
