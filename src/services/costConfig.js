const numberFromEnv = (key, fallback) => {
  const value = parseFloat(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
};

const FIXED_COST = numberFromEnv('REQUEST_FIXED_COST', numberFromEnv('FIXED_COST', 9.86));

module.exports = {
  FIXED_COST,
};
