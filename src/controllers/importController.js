const db = require('../config/database');
const fs = require('fs');
const { createAuditLog } = require('../middleware/auditLog');

const getUserName = (u) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Unknown';

const parseCsvLine = (row) => {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (const ch of row) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
};

const parseDate = (str) => {
  if (!str || str.trim() === '' || str.trim() === '-') return null;
  const d = new Date(str.replace(/"/g, '').trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
};

const mapPriority = (raw) => {
  if (!raw) return 'normal';
  const s = raw.toLowerCase();
  if (s.includes('critical') || s.includes('urgent')) return 'critical';
  if (s.includes('high')) return 'high';
  if (s.includes('low')) return 'low';
  return 'normal';
};

exports.importMondayCSV = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded. Use field name "csv".' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const raw = fs.readFileSync(req.file.path, 'utf-8').replace(/^\uFEFF/, '');
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'CSV file is empty or has no data rows' });
    }

    const headers = parseCsvLine(lines[0]).map(h => h.replace(/"/g, '').trim().toLowerCase());
    const variants = {
      title: ['title', 'name', 'item', 'task', 'request', 'request name', 'item name'],
      priority: ['priority', 'urgency'],
      requester: ['requester', 'owner', 'created by', 'person', 'contact'],
      department: ['department', 'dept', 'group', 'team'],
      due_date: ['due date', 'due', 'deadline', 'delivery date', 'requested due date'],
      description: ['description', 'notes', 'details', 'text', 'summary'],
      quantity: ['quantity', 'qty', 'count', 'number'],
      material: ['material', 'filament', 'material type'],
    };
    const col = (name) => {
      for (const v of variants[name] || [name]) {
        const idx = headers.findIndex(h => h.includes(v));
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const totalRows = lines.length - 1;
    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const get = (name) => {
        const idx = col(name);
        return idx >= 0 ? (cells[idx] || '').replace(/^"|"$/g, '').trim() : '';
      };

      const title = get('title');
      if (!title || title.length < 2) {
        skipped++;
        continue;
      }

      try {
        const year = new Date().getFullYear();
        const count = await client.query(
          'SELECT COUNT(*) FROM print_requests WHERE EXTRACT(YEAR FROM created_at) = $1',
          [year]
        );
        const num = `3DP-${year}-IMP${String(parseInt(count.rows[0].count, 10) + 1).padStart(4, '0')}`;
        const dueDate = parseDate(get('due_date'));

        await client.query(`
          INSERT INTO print_requests (
            request_number, title, requester_name, requester_department,
            status, priority, quantity, purpose, material_preference,
            requested_due_date, approved_due_date,
            archive_date, archived_by_name,
            created_at, updated_at, source
          ) VALUES ($1,$2,$3,$4,'archived',$5,$6,$7,$8,$9,$9,NOW(),$10,COALESCE($11, NOW()),NOW(),'monday')
          ON CONFLICT (request_number) DO NOTHING
        `, [
          num,
          title,
          get('requester') || 'Monday.com Import',
          get('department') || 'Imported',
          mapPriority(get('priority')),
          parseInt(get('quantity'), 10) || 1,
          get('description') || '',
          get('material') || '',
          dueDate,
          `Imported from Monday.com by ${getUserName(req.user)}`,
          dueDate,
        ]);
        imported++;
      } catch (rowErr) {
        errors.push(`Row ${i}: ${rowErr.message}`);
        skipped++;
      }
    }

    await client.query(`
      INSERT INTO monday_import_history
        (file_name, total_rows, imported_count, skipped_count, error_count, errors, imported_by, imported_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      req.file.originalname,
      totalRows,
      imported,
      skipped,
      errors.length,
      JSON.stringify(errors.slice(0, 50)),
      req.user.id,
      getUserName(req.user),
    ]).catch((err) => console.error('[Import] Failed to write import history:', err.message));

    await createAuditLog({
      entityType: 'import',
      entityId: null,
      action: 'monday_csv_import',
      performedBy: req.user.id,
      performedByName: getUserName(req.user),
      newValues: { totalRows, imported, skipped, errors: errors.length, file: req.file.originalname },
    });

    await client.query('COMMIT');
    fs.unlinkSync(req.file.path);

    res.json({
      message: 'Import completed',
      totalRows,
      imported,
      skipped,
      errorCount: errors.length,
      importedBy: getUserName(req.user),
      importDate: new Date().toISOString(),
      errors: errors.slice(0, 10),
      note: 'Imported records are stored as Monday.com historical archives and do not affect active workflows, stock, planning, or notifications.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('[Import]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

exports.getMondayImportHistory = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT *
      FROM monday_import_history
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('[Import] History error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.downloadTemplate = (req, res) => {
  const headers = [
    'Title', 'Status', 'Priority', 'Requester', 'Department', 'Due Date',
    'Description', 'Quantity', 'Material', 'Printer', 'Technician', 'Site',
  ];
  const rows = [
    headers,
    ['Cable support line P3', 'Done', 'High', 'Ahmed Ben Ali', 'Maintenance', '2026-05-15', 'Replacement part for line P3', '2', 'PLA Black', 'Prusa MK4', 'Technician Demo', 'SAME'],
    ['My Request 2', 'Done', 'Normal', 'Sara Trabelsi', 'Production', '2026-06-20', 'Historical request', '1', 'PETG', 'Ultimaker S5', 'Technician Demo', 'SCEET'],
  ];
  const csv = rows.map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="monday-import-template.csv"');
  res.send('\uFEFF' + csv);
};
