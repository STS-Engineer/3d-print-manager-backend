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

  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,

  ssl: isSSL
    ? { rejectUnauthorized: false } // required for Azure PostgreSQL
    : false,
});

// Logs
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
  console.log(`📦 DB: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
});

pool.on('error', (err) => {
  console.error('❌ Unexpected PostgreSQL error on idle client', err);
  process.exit(-1);
});

// Export helpers
module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};