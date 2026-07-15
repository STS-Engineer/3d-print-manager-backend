const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { normalizeRole } = require('../utils/roles');

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];

  // 1. Vérification JWT isolée : si ça échoue, c'est un vrai problème d'auth
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // 2. Requête DB isolée : si ça échoue, ce n'est PAS un problème d'auth
  try {
    const result = await db.query(
      'SELECT id, email, first_name, last_name, department, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (!result.rows[0] || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }
    req.user = {
      ...result.rows[0],
      role: normalizeRole(result.rows[0].role),
      stored_role: result.rows[0].role,
    };
    next();
  } catch (err) {
    console.error('[auth middleware] DB error during auth check:', {
      message: err.message,
      name: err.name,
      url: req.originalUrl,
      method: req.method,
    });
    // Erreur d'infrastructure, PAS d'authentification : 503, pas 401
    return res.status(503).json({ error: 'Service temporarily unavailable, please retry' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  const allowedRoles = roles.map(normalizeRole);
  if (!allowedRoles.includes(normalizeRole(req.user.role))) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

module.exports = { authenticate, authorize };