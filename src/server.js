const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { startSLAService } = require('./services/slaService');
const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const ESTIMATION_RESPONSE_KEYS = new Set([
  'estimated_weight_g',
  'estimated_material_usage_g',
  'estimated_material_usage_total_g',
  'estimated_weight_total_g',
  'estimated_print_time_minutes',
  'estimated_print_time_hours',
  'estimated_print_time_total_minutes',
  'estimated_printing_time',
  'estimated_cost',
  'estimated_total_cost',
  'estimated_production_cost',
  'estimated_machine_occupancy',
  'estimated_production_hours',
  'estimated_production_cost',
  'manual_estimated_material_usage',
  'manual_estimated_print_time',
  'manual_estimated_cost',
  'stl_metadata',
  'stl_material_cost',
  'stl_time_cost',
  'stl_fixed_cost',
  'stl_estimated_total_cost',
  'stl_variable_cost_per_g',
  'stl_machine_cost_per_minute',
  'stl_estimated_print_time_hours',
  'estimation_source',
  'cost_source',
  'system_estimate',
]);

const stripEstimationFields = (value) => {
  if (Array.isArray(value)) return value.map(stripEstimationFields);
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !ESTIMATION_RESPONSE_KEYS.has(key) && !/^estimated[A-Z]/.test(key))
      .map(([key, nested]) => [key, stripEstimationFields(nested)])
  );
};

app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => json(stripEstimationFields(body));
  next();
});

// Static files for uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// API routes
app.use('/api', require('./routes/index'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 3D Print Manager API running on http://localhost:${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
  // Start SLA overdue monitoring
  startSLAService();
});

module.exports = app;
