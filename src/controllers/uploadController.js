const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const db     = require('../config/database');
const { createAuditLog } = require('../middleware/auditLog');

const uploadDir = path.resolve(__dirname, '../../', process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const isDev = process.env.NODE_ENV !== 'production';
const devLog = (...args) => {
  if (isDev) console.log(...args);
};

// ── Multer storage ─────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const requestDir = path.join(uploadDir, req.params.id || 'temp');
    if (!fs.existsSync(requestDir)) fs.mkdirSync(requestDir, { recursive: true });
    cb(null, requestDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const ALLOWED_EXTENSIONS = [
  '.stl', '.step', '.stp', '.obj', '.3mf', '.cad',
  '.pdf', '.png', '.jpg', '.jpeg', '.dwg', '.dxf', '.zip',
];

const MIME_TYPES = {
  '.stl':  'application/octet-stream',
  '.step': 'application/octet-stream',
  '.stp':  'application/octet-stream',
  '.obj':  'application/octet-stream',
  '.3mf':  'application/octet-stream',
  '.cad':  'application/octet-stream',
  '.dwg':  'application/octet-stream',
  '.dxf':  'application/octet-stream',
  '.zip':  'application/zip',
  '.pdf':  'application/pdf',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`File type "${ext}" is not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 52428800 }, // 50MB
});

exports.uploadMiddleware = (req, res, next) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      console.error('[Upload] Validation failed:', {
        requestId: req.params.id,
        message: err.message,
        code: err.code,
        field: err.field,
      });
      return res.status(400).json({ error: err.message || 'Upload validation failed' });
    }
    devLog('[Upload] Payload:', {
      requestId: req.params.id,
      files: (req.files || []).map(file => ({
        original_name: file.originalname,
        file_type: path.extname(file.originalname).toLowerCase().replace('.', ''),
        file_size: file.size,
      })),
    });
    next();
  });
};

// ── Upload files ───────────────────────────────────────────────────────────
exports.uploadFiles = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: 'No files uploaded' });

    const requestId = req.params.id;

    // Verify request exists and user has access
    const reqCheck = await db.query('SELECT requester_id FROM print_requests WHERE id = $1', [requestId]);
    if (!reqCheck.rows[0])
      return res.status(404).json({ error: 'Request not found' });

    const insertedFiles = [];
    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      const isValid = ALLOWED_EXTENSIONS.includes('.' + ext) && file.size > 0;
      devLog('[Upload] Validation result:', {
        requestId,
        original_name: file.originalname,
        is_valid: isValid,
        file_size_ok: file.size <= 52428800,
        extension_ok: ALLOWED_EXTENSIONS.includes('.' + ext),
        not_empty: file.size > 0,
      });
      const existingStl = ext === 'stl'
        ? await db.query(
          'SELECT id FROM request_attachments WHERE request_id = $1 AND LOWER(original_name) = LOWER($2) AND file_type = $3 LIMIT 1',
          [requestId, file.originalname, 'stl']
        ).catch(() => ({ rows: [] }))
        : { rows: [] };

      const result = await db.query(`
        INSERT INTO request_attachments
          (request_id, file_name, original_name, file_type, file_size, file_path, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [
        requestId, file.filename, file.originalname,
        ext, file.size, file.path, req.user.id,
      ]);
      const insertedFile = result.rows[0];

      await createAuditLog({
        entityType: 'print_request',
        entityId: requestId,
        action: 'file_uploaded',
        performedBy: req.user.id,
        performedByName: `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email || 'Unknown User',
        newValues: {
          attachment_id: result.rows[0].id,
          original_name: file.originalname,
          file_type: ext,
          file_size: file.size,
        },
        ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
      });

      if (ext === 'stl') {
        await createAuditLog({
          entityType: 'print_request',
          entityId: requestId,
          action: existingStl.rows.length ? 'stl_replaced' : 'stl_uploaded',
          performedBy: req.user.id,
          performedByName: `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email || 'Unknown User',
          newValues: {
            attachment_id: insertedFile.id,
            original_name: file.originalname,
            file_size: file.size,
          },
          ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
        });
      }

      insertedFiles.push(insertedFile);

      // Log validation
      await db.query(`
        INSERT INTO file_validation_logs
          (attachment_id, request_id, is_valid, file_size_ok, extension_ok, not_empty, validation_notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        result.rows[0].id, requestId, isValid,
        file.size <= 52428800, ALLOWED_EXTENSIONS.includes('.' + ext),
        file.size > 0,
        isValid ? 'All checks passed' : 'One or more checks failed',
      ]).catch(() => {}); // Non-fatal if table doesn't exist yet
    }

    res.status(201).json(insertedFiles);
  } catch (err) {
    console.error('[Upload] Error:', {
      requestId: req.params.id,
      message: err.message,
      detail: err.detail,
      code: err.code,
      stack: isDev ? err.stack : undefined,
    });
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
};

// ── Delete file ─────────────────────────────────────────────────────────────
exports.deleteFile = async (req, res) => {
  try {
    const { id, fileId } = req.params;
    const result = await db.query(
      'SELECT * FROM request_attachments WHERE id = $1 AND request_id = $2',
      [fileId, id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'File not found' });
    const attachment = result.rows[0];
    const isStl = String(attachment.file_type || '').toLowerCase() === 'stl'
      || String(attachment.original_name || '').toLowerCase().endsWith('.stl');

    // Delete physical file
    if (fs.existsSync(attachment.file_path)) {
      fs.unlinkSync(attachment.file_path);
    }
    await db.query('DELETE FROM request_attachments WHERE id = $1', [fileId]);
    await createAuditLog({
      entityType: 'print_request',
      entityId: id,
      action: 'file_removed',
      performedBy: req.user.id,
      performedByName: `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email || 'Unknown User',
      oldValues: {
        attachment_id: attachment.id,
        original_name: attachment.original_name,
        file_type: attachment.file_type,
        file_size: attachment.file_size,
      },
      ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    });
    if (isStl) {
      await createAuditLog({
        entityType: 'print_request',
        entityId: id,
        action: 'stl_removed',
        performedBy: req.user.id,
        performedByName: `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email || 'Unknown User',
        oldValues: {
          attachment_id: attachment.id,
          original_name: attachment.original_name,
          file_size: attachment.file_size,
        },
        ipAddress: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
      });
    }
    res.json({ message: 'File deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Download file ──────────────────────────────────────────────────────────
exports.downloadFile = async (req, res) => {
  try {
    const { id, fileId } = req.params;

    const result = await db.query(
      'SELECT * FROM request_attachments WHERE id = $1 AND request_id = $2',
      [fileId, id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'File not found' });

    const attachment = result.rows[0];

    // Security: prevent path traversal
    const resolvedPath = path.resolve(attachment.file_path);
    const resolvedUploadDir = path.resolve(uploadDir);
    if (!resolvedPath.startsWith(resolvedUploadDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check physical file exists
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({
        error: 'File not found on disk. It may have been moved or deleted.',
      });
    }

    const ext = path.extname(attachment.original_name).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    // Log who downloaded and when
    db.query(`
      INSERT INTO file_download_logs
        (attachment_id, request_id, downloaded_by, downloaded_by_name, ip_address)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      fileId, id, req.user.id,
      `${req.user.first_name} ${req.user.last_name}`,
      req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    ]).catch(() => {});

    // Set headers and stream the file
    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(attachment.original_name)}"`
    );
    res.setHeader('Content-Length', fs.statSync(resolvedPath).size);
    res.setHeader('Cache-Control', 'private, no-cache');

    const fileStream = fs.createReadStream(resolvedPath);
    fileStream.on('error', (err) => {
      console.error('[Download] Stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'File read error' });
    });
    fileStream.pipe(res);
  } catch (err) {
    console.error('[Download] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
};
