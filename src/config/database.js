const { Pool } = require('pg');
require('dotenv').config();

// SSL activation (Azure PostgreSQL requires SSL)
const isSSL = process.env.DB_SSL === 'true';

// Safety check (fail fast if config missing)
if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_PASSWORD || !process.env.DB_NAME) {
  console.error('❌ Missing database environment variables');
  console.error({
    DB_HOST: process.env.DB_HOST,
    DB_USER: process.env.DB_USER,
    DB_NAME: process.env.DB_NAME,
    DB_PASSWORD: process.env.DB_PASSWORD ? '***' : undefined,
  });
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  max: 30,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,

  ssl: isSSL
    ? { rejectUnauthorized: false } // required for Azure PostgreSQL
    : false,
});

// IMPORTANT: an idle-client error must NEVER crash the whole server.
// pg emits 'error' on the pool when a connection that is sitting idle
// gets dropped by the network/Azure (very common after latency spikes,
// firewall resets, or DNS hiccups). The pool itself recovers fine on
// its own by discarding that client and opening a new one on next use.
// Killing the process here was causing full backend crashes mid-session,
// which looked like random 401s / connection-refused on the frontend
// whenever several requests fired in parallel right after login.
pool.on('error', (err) => {
  console.error('⚠️ Unexpected PostgreSQL error on idle client (pool will recover):', {
    message: err.message,
    code: err.code,
    stack: err.stack,
  });
  // Do NOT process.exit here.
});

// Export helpers
module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};