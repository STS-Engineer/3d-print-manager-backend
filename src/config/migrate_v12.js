/**
 * MIGRATION V12
 * - requester satisfaction survey table
 */
const db = require('./database');
require('dotenv').config();

const migrate_v12 = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS request_satisfaction_surveys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID NOT NULL UNIQUE REFERENCES print_requests(id) ON DELETE CASCADE,
        requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        overall_rating INTEGER NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
        quality_rating INTEGER NOT NULL CHECK (quality_rating BETWEEN 1 AND 5),
        delivery_rating INTEGER NOT NULL CHECK (delivery_rating BETWEEN 1 AND 5),
        communication_rating INTEGER NOT NULL CHECK (communication_rating BETWEEN 1 AND 5),
        fulfillment_result VARCHAR(40) NOT NULL CHECK (fulfillment_result IN ('fully_met','partially_met','not_met')),
        recommendation_score VARCHAR(20) NOT NULL CHECK (recommendation_score IN ('yes','maybe','no')),
        comment TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_satisfaction_request ON request_satisfaction_surveys(request_id);
      CREATE INDEX IF NOT EXISTS idx_satisfaction_requester ON request_satisfaction_surveys(requester_id);
      CREATE INDEX IF NOT EXISTS idx_satisfaction_created ON request_satisfaction_surveys(created_at);
    `);

    await client.query('COMMIT');
    console.log('Migration V12 completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration V12 failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate_v12().catch(console.error);
