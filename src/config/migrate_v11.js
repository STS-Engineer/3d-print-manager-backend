/**
 * MIGRATION V11
 * - persistent email/notification delivery history
 */
const db = require('./database');
require('dotenv').config();

const migrate_v11 = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

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

    await client.query('COMMIT');
    console.log('Migration V11 completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration V11 failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate_v11().catch(console.error);
