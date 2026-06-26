const db = require('./database');

const migrate = async () => {
  const client = await db.getClient();
  try {
    console.log('Starting migration v22: STL catalog density and printer profiles...');
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE materials
        ADD COLUMN IF NOT EXISTS density_g_cm3 NUMERIC(10, 4);
    `);

    await client.query(`
      ALTER TABLE printers
        ADD COLUMN IF NOT EXISTS print_speed NUMERIC(10, 4),
        ADD COLUMN IF NOT EXISTS setup_factor NUMERIC(10, 4),
        ADD COLUMN IF NOT EXISTS efficiency_factor NUMERIC(10, 4);
    `);

    await client.query(`
      UPDATE materials
      SET density_g_cm3 = COALESCE(density_g_cm3,
        CASE
          WHEN LOWER(COALESCE(type, name, '')) LIKE '%petg%' THEN 1.27
          WHEN LOWER(COALESCE(type, name, '')) LIKE '%abs%' THEN 1.04
          WHEN LOWER(COALESCE(type, name, '')) LIKE '%asa%' THEN 1.07
          WHEN LOWER(COALESCE(type, name, '')) LIKE '%tpu%' THEN 1.21
          WHEN LOWER(COALESCE(type, name, '')) LIKE '%resin%' THEN 1.15
          WHEN LOWER(COALESCE(type, name, '')) LIKE '%nylon%' THEN 1.14
          WHEN LOWER(COALESCE(type, name, '')) LIKE '%pla%' THEN 1.24
          ELSE NULL
        END
      );
    `);

    await client.query(`
      UPDATE printers
      SET print_speed = COALESCE(print_speed, 60),
          setup_factor = COALESCE(setup_factor, 1.15),
          efficiency_factor = COALESCE(efficiency_factor, 0.85)
      WHERE is_active = true;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'materials_density_positive'
        ) THEN
          ALTER TABLE materials
            ADD CONSTRAINT materials_density_positive
            CHECK (density_g_cm3 IS NULL OR density_g_cm3 > 0);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'printers_print_speed_positive'
        ) THEN
          ALTER TABLE printers
            ADD CONSTRAINT printers_print_speed_positive
            CHECK (print_speed IS NULL OR print_speed > 0);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'printers_setup_factor_positive'
        ) THEN
          ALTER TABLE printers
            ADD CONSTRAINT printers_setup_factor_positive
            CHECK (setup_factor IS NULL OR setup_factor > 0);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'printers_efficiency_factor_positive'
        ) THEN
          ALTER TABLE printers
            ADD CONSTRAINT printers_efficiency_factor_positive
            CHECK (efficiency_factor IS NULL OR efficiency_factor > 0);
        END IF;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('Migration v22 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v22 failed:', err.message);
    throw err;
  } finally {
    client.release();
    await db.pool.end();
  }
};

migrate().catch(() => process.exit(1));
