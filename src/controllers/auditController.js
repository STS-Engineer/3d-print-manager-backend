const db = require('../config/database');

let ExcelJS;
try { ExcelJS = require('exceljs'); } catch (_) { ExcelJS = null; }

const display = (value) => {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const auditCategoryFor = (row) => {
  const action = String(row.action || '').toLowerCase();
  const oldValues = row.old_values || {};
  const newValues = row.new_values || {};
  const fields = Object.keys({ ...oldValues, ...newValues }).join(' ').toLowerCase();
  if (action.includes('archive') || fields.includes('archive')) return 'archive';
  if (['production_started', 'request_printed'].includes(action)) return 'production';
  if (['quality_check_started', 'rework_required'].includes(action)) return 'quality';
  if (['waiting_customer_confirmation', 'customer_confirmation_received'].includes(action)) return 'customer';
  if (action === 'request_assigned') return 'assignment';
  if (['request_planned', 'request_prioritized'].includes(action)) return 'planning';
  if (
    action.includes('request_') ||
    action.includes('workflow') ||
    action.includes('status') ||
    [
      'completeness_check',
      'feasibility_review',
      'more_info_required',
      'reschedule',
    ].includes(action) ||
    fields.includes('status')
  ) return 'workflow';
  if (action.includes('customer') || action.includes('confirmation') || fields.includes('reception_confirmed') || fields.includes('requester_confirmation')) return 'customer';
  if (action.includes('file') || action.includes('stl') || fields.includes('attachment') || fields.includes('original_name')) return 'attachment';
  if (fields.includes('printed') || fields.includes('duration') || fields.includes('material_used') || fields.includes('material_reserved')) return 'production';
  if (fields.includes('technician') || fields.includes('printer') || fields.includes('material_id') || action.includes('assign')) return 'assignment';
  if (fields.includes('planned') || fields.includes('due_date') || action.includes('reschedule')) return 'planning';
  if (fields.includes('cost') || fields.includes('price')) return 'cost';
  if (fields.includes('quality') || fields.includes('scrap') || fields.includes('rework') || action.includes('quality')) return 'quality';
  if (action.includes('comment') || fields.includes('comment') || fields.includes('content')) return 'comment';
  return 'workflow';
};

const majorAuditActions = new Set([
  'request_created',
  'request_submitted',
  'completeness_check',
  'feasibility_review',
  'request_approved',
  'request_rejected',
  'request_prioritized',
  'request_planned',
  'request_assigned',
  'production_started',
  'request_printed',
  'quality_check_started',
  'rework_required',
  'waiting_customer_confirmation',
  'customer_confirmation_received',
  'request_completed',
  'request_archived',
  'request_cancelled',
  'stl_uploaded',
  'stl_replaced',
  'stl_removed',
  'stl_metadata_generated',
]);

const collectIds = (rows) => {
  const ids = {
    users: new Set(),
    printers: new Set(),
    materials: new Set(),
    sites: new Set(),
    categories: new Set(),
  };

  rows.forEach(row => {
    const values = { ...(row.old_values || {}), ...(row.new_values || {}) };
    Object.entries(values).forEach(([field, value]) => {
      if (!value || typeof value !== 'string' || !UUID_RE.test(value)) return;
      if (['assigned_technician_id', 'technician_id', 'performed_by', 'archived_by'].includes(field)) ids.users.add(value);
      if (field === 'printer_id') ids.printers.add(value);
      if (field === 'material_id') ids.materials.add(value);
      if (field === 'site_id') ids.sites.add(value);
      if (field === 'category_id') ids.categories.add(value);
    });
  });

  return ids;
};

const queryNameMap = async (sql, ids, formatter) => {
  const list = Array.from(ids);
  if (!list.length) return {};
  const result = await db.query(sql, [list]);
  return Object.fromEntries(result.rows.map(row => [row.id, formatter(row)]));
};

const enrichAuditDisplayValues = async (rows) => {
  const ids = collectIds(rows);
  const [users, printers, materials, sites, categories] = await Promise.all([
    queryNameMap(`SELECT id, first_name, last_name, email FROM users WHERE id = ANY($1)`, ids.users, row =>
      [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email || row.id),
    queryNameMap(`SELECT id, name FROM printers WHERE id = ANY($1)`, ids.printers, row => row.name || row.id),
    queryNameMap(`SELECT id, name, type, color FROM materials WHERE id = ANY($1)`, ids.materials, row =>
      [row.name, row.color].filter(Boolean).join(' ') || row.type || row.id),
    queryNameMap(`SELECT id, name FROM sites WHERE id = ANY($1)`, ids.sites, row => row.name || row.id),
    queryNameMap(`SELECT id, name FROM request_categories WHERE id = ANY($1)`, ids.categories, row => row.name || row.id),
  ]);

  const resolve = (field, value) => {
    if (value === null || value === undefined || value === '') return value;
    if (typeof value !== 'string' || !UUID_RE.test(value)) return value;
    if (['assigned_technician_id', 'technician_id', 'performed_by', 'archived_by'].includes(field)) return users[value] || value;
    if (field === 'printer_id') return printers[value] || value;
    if (field === 'material_id') return materials[value] || value;
    if (field === 'site_id') return sites[value] || value;
    if (field === 'category_id') return categories[value] || value;
    return value;
  };

  return rows.map(row => {
    const oldValues = row.old_values || {};
    const newValues = row.new_values || {};
    const fields = Array.from(new Set([...Object.keys(oldValues), ...Object.keys(newValues)]));
    const displayValues = {};
    fields.forEach(field => {
      displayValues[field] = {
        old: resolve(field, oldValues[field]),
        new: resolve(field, newValues[field]),
      };
    });
    return {
      ...row,
      event_category: auditCategoryFor(row),
      display_values: displayValues,
    };
  });
};

const getRequestAuditRows = async (id, query = {}) => {
  const { performed_by, action, action_category, date_from, date_to, search } = query;
  const conditions = ['a.entity_id = $1'];
  const params = [id];
  let idx = 2;

  if (performed_by) { conditions.push(`a.performed_by = $${idx++}`); params.push(performed_by); }
  if (action)      { conditions.push(`a.action = $${idx++}`);       params.push(action); }
  if (date_from)   { conditions.push(`a.created_at::date >= $${idx++}::date`); params.push(date_from); }
  if (date_to)     { conditions.push(`a.created_at::date <= $${idx++}::date`); params.push(date_to); }
  if (search) {
    conditions.push(`(
      COALESCE(a.performed_by_name, '') ILIKE $${idx}
      OR COALESCE(a.action, '') ILIKE $${idx}
      OR COALESCE(a.old_values::text, '') ILIKE $${idx}
      OR COALESCE(a.new_values::text, '') ILIKE $${idx}
    )`);
    params.push(`%${search}%`);
    idx++;
  }

  const result = await db.query(`
    SELECT a.*, u.email AS performer_email, u.role AS performer_role
    FROM audit_logs a
    LEFT JOIN users u ON a.performed_by = u.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.created_at DESC
  `, params);
  const enrichedRows = await enrichAuditDisplayValues(result.rows);
  let rows = enrichedRows;
  if (query.scope === 'major') rows = rows.filter(row => majorAuditActions.has(row.action));
  if (action_category) rows = rows.filter(row => row.event_category === action_category);
  return { ...result, rows };
};

const flattenAuditRows = (rows) => {
  const output = [];
  rows.forEach(row => {
    const oldValues = row.old_values || {};
    const newValues = row.new_values || {};
    const fields = Array.from(new Set([
      ...Object.keys(oldValues || {}),
      ...Object.keys(newValues || {}),
    ]));

    if (!fields.length) {
      output.push({
        Date: row.created_at,
        User: row.performed_by_name || row.performer_email || 'System',
        Role: row.performer_role || '',
        Action: row.action,
        Field: '',
        'Old Value': '',
        'New Value': '',
      });
      return;
    }

    fields.forEach(field => {
      const displayValues = row.display_values?.[field] || {};
      output.push({
        Date: row.created_at,
        User: row.performed_by_name || row.performer_email || 'System',
        Role: row.performer_role || '',
        Action: row.action,
        Field: field,
        'Old Value': display(displayValues.old ?? oldValues?.[field]),
        'New Value': display(displayValues.new ?? newValues?.[field]),
      });
    });
  });
  return output;
};

const pdfSafe = (value) => display(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
  .replace(/\\/g, '\\\\')
  .replace(/\(/g, '\\(')
  .replace(/\)/g, '\\)');

const sendSimpleAuditPdf = (res, rows, requestId) => {
  const lines = [
    `Audit Trail - Request ${requestId}`,
    `Generated ${new Date().toLocaleString('en-GB')}`,
    '',
    ...rows.flatMap(row => [
      `${new Date(row.Date).toLocaleString('en-GB')} | ${row.User} | ${row.Role || 'Role n/a'} | ${row.Action}`,
      `${row.Field || 'Event'}: ${row['Old Value'] || '-'} -> ${row['New Value'] || '-'}`,
      '',
    ]),
  ];

  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pageIds = [];
  const fontId = 3;
  add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  for (let i = 0; i < lines.length; i += 42) {
    const chunk = lines.slice(i, i + 42);
    const content = [
      'BT',
      '/F1 9 Tf',
      '50 760 Td',
      ...chunk.map((line, index) => `${index === 0 ? '' : '0 -16 Td'}(${pdfSafe(line).slice(0, 115)}) Tj`),
      'ET',
    ].join('\n');
    const streamId = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(chunks.join('')));
    chunks.push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xrefOffset = Buffer.byteLength(chunks.join(''));
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach(offset => chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="request-${requestId}-audit-trail.pdf"`);
  res.send(Buffer.from(chunks.join(''), 'utf8'));
};

exports.getAuditLogs = async (req, res) => {
  try {
    const {
      entity_type, entity_id, performed_by,
      action, page = 1, limit = 50,
    } = req.query;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (entity_type) { conditions.push(`a.entity_type = $${idx++}`); params.push(entity_type); }
    if (entity_id)   { conditions.push(`a.entity_id = $${idx++}`);   params.push(entity_id); }
    if (performed_by){ conditions.push(`a.performed_by = $${idx++}`);params.push(performed_by); }
    if (action)      { conditions.push(`a.action = $${idx++}`);      params.push(action); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countRes = await db.query(`SELECT COUNT(*) FROM audit_logs a ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const result = await db.query(`
      SELECT a.*, u.email AS performer_email
      FROM audit_logs a
      LEFT JOIN users u ON a.performed_by = u.id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, parseInt(limit), offset]);

    res.json({
      logs: result.rows,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getRequestAuditLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await getRequestAuditRows(id, req.query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.exportRequestAuditLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const { format = 'excel' } = req.query;
    const result = await getRequestAuditRows(id, req.query);
    const rows = flattenAuditRows(result.rows);

    if (format === 'pdf') return sendSimpleAuditPdf(res, rows, id);
    if (!ExcelJS) return res.status(500).json({ error: 'Excel export is not available' });

    const wb = new ExcelJS.Workbook();
    wb.creator = '3D Print Manager';
    wb.created = new Date();
    const ws = wb.addWorksheet('Audit Trail', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = ['Date','User','Role','Action','Field','Old Value','New Value']
      .map(header => ({ header, key: header, width: Math.max(14, header.length + 4) }));
    rows.forEach(row => ws.addRow({
      ...row,
      Date: row.Date ? new Date(row.Date).toLocaleString('en-GB') : '',
    }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
    ws.columns.forEach(col => {
      let max = col.header.length;
      col.eachCell({ includeEmpty: false }, cell => { max = Math.max(max, String(cell.value || '').length); });
      col.width = Math.min(Math.max(max + 2, 14), 48);
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="request-${id}-audit-trail.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[Audit] Export failed:', err.message);
    res.status(500).json({ error: 'Audit export failed' });
  }
};
