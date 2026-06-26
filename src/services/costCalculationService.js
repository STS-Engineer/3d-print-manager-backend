const db = require('../config/database');
const { FIXED_COST } = require('./costConfig');

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const roundOne = (value) => Math.round((Number(value) + Number.EPSILON) * 10) / 10;

// Normalise les virgules décimales françaises avant parseFloat
const normalizeDecimal = (value) => {
  if (value === null || value === undefined) return value;
  return String(value).replace(',', '.');
};

const parsePositive = (value) => {
  const n = parseFloat(normalizeDecimal(value));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const getConfiguredRates = async ({ materialId, printerId, client = db }) => {
  const [material, printer] = await Promise.all([
    materialId
      ? client.query(
        `SELECT id, name, type, unit, cost_per_unit, currency, density_g_cm3
         FROM materials WHERE id = $1`,
        [materialId]
      ).catch(() => ({ rows: [] }))
      : { rows: [] },
    printerId
      ? client.query(
        `SELECT id, name, model, cost_per_minute, print_speed, setup_factor, efficiency_factor
         FROM printers WHERE id = $1`,
        [printerId]
      ).catch(() => ({ rows: [] }))
      : { rows: [] },
  ]);

  return {
    material: material.rows[0] || null,
    printer: printer.rows[0] || null,
    materialCostPerUnit: parsePositive(material.rows[0]?.cost_per_unit),
    printerCostPerMinute: parsePositive(printer.rows[0]?.cost_per_minute),
    currency: material.rows[0]?.currency || 'EUR',
  };
};

const calculateConfiguredCost = ({
  materialUsage,
  printTimeMinutes,
  materialCostPerUnit,
  printerCostPerMinute,
  includeFixedCost = true,
}) => {
  const usage = parseFloat(normalizeDecimal(materialUsage));
  const minutes = parseFloat(normalizeDecimal(printTimeMinutes));
  const materialRate = parseFloat(normalizeDecimal(materialCostPerUnit));
  const printerRate = parseFloat(normalizeDecimal(printerCostPerMinute));
  if (![usage, minutes, materialRate, printerRate].every(Number.isFinite)) return null;
  const materialCost = roundMoney(usage * materialRate);
  const machineCost = roundMoney(minutes * printerRate);
  const fixedCost = includeFixedCost ? roundMoney(FIXED_COST) : 0;
  return {
    materialCost,
    machineCost,
    fixedCost,
    totalCost: roundMoney(materialCost + machineCost + fixedCost),
  };
};

module.exports = {
  calculateConfiguredCost,
  getConfiguredRates,
};
