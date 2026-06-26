const db = require('./database');

const migrate = async () => {
  const client = await db.getClient();
  try {
    console.log('Starting migration v24: remove estimation engine fields...');
    await client.query('BEGIN');

    await client.query(`
      UPDATE print_requests
      SET estimated_printing_time = NULL,
          estimated_cost = NULL,
          estimated_post_processing_time = NULL,
          estimated_total_lead_time = NULL
      WHERE estimated_printing_time IS NOT NULL
         OR estimated_cost IS NOT NULL
         OR estimated_post_processing_time IS NOT NULL
         OR estimated_total_lead_time IS NOT NULL;
    `).catch(() => {});

    await client.query(`
      ALTER TABLE request_stl_metadata
        DROP COLUMN IF EXISTS volume_mm3,
        DROP COLUMN IF EXISTS bounding_box_x_mm,
        DROP COLUMN IF EXISTS bounding_box_y_mm,
        DROP COLUMN IF EXISTS bounding_box_z_mm,
        DROP COLUMN IF EXISTS triangle_count,
        DROP COLUMN IF EXISTS estimated_weight_g,
        DROP COLUMN IF EXISTS estimated_material_usage_g,
        DROP COLUMN IF EXISTS material_density_g_cm3,
        DROP COLUMN IF EXISTS infill_factor,
        DROP COLUMN IF EXISTS estimated_print_time_minutes,
        DROP COLUMN IF EXISTS estimated_print_time_hours,
        DROP COLUMN IF EXISTS printer_profile_name,
        DROP COLUMN IF EXISTS printer_profile_speed_mm_s,
        DROP COLUMN IF EXISTS printer_profile_setup_factor,
        DROP COLUMN IF EXISTS printer_profile_efficiency_factor,
        DROP COLUMN IF EXISTS stl_material_cost,
        DROP COLUMN IF EXISTS stl_time_cost,
        DROP COLUMN IF EXISTS stl_fixed_cost,
        DROP COLUMN IF EXISTS stl_estimated_total_cost,
        DROP COLUMN IF EXISTS stl_variable_cost_per_g,
        DROP COLUMN IF EXISTS stl_machine_cost_per_minute;
    `).catch(() => {});

    await client.query('COMMIT');
    console.log('Migration v24 completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration v24 failed:', err.message);
    throw err;
  } finally {
    client.release();
    await db.pool.end();
  }
};

migrate().catch(() => process.exit(1));
