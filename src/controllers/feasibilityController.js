const getUserName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Unknown';

const db = require('../config/database');
const { createAuditLog } = require('../middleware/auditLog');
const { PRODUCTION_TECHNICIAN_ALIASES, roleSqlList } = require('../utils/roles');

// GET feasibility review for a request
exports.getFeasibility = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT f.id, f.request_id, f.reviewed_by, f.reviewed_by_name, f.review_date,
              f.is_printable, f.machine_compatible, f.material_available,
              f.technical_notes, f.result, f.created_at,
              u.email AS reviewer_email
       FROM feasibility_reviews f
       LEFT JOIN users u ON f.reviewed_by = u.id
       WHERE f.request_id = $1
       ORDER BY f.created_at DESC LIMIT 1`,
      [id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// CREATE or UPDATE feasibility review
exports.saveFeasibility = async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const {
      is_printable, machine_compatible, material_available,
      technical_notes, result,
    } = req.body;

    // Check request exists
    const reqCheck = await client.query('SELECT id, title FROM print_requests WHERE id = $1', [id]);
    if (!reqCheck.rows[0]) return res.status(404).json({ error: 'Request not found' });

    // Upsert feasibility review
    const existing = await client.query(
      'SELECT * FROM feasibility_reviews WHERE request_id = $1', [id]
    );

    let feas;
    if (existing.rows[0]) {
      feas = await client.query(`
        UPDATE feasibility_reviews SET
          reviewed_by = $1, reviewed_by_name = $2, review_date = NOW(),
          is_printable = $3::boolean, machine_compatible = $4::boolean, material_available = $5::boolean,
          technical_notes = $6, result = $7
        WHERE request_id = $8 RETURNING *
      `, [
        req.user.id, getUserName(req.user),
        is_printable, machine_compatible, material_available,
        technical_notes, result || 'pending',
        id
      ]);
    } else {
      feas = await client.query(`
        INSERT INTO feasibility_reviews
          (request_id, reviewed_by, reviewed_by_name, is_printable, machine_compatible,
           material_available, technical_notes, result)
        VALUES ($1,$2,$3,$4::boolean,$5::boolean,$6::boolean,$7,$8) RETURNING *
      `, [
        id, req.user.id, getUserName(req.user),
        is_printable, machine_compatible, material_available,
        technical_notes, result || 'pending'
      ]);
    }

    // Update print_request feasibility summary
    await client.query(`
      UPDATE print_requests SET
        feasibility_result = $1, feasibility_comment = $2,
        feasibility_by_name = $3, feasibility_date = NOW()
      WHERE id = $4
    `, [result, technical_notes, `${req.user.first_name} ${req.user.last_name}`, id]);

    await createAuditLog({
      client,
      entityType: 'feasibility_review', entityId: id,
      action: existing.rows[0] ? 'update' : 'create',
      performedBy: req.user.id,
      performedByName: `${req.user.first_name} ${req.user.last_name}`,
      oldValues: existing.rows[0] ? {
        result: existing.rows[0].result,
        is_printable: existing.rows[0].is_printable,
        machine_compatible: existing.rows[0].machine_compatible,
        material_available: existing.rows[0].material_available,
        technical_notes: existing.rows[0].technical_notes,
      } : null,
      newValues: { result, is_printable, machine_compatible, material_available, technical_notes },
    });

    await client.query('COMMIT');

    // Notify production technicians that feasibility was completed
    const reqInfo = await db.query('SELECT request_number, title, requester_id FROM print_requests WHERE id = $1', [id]);
    if (reqInfo.rows[0]) {
      const ri = reqInfo.rows[0];
      const msg = `Feasibility review completed for ${ri.request_number}: "${ri.title}" — Result: ${result || 'pending'}`;
      db.query(`SELECT id FROM users WHERE role IN (${roleSqlList([...PRODUCTION_TECHNICIAN_ALIASES, 'administrator'])}) AND is_active = true`)
        .then(coords => coords.rows.forEach(c => {
          db.query(
            `INSERT INTO notifications (user_id, request_id, type, title, message) VALUES ($1,$2,'feasibility_done',$3,$4)`,
            [c.id, id, `Feasibility done — ${ri.request_number}`, msg]
          ).catch(() => {});
        })).catch(() => {});
    }

    res.json(feas.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
};
