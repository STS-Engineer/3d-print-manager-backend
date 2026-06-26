const PRODUCTION_TECHNICIAN = 'production_technician';
const PRODUCTION_TECHNICIAN_ALIASES = [PRODUCTION_TECHNICIAN, 'coordinator', 'technician'];

const normalizeRole = (role) => (
  PRODUCTION_TECHNICIAN_ALIASES.includes(role) ? PRODUCTION_TECHNICIAN : role
);

const isProductionTechnician = (role) => normalizeRole(role) === PRODUCTION_TECHNICIAN;

const roleSqlList = (roles) => roles.map(role => `'${role}'`).join(',');

module.exports = {
  PRODUCTION_TECHNICIAN,
  PRODUCTION_TECHNICIAN_ALIASES,
  normalizeRole,
  isProductionTechnician,
  roleSqlList,
};
