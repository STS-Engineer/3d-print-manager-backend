const {
  getCostSummary,
  getCostBreakdown,
  getMonthlyCostTrend,
  getReworkCostSummary,
  getCostComponentBreakdown,
  getTopCostDrivers,
} = require('../services/costDashboardService');

const getFilters = (req) => ({
  site_id: req.query.site_id,
  date_from: req.query.date_from,
  date_to: req.query.date_to,
  month: req.query.month,
  year: req.query.year,
  material_id: req.query.material_id,
  printer_id: req.query.printer_id,
  technician_id: req.query.technician_id,
  priority: req.query.priority,
  status: req.query.status,
  requester_id: req.query.requester_id,
  requester: req.query.requester,
  criticality: req.query.criticality,
  production_status: req.query.production_status,
  approval_status: req.query.approval_status,
  delivery_status: req.query.delivery_status,
  department: req.query.department,
  category_id: req.query.category_id,
});

exports.getCostSummary = async (req, res) => {
  try {
    res.json(await getCostSummary(getFilters(req)));
  } catch (err) {
    console.error('[Cost Dashboard] Summary error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

const breakdownHandler = (dimension) => async (req, res) => {
  try {
    res.json(await getCostBreakdown(dimension, getFilters(req)));
  } catch (err) {
    console.error(`[Cost Dashboard] ${dimension} error:`, err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getCostBySite = breakdownHandler('site');
exports.getCostByMaterial = breakdownHandler('material');
exports.getCostByPrinter = breakdownHandler('printer');
exports.getCostByTechnician = breakdownHandler('technician');

exports.getMonthlyCostTrend = async (req, res) => {
  try {
    res.json(await getMonthlyCostTrend(getFilters(req)));
  } catch (err) {
    console.error('[Cost Dashboard] Monthly trend error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getReworkCostSummary = async (req, res) => {
  try {
    res.json(await getReworkCostSummary(getFilters(req)));
  } catch (err) {
    console.error('[Cost Dashboard] Rework cost error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getCostComponentBreakdown = async (req, res) => {
  try {
    res.json(await getCostComponentBreakdown(getFilters(req)));
  } catch (err) {
    console.error('[Cost Dashboard] Cost breakdown error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getTopCostDrivers = async (req, res) => {
  try {
    res.json(await getTopCostDrivers(getFilters(req)));
  } catch (err) {
    console.error('[Cost Dashboard] Top cost drivers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
