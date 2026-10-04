'use strict';



const path = require('path');
const pool = require(path.resolve(__dirname, '..', 'central-system', 'backend', 'db', 'pgClient'));

function parseMetric(raw, name) {
  if (raw === undefined) throw new Error(`${name} is required`);
  if (String(raw).toLowerCase() === 'null') return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number or 'null', got '${raw}'`);
  if (v < 0 || v > 1) throw new Error(`${name} must be in [0,1] (kappa may be negative — pass 'null' if unmeasured), got ${v}`);
  return v;
}

async function main() {
  const [versionId, sensRaw, specRaw, kappaRaw] = process.argv.slice(2);
  const promote = process.argv.includes('--promote');

  if (!versionId) {
    console.error('usage: node scripts/recordModelVersion.js <versionId> <sens> <spec> <kappa> [--promote]');
    process.exit(2);
  }

  const sensitivity = parseMetric(sensRaw, 'sensitivity');
  const specificity = parseMetric(specRaw, 'specificity');

  const kappa = String(kappaRaw).toLowerCase() === 'null' ? null : Number(kappaRaw);
  if (kappa !== null && !Number.isFinite(kappa)) {
    throw new Error(`kappa must be a number or 'null', got '${kappaRaw}'`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (promote) {
      await client.query(
        'UPDATE model_versions SET promoted = false WHERE version_id <> $1', [versionId]);
    }

    await client.query(`
      INSERT INTO model_versions
        (version_id, trained_at, validation_sensitivity, validation_specificity,
         validation_kappa, promoted, promoted_at)
      VALUES ($1, now(), $2, $3, $4, $5, CASE WHEN $5 THEN now() ELSE NULL END)
      ON CONFLICT (version_id) DO UPDATE SET
        validation_sensitivity = EXCLUDED.validation_sensitivity,
        validation_specificity = EXCLUDED.validation_specificity,
        validation_kappa       = EXCLUDED.validation_kappa,
        promoted               = EXCLUDED.promoted,
        promoted_at            = COALESCE(model_versions.promoted_at, EXCLUDED.promoted_at),
        trained_at             = COALESCE(model_versions.trained_at, EXCLUDED.trained_at)
    `, [versionId, sensitivity, specificity, kappa, promote]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(`
    SELECT version_id, validation_sensitivity AS sens, validation_specificity AS spec,
           validation_kappa AS kappa, promoted
    FROM model_versions ORDER BY promoted DESC, version_id
  `);
  console.table(rows);
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
