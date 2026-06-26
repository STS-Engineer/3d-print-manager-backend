require('dotenv').config();
const { execSync } = require('child_process');
const path = require('path');

const configDir = path.join(__dirname, 'src', 'config');

const migrations = [
  { version: 'V1',  file: 'migrate.js',                                    dir: configDir },
  { version: 'V2',  file: 'migrate_v2.js',                                 dir: configDir },
  { version: 'V3',  file: 'migrate_v3.js',                                 dir: configDir },
  { version: 'V4',  file: 'migrate_v4.js',                                 dir: configDir },
  { version: 'V5',  file: 'migrate_v5.js',                                 dir: configDir },
  { version: 'V6',  file: 'migrate_v6.js',                                 dir: configDir },
  { version: 'V7',  file: 'migrate_v7.js',                                 dir: configDir },
  { version: 'V8',  file: 'migrate_v8.js',                                 dir: configDir },
  { version: 'V9',  file: 'migrate_v9.js',                                 dir: configDir },
  { version: 'V10', file: 'migrate_v10.js',                                dir: configDir },
  { version: 'V11', file: 'migrate_v11.js',                                dir: configDir },
  { version: 'V12', file: 'migrate_v12.js',                                dir: configDir },
  { version: 'V13', file: 'migrate_v13.js',                                dir: configDir },
  { version: 'V14', file: 'migrate_v14.js',                                dir: configDir },
  { version: 'V15', file: 'migrate_v15.js',                                dir: configDir },
  { version: 'V16', file: 'migrate_v16.js',                                dir: configDir },
  { version: 'V17', file: 'migrate_v17.js',                                dir: configDir },
  { version: 'V18', file: 'migrate_v18.js',                                dir: configDir },
  { version: 'V19', file: 'migrate_v19.js',                                dir: configDir },
  { version: 'V20', file: 'migrate_v20.js',                                dir: configDir },
  // V21 skipped: data-only migration (recalculates costs on existing data — not needed on empty DB)
  // { version: 'V21', file: 'migrate_v21_quantity_totals.js',             dir: configDir },
  { version: 'V22', file: 'migrate_v22_stl_catalog_profiles.js',          dir: configDir },
  { version: 'V23', file: 'migrate_v23_production_technician_role.js',    dir: configDir },
  { version: 'V24', file: 'migrate_v24_remove_estimation_engine.js',      dir: configDir },
  { version: 'V25', file: 'migrate_v25_manual_planning_fields.js',        dir: configDir },
  { version: 'V26', file: 'migrate_v26_quality_quantity_validation.js',   dir: configDir },
  { version: 'V27', file: 'migrate_v27_production_cycle_costs.js',        dir: configDir },
  { version: 'SEED', file: 'seed.js',                                     dir: configDir },
];

const runAll = () => {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   3D Print Manager — Migration V1 → V27 + Seed   ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  let success = 0;
  let failed = 0;

  for (const migration of migrations) {
    const filePath = path.join(migration.dir, migration.file);
    console.log(`▶ Running migration ${migration.version} (${migration.file})...`);

    try {
      execSync(`node "${filePath}"`, { stdio: 'inherit' });
      console.log(`✅ ${migration.version} — OK\n`);
      success++;
    } catch (err) {
      console.error(`❌ ${migration.version} — FAILED\n`);
      failed++;
      console.error('Migration stopped. Fix the error above and re-run migrate-all.js');
      console.error('Tip: migrations already completed are safe (IF NOT EXISTS guards them).');
      process.exit(1);
    }
  }

  console.log('══════════════════════════════════════════════════');
  console.log(`✅ All migrations completed: ${success}/${migrations.length}`);
  console.log('══════════════════════════════════════════════════');
  process.exit(0);
};

runAll();