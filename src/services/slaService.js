const db = require('../config/database');
const { sendMail } = require('./emailService');
const { PRODUCTION_TECHNICIAN_ALIASES, roleSqlList } = require('../utils/roles');

const formatDate = (value) => (value ? new Date(value).toLocaleDateString('fr-FR') : 'N/A');
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const buildOverdueEmail = (req) => ({
  subject: `OVERDUE request ${req.request_number}`,
  text: [
    'A 3D print request is overdue.',
    '',
    `Request: ${req.request_number}`,
    `Title: ${req.title}`,
    `Requester: ${req.requester_name || 'Unknown'}`,
    `Requested due date: ${formatDate(req.requested_due_date)}`,
    `Approved due date: ${formatDate(req.approved_due_date)}`,
    '',
    'Please review it in 3D Print Manager.',
  ].join('\n'),
  html: `
    <p>A 3D print request is <strong style="color:#dc2626;">overdue</strong>.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
      <tr><td><strong>Request</strong></td><td>${escapeHtml(req.request_number)}</td></tr>
      <tr><td><strong>Title</strong></td><td>${escapeHtml(req.title)}</td></tr>
      <tr><td><strong>Requester</strong></td><td>${escapeHtml(req.requester_name || 'Unknown')}</td></tr>
      <tr><td><strong>Requested due date</strong></td><td>${formatDate(req.requested_due_date)}</td></tr>
      <tr><td><strong>Approved due date</strong></td><td>${formatDate(req.approved_due_date)}</td></tr>
    </table>
    <p>Please review it in 3D Print Manager.</p>
  `,
});

/**
 * SLA Service - runs every 30 minutes
 * 1. Flags overdue requests when requested_due_date or approved_due_date is before today
 * 2. Creates in-app notifications for requester, production technicians/admins, and assigned technician
 * 3. Sends email to production technicians + administrators
 * 4. Stores overdue_notified_at so we do not spam
 */
const checkOverdueRequests = async () => {
  const client = await db.getClient();
  const emailJobs = [];

  try {
    await client.query('BEGIN');

    const overdueResult = await client.query(`
      SELECT
        r.id, r.request_number, r.title,
        r.requester_id, r.requester_name,
        r.requested_due_date, r.approved_due_date,
        r.assigned_technician_id
      FROM print_requests r
      WHERE (
          (r.requested_due_date IS NOT NULL AND r.requested_due_date < CURRENT_DATE)
          OR (r.approved_due_date IS NOT NULL AND r.approved_due_date < CURRENT_DATE)
        )
        AND r.status NOT IN ('completed','archived','requester_confirmation','waiting_customer_confirmation','cancelled','rejected')
        AND r.overdue_notified_at IS NULL
    `);

    if (overdueResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    for (const req of overdueResult.rows) {
      await client.query(
        `UPDATE print_requests
         SET is_overdue = true, overdue_notified_at = NOW()
         WHERE id = $1`,
        [req.id]
      );

      const dueDate = req.approved_due_date || req.requested_due_date;
      const msg = `Request ${req.request_number} - "${req.title}" is OVERDUE (due: ${formatDate(dueDate)}).`;

      if (req.requester_id) {
        await client.query(
          `INSERT INTO notifications (user_id, request_id, type, title, message)
           VALUES ($1, $2, 'overdue_alert', $3, $4)`,
          [req.requester_id, req.id, `OVERDUE: ${req.request_number}`, msg]
        );
      }

      const coordResult = await client.query(
        `SELECT id, email, is_active,
                CASE WHEN is_active = true THEN 'Active' ELSE 'Inactive' END AS status
         FROM users
         WHERE role IN (${roleSqlList([...PRODUCTION_TECHNICIAN_ALIASES, 'administrator'])}) AND is_active = true`
      );

      for (const coord of coordResult.rows) {
        await client.query(
          `INSERT INTO notifications (user_id, request_id, type, title, message)
           VALUES ($1, $2, 'overdue_alert', $3, $4)`,
          [coord.id, req.id, `OVERDUE: ${req.request_number}`, msg]
        );
      }

      const email = buildOverdueEmail(req);
      emailJobs.push({
        to: coordResult.rows,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });

      if (req.assigned_technician_id) {
        await client.query(
          `INSERT INTO notifications (user_id, request_id, type, title, message)
           VALUES ($1, $2, 'overdue_alert', $3, $4)`,
          [req.assigned_technician_id, req.id, `OVERDUE: ${req.request_number}`, msg]
        );
      }
    }

    await client.query('COMMIT');

    for (const job of emailJobs) {
      try {
        await sendMail(job);
      } catch (mailErr) {
        console.error('[SLA] Error sending overdue email:', mailErr.message);
      }
    }

    console.log(`[SLA] Flagged ${overdueResult.rows.length} overdue request(s).`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SLA] Error checking overdue:', err.message);
  } finally {
    client.release();
  }
};

/**
 * Update is_overdue flag for requests that were previously overdue
 * but are now completed (reset flag for consistency)
 */
const resetResolvedOverdue = async () => {
  try {
    await db.query(`
      UPDATE print_requests
      SET is_overdue = false
      WHERE is_overdue = true
        AND status IN ('completed','archived','requester_confirmation','cancelled','rejected')
    `);
  } catch (err) {
    console.error('[SLA] Error resetting resolved overdue:', err.message);
  }
};

const autoCompleteRequesterConfirmations = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const result = await client.query(`
      SELECT
        r.id,
        r.request_number,
        r.status,
        COALESCE(MAX(sh.created_at), r.ready_at, r.completion_date, r.created_at) AS confirmation_started_at
      FROM print_requests r
      LEFT JOIN status_history sh
        ON sh.request_id = r.id
       AND sh.to_status = 'requester_confirmation'
      WHERE r.status = 'requester_confirmation'
      GROUP BY r.id
      HAVING COALESCE(MAX(sh.created_at), r.ready_at, r.completion_date, r.created_at)
             <= NOW() - INTERVAL '7 days'
    `);

    for (const req of result.rows) {
      await client.query(`
        UPDATE print_requests
        SET status = 'completed',
            completion_date = COALESCE(completion_date, NOW()),
            reception_comment = COALESCE(reception_comment, 'Automatically completed after requester confirmation timeout.'),
            lead_time_hours = COALESCE(lead_time_hours, ROUND(EXTRACT(EPOCH FROM (NOW() - submitted_at))/3600, 2))
        WHERE id = $1
      `, [req.id]);

      await client.query(
        `INSERT INTO status_history
          (request_id, from_status, to_status, changed_by, changed_by_name, comment)
         VALUES ($1, 'requester_confirmation', 'completed', NULL, 'System', $2)`,
        [req.id, 'Automatically completed after requester confirmation timeout.']
      );

      await client.query(
        `INSERT INTO audit_logs
          (entity_type, entity_id, action, performed_by, performed_by_name, old_values, new_values)
         VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
        [
          'print_request',
          req.id,
          'auto_complete_requester_confirmation',
          'System',
          JSON.stringify({ status: 'requester_confirmation' }),
          JSON.stringify({
            status: 'completed',
            comment: 'Automatically completed after requester confirmation timeout.',
          }),
        ]
      ).catch((err) => console.error('[SLA] Auto-complete audit failed:', err.message));
    }

    await client.query('COMMIT');
    if (result.rows.length > 0) {
      console.log(`[SLA] Automatically completed ${result.rows.length} requester confirmation request(s).`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SLA] Error auto-completing requester confirmations:', err.message);
  } finally {
    client.release();
  }
};

/**
 * Start the SLA monitoring service
 * Call this once in server.js
 */
const startSLAService = () => {
  const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  checkOverdueRequests();
  resetResolvedOverdue();
  autoCompleteRequesterConfirmations();

  setInterval(() => {
    checkOverdueRequests();
    resetResolvedOverdue();
    autoCompleteRequesterConfirmations();
  }, INTERVAL_MS);

  console.log('[SLA] Overdue monitoring started (every 30 min)');
};

module.exports = { startSLAService, checkOverdueRequests, autoCompleteRequesterConfirmations };
