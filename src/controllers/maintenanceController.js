const db = require('../config/database');
const { createAuditLog } = require('../middleware/auditLog');

const dueSoonDays = parseInt(process.env.MAINTENANCE_DUE_SOON_DAYS || '14', 10);
const dueSoonHours = parseFloat(process.env.MAINTENANCE_DUE_SOON_HOURS || '50');

const actorName = (user) => `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email || user.id;

const statusForPrinter = (printer) => {
  const runtime = parseFloat(printer.total_runtime_hours || 0);
  const intervalHours = parseFloat(printer.maintenance_interval_hours || 0);
  const hoursSince = parseFloat(printer.hours_since_maintenance || 0);
  const nextDate = printer.next_maintenance_date ? new Date(printer.next_maintenance_date) : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dateOverdue = nextDate && nextDate <= today;
  const dateDueSoon = nextDate && ((nextDate - today) / 86400000) <= dueSoonDays;
  const hourOverdue = intervalHours > 0 && hoursSince >= intervalHours;
  const hourDueSoon = intervalHours > 0 && hoursSince >= Math.max(intervalHours - dueSoonHours, 0);

  if (dateOverdue || hourOverdue) return 'required';
  if (dateDueSoon || hourDueSoon) return 'due_soon';
  if (!runtime && !nextDate) return 'ok';
  return 'ok';
};

const decoratePrinter = (row) => ({
  ...row,
  total_runtime_hours: Math.round(parseFloat(row.total_runtime_hours || 0) * 10) / 10,
  print_hours: Math.round(parseFloat(row.print_hours || 0) * 10) / 10,
  machine_hours: Math.round(parseFloat(row.machine_hours || 0) * 10) / 10,
  hours_since_maintenance: Math.round(parseFloat(row.hours_since_maintenance || 0) * 10) / 10,
  maintenance_alert: statusForPrinter(row),
});

const buildMaintenancePrinterFilters = (query = {}, startIndex = 1, alias = 'p') => {
  const conditions = [];
  const params = [];
  let idx = startIndex;
  const add = (column, value) => {
    if (!value) return;
    conditions.push(`${alias}.${column} = $${idx++}`);
    params.push(value);
  };
  add('site_id', query.site_id);
  add('id', query.printer_id);
  return {
    sql: conditions.length ? ` AND ${conditions.join(' AND ')}` : '',
    params,
  };
};

const runtimeSql = `
  WITH request_hours AS (
    SELECT
      r.id,
      r.printer_id,
      COUNT(pc.id) FILTER (WHERE pc.start_time IS NOT NULL AND pc.end_time IS NOT NULL) AS timed_cycle_count,
      COALESCE(
        SUM(
          CASE
            WHEN pc.start_time IS NOT NULL AND pc.end_time IS NOT NULL
            THEN EXTRACT(EPOCH FROM (pc.end_time - pc.start_time)) / 3600.0
            ELSE NULL
          END
        ),
        CASE
          WHEN r.actual_start_time IS NOT NULL AND r.actual_end_time IS NOT NULL
          THEN EXTRACT(EPOCH FROM (r.actual_end_time - r.actual_start_time)) / 3600.0
          ELSE NULL
        END,
        r.actual_duration,
        0
      ) AS print_hours,
      CASE
        WHEN COUNT(pc.id) FILTER (WHERE pc.start_time IS NOT NULL AND pc.end_time IS NOT NULL) > 0 THEN 'cycle_history'
        WHEN r.actual_start_time IS NOT NULL AND r.actual_end_time IS NOT NULL THEN 'actual_start_end'
        WHEN r.actual_duration IS NOT NULL THEN 'actual_duration'
        ELSE 'missing_runtime'
      END AS runtime_source
    FROM print_requests r
    LEFT JOIN request_production_cycles pc ON pc.request_id = r.id
    WHERE COALESCE(r.source, 'application') <> 'monday'
      AND r.status IN ('completed','requester_confirmation','waiting_customer_confirmation','archived')
      AND r.printer_id IS NOT NULL
    GROUP BY r.id
  ),
  runtime AS (
    SELECT
      printer_id,
      SUM(print_hours) AS print_hours,
      COUNT(*) AS completed_job_count,
      COUNT(*) FILTER (WHERE runtime_source = 'cycle_history') AS cycle_history_jobs,
      COUNT(*) FILTER (WHERE runtime_source = 'actual_start_end') AS actual_start_end_jobs,
      COUNT(*) FILTER (WHERE runtime_source = 'actual_duration') AS actual_duration_jobs,
      COUNT(*) FILTER (WHERE runtime_source = 'missing_runtime') AS missing_runtime_jobs
    FROM request_hours
    GROUP BY printer_id
  ),
  last_maintenance AS (
    SELECT DISTINCT ON (printer_id)
      printer_id,
      maintenance_date,
      created_at
    FROM printer_maintenance_events
    WHERE status = 'completed'
    ORDER BY printer_id, maintenance_date DESC, created_at DESC
  ),
  runtime_since AS (
    SELECT r.printer_id, SUM(r.print_hours) AS hours_since_maintenance
    FROM request_hours r
    LEFT JOIN last_maintenance lm ON lm.printer_id = r.printer_id
    LEFT JOIN print_requests pr ON pr.id = r.id
    WHERE lm.maintenance_date IS NULL
       OR COALESCE(pr.completion_date, pr.actual_end_time, pr.updated_at, pr.created_at)::date >= lm.maintenance_date
    GROUP BY r.printer_id
  )
`;

exports.getMaintenanceOverview = async (req, res) => {
  try {
    const result = await db.query(`
      ${runtimeSql}
      SELECT
        p.*,
        s.name AS site_name,
        COALESCE(runtime.print_hours, 0) AS print_hours,
        COALESCE(runtime.print_hours, 0) AS machine_hours,
        COALESCE(p.total_operating_hours, 0) + COALESCE(runtime.print_hours, 0) AS total_runtime_hours,
        COALESCE(runtime_since.hours_since_maintenance, 0) AS hours_since_maintenance,
        COALESCE(runtime.completed_job_count, 0) AS completed_job_count,
        COALESCE(runtime.cycle_history_jobs, 0) AS cycle_history_jobs,
        COALESCE(runtime.actual_start_end_jobs, 0) AS actual_start_end_jobs,
        COALESCE(runtime.actual_duration_jobs, 0) AS actual_duration_jobs,
        COALESCE(runtime.missing_runtime_jobs, 0) AS missing_runtime_jobs,
        COALESCE(p.last_maintenance_date, lm.maintenance_date) AS effective_last_maintenance_date
      FROM printers p
      LEFT JOIN sites s ON p.site_id = s.id
      LEFT JOIN runtime ON runtime.printer_id = p.id
      LEFT JOIN runtime_since ON runtime_since.printer_id = p.id
      LEFT JOIN last_maintenance lm ON lm.printer_id = p.id
      WHERE p.is_active = true
      ORDER BY p.name
    `);

    const printers = result.rows.map(decoratePrinter);
    const events = await db.query('SELECT COUNT(*) AS count FROM printer_maintenance_events');
    res.json({
      printers,
      summary: {
        totalPrinters: printers.length,
        dueSoon: printers.filter(p => p.maintenance_alert === 'due_soon').length,
        overdue: printers.filter(p => p.maintenance_alert === 'required').length,
        totalMaintenanceEvents: parseInt(events.rows[0].count || 0, 10),
      },
    });
  } catch (err) {
    console.error('[Maintenance] Overview failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getMaintenanceHistory = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT e.*, p.name AS printer_name, p.serial_number, p.model
      FROM printer_maintenance_events e
      JOIN printers p ON e.printer_id = p.id
      ORDER BY e.maintenance_date DESC, e.created_at DESC
      LIMIT 500
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('[Maintenance] History failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.createMaintenanceEvent = async (req, res) => {
  const client = await db.getClient();
  try {
    const {
      printer_id, performed_by, performed_by_name, maintenance_type,
      status = 'completed', maintenance_date, completed_at, notes,
      downtime_hours, next_maintenance_date,
    } = req.body;
    if (!printer_id) return res.status(400).json({ error: 'Printer is required' });
    await client.query('BEGIN');

    const result = await client.query(`
      INSERT INTO printer_maintenance_events (
        printer_id, performed_by, performed_by_name, maintenance_type, status,
        maintenance_date, completed_at, notes, downtime_hours, created_by, created_by_name
      )
      VALUES ($1,$2,$3,$4,$5,COALESCE($6, CURRENT_DATE),$7,$8,COALESCE($9,0),$10,$11)
      RETURNING *
    `, [
      printer_id, performed_by || null, performed_by_name || null, maintenance_type || 'preventive',
      status, maintenance_date || null, completed_at || (status === 'completed' ? new Date() : null),
      notes || null, downtime_hours || 0, req.user.id, actorName(req.user),
    ]);

    if (status === 'completed') {
      await client.query(`
        UPDATE printers
        SET last_maintenance_date = COALESCE($1, CURRENT_DATE),
            next_maintenance_date = COALESCE($2, next_maintenance_date),
            status = CASE WHEN status = 'maintenance' THEN 'available' ELSE status END
        WHERE id = $3
      `, [maintenance_date || null, next_maintenance_date || null, printer_id]);
    } else if (next_maintenance_date) {
      await client.query('UPDATE printers SET next_maintenance_date = $1 WHERE id = $2', [next_maintenance_date, printer_id]);
    }

    await createAuditLog({
      client,
      entityType: 'printer_maintenance',
      entityId: result.rows[0].id,
      action: status === 'completed' ? 'maintenance_completed' : 'maintenance_created',
      performedBy: req.user.id,
      performedByName: actorName(req.user),
      newValues: result.rows[0],
    });

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Maintenance] Create failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
};

exports.rescheduleMaintenance = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { maintenance_date, next_maintenance_date, notes } = req.body;
    const before = await client.query('SELECT * FROM printer_maintenance_events WHERE id = $1', [id]);
    if (!before.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Maintenance event not found' });
    }

    const result = await client.query(`
      UPDATE printer_maintenance_events
      SET maintenance_date = COALESCE($1, maintenance_date),
          notes = COALESCE($2, notes),
          status = 'rescheduled'
      WHERE id = $3
      RETURNING *
    `, [maintenance_date || null, notes || null, id]);

    await client.query(
      'UPDATE printers SET next_maintenance_date = COALESCE($1, $2, next_maintenance_date) WHERE id = $3',
      [next_maintenance_date || null, maintenance_date || null, result.rows[0].printer_id]
    );

    await createAuditLog({
      client,
      entityType: 'printer_maintenance',
      entityId: id,
      action: 'maintenance_rescheduled',
      performedBy: req.user.id,
      performedByName: actorName(req.user),
      oldValues: before.rows[0],
      newValues: result.rows[0],
    });

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Maintenance] Reschedule failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
};

exports.getMaintenanceSummary = async (req, res) => {
  try {
    const printerFilter = buildMaintenancePrinterFilters(req.query);
    const overview = await db.query(`
      ${runtimeSql}
      SELECT
        p.*,
        COALESCE(runtime.print_hours, 0) AS print_hours,
        COALESCE(runtime.print_hours, 0) AS machine_hours,
        COALESCE(p.total_operating_hours, 0) + COALESCE(runtime.print_hours, 0) AS total_runtime_hours,
        COALESCE(runtime_since.hours_since_maintenance, 0) AS hours_since_maintenance,
        COALESCE(runtime.completed_job_count, 0) AS completed_job_count,
        COALESCE(runtime.cycle_history_jobs, 0) AS cycle_history_jobs,
        COALESCE(runtime.actual_start_end_jobs, 0) AS actual_start_end_jobs,
        COALESCE(runtime.actual_duration_jobs, 0) AS actual_duration_jobs,
        COALESCE(runtime.missing_runtime_jobs, 0) AS missing_runtime_jobs
      FROM printers p
      LEFT JOIN runtime ON runtime.printer_id = p.id
      LEFT JOIN runtime_since ON runtime_since.printer_id = p.id
      LEFT JOIN last_maintenance lm ON lm.printer_id = p.id
      WHERE p.is_active = true
        ${printerFilter.sql}
    `, printerFilter.params);
    const printers = overview.rows.map(decoratePrinter);
    const events = await db.query('SELECT COUNT(*) AS count FROM printer_maintenance_events');
    res.json({
      totalPrinters: printers.length,
      dueSoon: printers.filter(p => p.maintenance_alert === 'due_soon').length,
      overdue: printers.filter(p => p.maintenance_alert === 'required').length,
      totalMaintenanceEvents: parseInt(events.rows[0].count || 0, 10),
    });
  } catch (err) {
    console.error('[Maintenance] Summary failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};
