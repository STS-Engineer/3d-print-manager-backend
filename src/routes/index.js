const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { PRODUCTION_TECHNICIAN } = require('../utils/roles');

const authCtrl        = require('../controllers/authController');
const requestCtrl     = require('../controllers/requestController');
const dashboardCtrl   = require('../controllers/dashboardController');
const masterCtrl      = require('../controllers/masterDataController');
const uploadCtrl      = require('../controllers/uploadController');
const feasCtrl        = require('../controllers/feasibilityController');
const qualityCtrl     = require('../controllers/qualityController');
const auditCtrl       = require('../controllers/auditController');
const planningCtrl    = require('../controllers/planningController');
const exportCtrl      = require('../controllers/exportController');
const archiveCtrl     = require('../controllers/archiveController');
const pdfCtrl         = require('../controllers/pdfController');
const costDashboardCtrl = require('../controllers/costDashboardController');
const maintenanceCtrl = require('../controllers/maintenanceController');
const stockCtrl       = require('../controllers/materialStockController');
const executiveCtrl   = require('../controllers/executiveController');

const PROD_ADMIN      = [PRODUCTION_TECHNICIAN,'administrator'];
const PROD_MGR_ADMIN  = [PRODUCTION_TECHNICIAN,'manager','administrator'];
const MGR_ADMIN       = ['manager','administrator'];
const ALL_STAFF       = [PRODUCTION_TECHNICIAN,'manager','administrator'];

// AUTH
router.post('/auth/login',           authCtrl.login);
router.get ('/auth/profile',         authenticate, authCtrl.getProfile);
router.put ('/auth/password',        authenticate, authCtrl.changePassword);

// REQUESTS
router.get   ('/requests',               authenticate, requestCtrl.getRequests);
router.post  ('/requests',               authenticate, requestCtrl.createRequest);
router.get   ('/requests/:id/pdf',       authenticate, authorize('requester',PRODUCTION_TECHNICIAN,'administrator'), pdfCtrl.downloadRequestPdf);
router.get   ('/requests/:id',           authenticate, requestCtrl.getRequest);
router.put   ('/requests/:id',           authenticate, requestCtrl.updateRequest);
router.patch ('/requests/:id/status',    authenticate, requestCtrl.updateStatus);
router.delete('/requests/:id',           authenticate, requestCtrl.deleteRequest);
router.post  ('/requests/:id/comments',  authenticate, requestCtrl.addComment);
router.post  ('/requests/:id/satisfaction', authenticate, authorize('requester'), requestCtrl.submitSatisfactionSurvey);

// File uploads
router.post  ('/requests/:id/files',                    authenticate, uploadCtrl.uploadMiddleware, uploadCtrl.uploadFiles);
router.delete('/requests/:id/files/:fileId',            authenticate, uploadCtrl.deleteFile);
router.get   ('/requests/:id/files/:fileId/download',   authenticate, uploadCtrl.downloadFile);

// FEASIBILITY
router.get ('/requests/:id/feasibility',  authenticate, authorize(...ALL_STAFF),   feasCtrl.getFeasibility);
router.post('/requests/:id/feasibility',  authenticate, authorize(...PROD_ADMIN), feasCtrl.saveFeasibility);

// QUALITY CHECKS
router.get ('/requests/:id/quality-checks',  authenticate, authorize(...ALL_STAFF),                              qualityCtrl.getQualityChecks);
router.post('/requests/:id/quality-checks',  authenticate, authorize(PRODUCTION_TECHNICIAN,'administrator'), qualityCtrl.createQualityCheck);

// PLANNING BOARD
router.get ('/planning/board',            authenticate, authorize(...ALL_STAFF),   planningCtrl.getPlanningBoard);
router.get ('/planning/conflicts',        authenticate, authorize(...ALL_STAFF),   planningCtrl.getPlanningConflicts);
router.post('/planning/slot-order',       authenticate, authorize(...PROD_ADMIN), planningCtrl.updateSlotOrder);
router.put ('/planning/dates/:id',        authenticate, authorize(...PROD_ADMIN), planningCtrl.updatePlanningDates);
router.get ('/planning/printer-schedule', authenticate, authorize(...ALL_STAFF),   planningCtrl.getPrinterSchedule);
router.get ('/planning/technician-schedule', authenticate, authorize(...ALL_STAFF), planningCtrl.getTechnicianSchedule);

// DASHBOARDS
router.get('/dashboard/operational', authenticate, authorize(...ALL_STAFF),       dashboardCtrl.getOperationalDashboard);
router.get('/dashboard/performance', authenticate, authorize(...PROD_MGR_ADMIN), dashboardCtrl.getPerformanceDashboard);
router.get('/dashboard/management',  authenticate, authorize(...MGR_ADMIN),       dashboardCtrl.getManagementDashboard);
router.get('/dashboard/resources',   authenticate, authorize(...PROD_MGR_ADMIN), dashboardCtrl.getResourceDashboard);
router.get('/dashboard/executive',   authenticate, authorize(...PROD_MGR_ADMIN), executiveCtrl.getExecutiveDashboard);
router.get('/dashboard/costs/summary',       authenticate, authorize(...PROD_MGR_ADMIN), costDashboardCtrl.getCostSummary);
router.get('/dashboard/costs/by-site',       authenticate, authorize(...PROD_MGR_ADMIN), costDashboardCtrl.getCostBySite);
router.get('/dashboard/costs/by-material',   authenticate, authorize(...PROD_MGR_ADMIN), costDashboardCtrl.getCostByMaterial);
router.get('/dashboard/costs/by-printer',    authenticate, authorize(...PROD_MGR_ADMIN), costDashboardCtrl.getCostByPrinter);
router.get('/dashboard/costs/by-technician', authenticate, authorize(...PROD_MGR_ADMIN), costDashboardCtrl.getCostByTechnician);
router.get('/dashboard/costs/monthly-trend', authenticate, authorize(...PROD_MGR_ADMIN), costDashboardCtrl.getMonthlyCostTrend);
router.get('/dashboard/costs/rework',        authenticate, authorize(...PROD_MGR_ADMIN), costDashboardCtrl.getReworkCostSummary);
router.get('/dashboard/costs/breakdown',     authenticate, authorize(...PROD_MGR_ADMIN), costDashboardCtrl.getCostComponentBreakdown);
router.get('/dashboard/costs/top-drivers',   authenticate, authorize(...PROD_MGR_ADMIN), costDashboardCtrl.getTopCostDrivers);

// NOTIFICATIONS
router.get('/notifications',             authenticate, dashboardCtrl.getNotifications);
router.put('/notifications/read',        authenticate, dashboardCtrl.markNotificationsRead);
router.get('/notifications/history',     authenticate, authorize(...PROD_MGR_ADMIN), dashboardCtrl.getNotificationHistory);
router.post('/notifications/test-email', authenticate, authorize(...PROD_MGR_ADMIN), dashboardCtrl.sendTestEmail);

// EXPORTS (CSV)
router.get('/export/requests/all',        authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportAllRequests);
router.get('/export/requests/open',       authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportOpenRequests);
router.get('/export/requests/completed',  authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportCompletedRequests);
router.get('/export/requests/overdue',    authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportOverdueRequests);
router.get('/export/requests/archived',   authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportArchivedRequests);
router.get('/export/workload/technician', authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportTechnicianWorkload);
router.get('/export/workload/printer',    authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportPrinterWorkload);
router.get('/export/workflow/snapshot',   authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportWorkflowSnapshot);
router.get('/export/workflow/history',    authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportWorkflowHistory);
router.get('/export/kpis',                authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportKPIs);
router.get('/export/materials',           authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportMaterialConsumption);
router.get('/export/inventory/transactions', authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportInventoryTransactions);
router.get('/export/inventory/low-stock',    authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportLowStockReport);
router.get('/export/inventory/forecast',     authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportMaterialForecast);
router.get('/export/executive/report',       authenticate, authorize(...PROD_MGR_ADMIN), executiveCtrl.exportExecutiveReport);
router.get('/export/executive/kpis',         authenticate, authorize(...PROD_MGR_ADMIN), executiveCtrl.exportExecutiveKpis);
router.get('/export/executive/forecast',     authenticate, authorize(...PROD_MGR_ADMIN), executiveCtrl.exportForecast);
router.get('/export/cost-kpis',           authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportCostKPIs);
router.get('/export/technician-workload-report', authenticate, authorize(...PROD_MGR_ADMIN), exportCtrl.exportTechnicianWorkloadReport);

// ARCHIVE
router.get ('/archive',       authenticate, authorize(...PROD_MGR_ADMIN), archiveCtrl.getArchive);
router.get ('/archive/stats', authenticate, authorize(...PROD_MGR_ADMIN), archiveCtrl.getArchiveStats);
router.post('/archive/bulk',  authenticate, authorize(...PROD_ADMIN),     archiveCtrl.bulkArchive);
router.post('/archive/:id',   authenticate, authorize(...PROD_ADMIN),     archiveCtrl.archiveRequest);

// MAINTENANCE
router.get ('/maintenance/printers', authenticate, authorize(...ALL_STAFF), maintenanceCtrl.getMaintenanceOverview);
router.get ('/maintenance/history',  authenticate, authorize(...ALL_STAFF), maintenanceCtrl.getMaintenanceHistory);
router.post('/maintenance/events',   authenticate, authorize(...PROD_ADMIN), maintenanceCtrl.createMaintenanceEvent);
router.put ('/maintenance/events/:id/reschedule', authenticate, authorize(...PROD_ADMIN), maintenanceCtrl.rescheduleMaintenance);
router.get ('/maintenance/summary',  authenticate, authorize(...PROD_MGR_ADMIN), maintenanceCtrl.getMaintenanceSummary);

// AUDIT LOGS
router.get('/audit-logs',             authenticate, authorize(...MGR_ADMIN), auditCtrl.getAuditLogs);
router.get('/audit-logs/request/:id', authenticate, authorize(...ALL_STAFF), auditCtrl.getRequestAuditLogs);
router.get('/audit-logs/request/:id/export', authenticate, authorize('administrator'), auditCtrl.exportRequestAuditLogs);

// MASTER DATA
router.get   ('/users',         authenticate, authorize(...PROD_MGR_ADMIN), masterCtrl.getUsers);
router.post  ('/users',         authenticate, authorize('administrator'),    masterCtrl.createUser);
router.put   ('/users/:id',     authenticate, authorize('administrator'),    masterCtrl.updateUser);
router.delete('/users/:id',     authenticate, authorize('administrator'),    masterCtrl.deleteUser);

router.get   ('/printers',      authenticate,                               masterCtrl.getPrinters);
router.post  ('/printers',      authenticate, authorize(...PROD_ADMIN),    masterCtrl.createPrinter);
router.put   ('/printers/:id',  authenticate, authorize(...PROD_ADMIN),    masterCtrl.updatePrinter);
router.delete('/printers/:id',  authenticate, authorize('administrator'),   masterCtrl.deletePrinter);

router.get ('/inventory/transactions',       authenticate, authorize(...ALL_STAFF), stockCtrl.getInventoryTransactions);
router.get ('/inventory/analytics',          authenticate, authorize(...ALL_STAFF), stockCtrl.getInventoryAnalytics);
router.get ('/materials/stock-overview',     authenticate, stockCtrl.getStockOverview);
router.post('/materials/recalculate-stock',  authenticate, authorize('administrator',PRODUCTION_TECHNICIAN), stockCtrl.recalculateStock);

router.get   ('/materials',     authenticate,                               masterCtrl.getMaterials);
router.post  ('/materials',     authenticate, authorize(...PROD_ADMIN),    masterCtrl.createMaterial);
router.put   ('/materials/:id', authenticate, authorize(...PROD_ADMIN),    masterCtrl.updateMaterial);
router.delete('/materials/:id', authenticate, authorize('administrator'),   masterCtrl.deleteMaterial);

router.get ('/categories',    authenticate,                               masterCtrl.getCategories);
router.post('/categories',    authenticate, authorize('administrator'),   masterCtrl.createCategory);
router.put ('/categories/:id', authenticate, authorize('administrator'),   masterCtrl.updateCategory);
router.delete('/categories/:id', authenticate, authorize('administrator'), masterCtrl.deleteCategory);

router.get   ('/sites',        authenticate,                               masterCtrl.getSites);
router.post  ('/sites',        authenticate, authorize('administrator'),   masterCtrl.createSite);
router.put   ('/sites/:id',    authenticate, authorize('administrator'),   masterCtrl.updateSite);
router.delete('/sites/:id',    authenticate, authorize('administrator'),   masterCtrl.deleteSite);

router.get('/workflow-statuses', authenticate, masterCtrl.getWorkflowStatuses);
router.get('/blocking-reasons',  authenticate, masterCtrl.getBlockingReasons);

// ── Material stock routes ─────────────────────────────────────────────────────


router.get ('/materials/:id/stock',              authenticate, stockCtrl.getMaterialStock);
router.get ('/materials/:id/transactions',       authenticate, stockCtrl.getMaterialTransactions);
router.post('/materials/:id/adjust-stock',       authenticate, authorize('administrator',PRODUCTION_TECHNICIAN), stockCtrl.adjustStock);

router.get('/blocking-reasons',  authenticate, masterCtrl.getBlockingReasons);

// ── Import routes ────────────────────────────────────────────────────────────
const multer = require('multer');
const os     = require('os');
const csvUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });
const importCtrl = require('../controllers/importController');
router.post('/import/monday-csv',  authenticate, authorize('administrator',PRODUCTION_TECHNICIAN), csvUpload.single('csv'), importCtrl.importMondayCSV);
router.get ('/import/template',    authenticate, authorize('administrator',PRODUCTION_TECHNICIAN), importCtrl.downloadTemplate);
router.get ('/import/monday-history', authenticate, authorize('administrator',PRODUCTION_TECHNICIAN), importCtrl.getMondayImportHistory);

module.exports = router;
