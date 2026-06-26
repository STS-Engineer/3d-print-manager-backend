const db = require('../config/database');

/**
 * Creates an audit log entry.
 * Call this inside controllers after any important action.
 */
const createAuditLog = async (options) => {
  const {
    client = db,
    entityType,
    entityId,
    action,
    performedBy,
    performedByName,
    oldValues = null,
    newValues = null,
    ipAddress = null,
  } = options;

  try {
    await client.query(
      `INSERT INTO audit_logs
        (entity_type, entity_id, action, performed_by, performed_by_name, old_values, new_values, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entityType,
        entityId,
        action,
        performedBy,
        performedByName,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        ipAddress,
      ]
    );
  } catch (err) {
    // Audit failure must never break the main flow
    console.error('[AuditLog] Failed to write:', err.message);
  }
};

module.exports = { createAuditLog };
