const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { normalizeRole } = require('../utils/roles');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
    return res.status(401).json({ error: 'Invalid token' });
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
