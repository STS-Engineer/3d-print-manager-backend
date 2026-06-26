const db = require('../config/database');
const { createAuditLog } = require('../middleware/auditLog');
const { consumeMaterialForCompletedRequest } = require('../services/materialService');

// GET archived requests (paginated)
exports.getArchive = async (req, res) => {
  try {
    const { search, department, priority, date_from, date_to, requester, source, page = 1, limit = 25 } = req.query;
    const conditions = [`r.status = 'archived'`];
    const params = [];
    let idx = 1;

    if (search) {
      const s1 = idx++, s2 = idx++, s3 = idx++;
      conditions.push(`(r.title ILIKE $${s1} OR r.request_number ILIKE $${s2} OR r.requester_name ILIKE $${s3})`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (department) {
      conditions.push(`r.requester_department ILIKE $${idx++}`);
      params.push(`%${department}%`);
    }
    if (priority) {
      conditions.push(`r.priority = $${idx++}`);
      params.push(priority);
    }
    if (requester) {
      conditions.push(`r.requester_name ILIKE $${idx++}`);
      params.push(`%${requester}%`);
    }
    if (date_from) {
      conditions.push(`r.archive_date >= $${idx++}`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`r.archive_date <= $${idx++} + INTERVAL '1 day'`);
      params.push(date_to);
    }
    if (source === 'monday') {
      conditions.push(`r.source = 'monday'`);
    } else if (source === 'application') {
      conditions.push(`COALESCE(r.source, 'application') <> 'monday'`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countRes = await db.query(`SELECT COUNT(*) FROM print_requests r ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const result = await db.query(`
      SELECT
        r.id, r.request_number, r.title, r.requester_name, r.requester_department,
        r.priority, r.completion_date, r.archive_date, r.archived_by_name,
        COALESCE(r.source, 'application') AS source,
        r.quality_result, r.actual_duration, r.material_used_grams,
        p.name AS printer_name, m.name AS material_name,
        u.first_name || ' ' || u.last_name AS technician_name,
        c.name AS category_name
      FROM print_requests r
      LEFT JOIN printers p ON r.printer_id = p.id
      LEFT JOIN materials m ON r.material_id = m.id
      LEFT JOIN users u ON r.assigned_technician_id = u.id
      LEFT JOIN request_categories c ON r.category_id = c.id
      ${where}
      ORDER BY r.archive_date DESC NULLS LAST
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, parseInt(limit), offset]);

    res.json({
      requests: result.rows,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /archive/:id - archive a completed/cancelled request
exports.archiveRequest = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { lessons_learned } = req.body;

    const existing = await client.query(
      `SELECT * FROM print_requests WHERE id = $1`, [id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Request not found' });

    const r = existing.rows[0];
    if (!['completed', 'requester_confirmation', 'cancelled', 'rejected'].includes(r.status)) {
      return res.status(400).json({
        error: `Cannot archive a request with status "${r.status}". Only completed, waiting confirmation, cancelled, or rejected requests can be archived.`,
      });
    }

    const result = await client.query(`
      UPDATE print_requests SET
        status          = 'archived',
        archive_date    = NOW(),
        archived_by     = $1,
        archived_by_name = $2,
        lessons_learned = COALESCE($3, lessons_learned)
      WHERE id = $4 RETURNING *
    `, [req.user.id, `${req.user.first_name} ${req.user.last_name}`, lessons_learned, id]);

    await consumeMaterialForCompletedRequest(client, {
      request: result.rows[0],
      user: req.user,
    }).catch(err => console.warn('[Material] Archive consumption warning:', err.message));

    // Status history
    await client.query(`
      INSERT INTO status_history (request_id, from_status, to_status, changed_by, changed_by_name, comment)
      VALUES ($1, $2, 'archived', $3, $4, 'Request archived')
    `, [id, r.status, req.user.id, `${req.user.first_name} ${req.user.last_name}`]);

    await createAuditLog({
      client,
      entityType: 'print_request', entityId: id,
      action: 'request_archived',
      performedBy: req.user.id,
      performedByName: `${req.user.first_name} ${req.user.last_name}`,
      oldValues: { status: r.status },
      newValues: { status: 'archived', archive_date: result.rows[0].archive_date, lessons_learned },
    });

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  } finally {
    client.release();
  }
};

// POST /archive/bulk - archive multiple requests at once
exports.bulkArchive = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });

    const before = await client.query(
      `SELECT id, request_number, status
       FROM print_requests
       WHERE id = ANY($1)
         AND status IN ('completed','requester_confirmation','cancelled','rejected')`,
      [ids]
    );

    const result = await client.query(`
      UPDATE print_requests SET
        status           = 'archived',
        archive_date     = NOW(),
        archived_by      = $1,
        archived_by_name = $2
      WHERE id = ANY($3)
        AND status IN ('completed','requester_confirmation','cancelled','rejected')
      RETURNING id, request_number
    `, [req.user.id, `${req.user.first_name} ${req.user.last_name}`, ids]);

    const previousById = new Map(before.rows.map(row => [row.id, row]));
    for (const row of result.rows) {
      const previous = previousById.get(row.id);
      await client.query(`
        INSERT INTO status_history (request_id, from_status, to_status, changed_by, changed_by_name, comment)
        VALUES ($1, $2, 'archived', $3, $4, 'Request archived in bulk')
      `, [row.id, previous?.status || null, req.user.id, `${req.user.first_name} ${req.user.last_name}`]);

      await createAuditLog({
        client,
        entityType: 'print_request',
        entityId: row.id,
        action: 'request_archived',
        performedBy: req.user.id,
        performedByName: `${req.user.first_name} ${req.user.last_name}`,
        oldValues: { status: previous?.status || null },
        newValues: { status: 'archived', bulk_archive: true },
      });
    }

    await client.query('COMMIT');
    res.json({ archived: result.rows, count: result.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
};

// GET archive stats
exports.getArchiveStats = async (req, res) => {
  try {
    const { source } = req.query;
    const conditions = [`status = 'archived'`];
    if (source === 'monday') {
      conditions.push(`source = 'monday'`);
    } else if (source === 'application') {
      conditions.push(`COALESCE(source, 'application') <> 'monday'`);
    }

    const result = await db.query(`
      SELECT
        COUNT(*)                                                          AS total_archived,
        COUNT(*) FILTER (WHERE quality_result = 'pass')                  AS passed_qc,
        COUNT(*) FILTER (WHERE rework_required = true)                   AS had_rework,
        COUNT(*) FILTER (WHERE scrap_count > 0)                          AS had_failures,
        ROUND(AVG(actual_duration)::NUMERIC, 2)                          AS avg_print_hours,
        ROUND(AVG(material_used_grams)::NUMERIC, 2)                      AS avg_material_g,
        MIN(archive_date)                                                 AS oldest_archived,
        MAX(archive_date)                                                 AS latest_archived
      FROM print_requests WHERE ${conditions.join(' AND ')}
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
