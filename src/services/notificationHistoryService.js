const ensureNotificationHistoryTable = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS notification_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id UUID REFERENCES print_requests(id) ON DELETE SET NULL,
      recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      recipient_email VARCHAR(255),
      type VARCHAR(100) NOT NULL,
      subject TEXT,
      status VARCHAR(20) NOT NULL,
      reason TEXT,
      provider_message_id TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_history_request ON notification_history(request_id);
    CREATE INDEX IF NOT EXISTS idx_notification_history_created ON notification_history(created_at);
    CREATE INDEX IF NOT EXISTS idx_notification_history_status ON notification_history(status);
  `);
};

const recordNotificationHistory = async (client, {
  requestId = null,
  recipientUserId = null,
  recipientEmail = null,
  type,
  subject = null,
  status,
  reason = null,
  providerMessageId = null,
  metadata = {},
}, options = {}) => {
  const savepoint = options.useSavepoint ? `notification_history_${Date.now()}` : null;
  try {
    if (savepoint) await client.query(`SAVEPOINT ${savepoint}`);

    await ensureNotificationHistoryTable(client);
    await client.query(
      `INSERT INTO notification_history (
         request_id, recipient_user_id, recipient_email, type, subject,
         status, reason, provider_message_id, metadata
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        requestId,
        recipientUserId,
        recipientEmail,
        type,
        subject,
        status,
        reason,
        providerMessageId,
        JSON.stringify(metadata || {}),
      ]
    );

    if (savepoint) await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (err) {
    if (savepoint) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => {});
      await client.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => {});
    }
    console.error('[NotificationHistory] Failed to record notification history:', err.message);
  }
};

module.exports = {
  ensureNotificationHistoryTable,
  recordNotificationHistory,
};
