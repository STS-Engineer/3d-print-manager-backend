const db = require('./database');

const migrate = async () => {
  const client = await db.getClient();
  try {
    console.log('Starting migration v20: configurable production cost rates...');
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE materials
        ADD COLUMN IF NOT EXISTS cost_per_unit NUMERIC(12, 6),
        ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'EUR';
    `);

    await client.query(`
      ALTER TABLE printers
        ADD COLUMN IF NOT EXISTS cost_per_minute NUMERIC(12, 6);
    `);

    await client.query(`
      UPDATE materials
      SET
        cost_per_unit = COALESCE(cost_per_unit,
          CASE
            WHEN LOWER(COALESCE(type, '')) LIKE '%resin%' THEN 0.120
            WHEN LOWER(COALESCE(type, '')) LIKE '%petg%' THEN 0.032
            ELSE 0.025
          END
        ),
        currency = COALESCE(NULLIF(currency, ''), 'EUR')
      WHERE is_active = true OR cost_per_unit IS NULL OR currency IS NULL;
    `);

    await client.query(`
      UPDATE printers
      SET cost_per_minute = COALESCE(cost_per_minute,
        CASE
          WHEN name ILIKE '%03%' THEN 0.120
          WHEN name ILIKE '%02%' THEN 0.080
          WHEN name ILIKE '%04%' THEN 0.040
          ELSE 0.050
        END
      )
      WHERE is_active = true OR cost_per_minute IS NULL;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'materials_cost_per_unit_positive'
        ) THEN
          ALTER TABLE materials
            ADD CONSTRAINT materials_cost_per_unit_positive
            CHECK (cost_per_unit IS NULL OR cost_per_unit > 0);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'materials_currency_valid'
        ) THEN
          ALTER TABLE materials
            ADD CONSTRAINT materials_currency_valid
            CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'printers_cost_per_minute_positive'
        ) THEN
          ALTER TABLE printers
            ADD CONSTRAINT printers_cost_per_minute_positive
            CHECK (cost_per_minute IS NULL OR cost_per_minute > 0);
        END IF;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('Migration v20 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v20 failed:', err.message);
    throw err;
  } finally {
    client.release();
    await db.pool.end();
  }
};

migrate().catch(() => process.exit(1));
