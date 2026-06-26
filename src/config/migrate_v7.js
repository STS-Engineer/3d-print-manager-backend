/**
 * MIGRATION V7
 * - hide Post-Processing from the configurable workflow catalog
 * - clarify ready/requester confirmation labels
 */
const db = require('./database');
require('dotenv').config();

const migrate_v7 = async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.workflow_statuses') IS NOT NULL THEN
          UPDATE workflow_statuses
          SET is_active = false
          WHERE code = 'post_processing';

          UPDATE workflow_statuses
          SET label = 'Completed Awaiting Confirmation'
          WHERE code = 'ready_for_pickup';

          UPDATE workflow_statuses
          SET label = 'Awaiting Requester Confirmation'
          WHERE code = 'requester_confirmation';
        END IF;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('Migration V7 completed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration V7 failed:', err.message);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
};

migrate_v7().catch(console.error);
