'use strict';


const fs = require('fs');
const path = require('path');
const pool = require('../central-system/backend/db/pgClient');

const DEFAULT_IMAGE = path.resolve(__dirname, '..', 'datasets', '2.jpg');
const imagePath = path.resolve(process.argv[2] || DEFAULT_IMAGE);

const CASE_ID_FILE = path.resolve(__dirname, '..', 'test_case_id.txt');

async function main() {
  if (!fs.existsSync(imagePath)) {
    console.error(`[seedTestCase] Image not found: ${imagePath}`);
    process.exitCode = 1;
    return;
  }

  try {
    // ── Model version for the current Branch A model ────────────────────────
    await pool.query(`
      INSERT INTO model_versions (version_id, trained_at, promoted)
      VALUES ('branchA_v1', NULL, false)
      ON CONFLICT (version_id) DO NOTHING
    `);

    // ── PHC site ────────────────────────────────────────────────────────────
    const phc = await pool.query(`
      WITH existing AS (SELECT phc_id FROM phc_sites WHERE name = 'PHC Kharadi'),
           created  AS (
             INSERT INTO phc_sites (name)
             SELECT 'PHC Kharadi' WHERE NOT EXISTS (SELECT 1 FROM existing)
             RETURNING phc_id
           )
      SELECT phc_id FROM existing UNION ALL SELECT phc_id FROM created
    `);
    const phcId = phc.rows[0].phc_id;

    // ── Patient (PHC-generated TEXT id, per api-contracts.md's ID rule) ─────
    const patientId = 'PHC001-lz3k9f-a2x9';
    await pool.query(`
      INSERT INTO patients
        (patient_id, name, age, contact_number, registered_at, patient_reference)
      VALUES ($1, 'Test Patient', 54, '+919812345678', now(), 'PT-4821')
      ON CONFLICT (patient_id) DO NOTHING
    `, [patientId]);

    const captureRef = `PHC001-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
    const c = await pool.query(`
      INSERT INTO cases
        (patient_id, phc_id, capture_id_ref, camera_device_id, image_path,
         questionnaire_data, capture_metadata, status)
      VALUES ($1, $2, $6, 'unknown', $3, $4, $5, 'processing')
      RETURNING case_id, received_at
    `, [
      patientId,
      phcId,
      imagePath.replace(/\\/g, '/'),

      {
        riskFactors: {
          yearsSinceDiagnosis: 'lt1', glycemicControl: 'moderate',
          bloodPressure: 'high', pregnant: false
        },
        symptoms: {
          blurredVision: true, floaters: false,
          suddenVisionChange: false, eyePain: false
        },
        language: 'hi'
      },
      {
        cameraDeviceReported: 'forus_3nethra_v2', pupilStatus: 'dilated',
        lightingEnvironment: 'indoor_clinic', observedIssues: ['none_noticed'],
        workerUsabilityRating: 'clear'
      },
      captureRef,
    ]);

    const { case_id: caseId, received_at: receivedAt } = c.rows[0];

    fs.writeFileSync(CASE_ID_FILE, caseId, 'utf8');

    console.log('[seedTestCase] Seeded successfully.');
    console.log(`    phcId      : ${phcId}`);
    console.log(`    patientId  : ${patientId}`);
    console.log(`    caseId     : ${caseId}`);
    console.log(`    receivedAt : ${receivedAt.toISOString()}`);
    console.log(`    imagePath  : ${imagePath}`);
    console.log(`[seedTestCase] caseId written to ${path.basename(CASE_ID_FILE)}`);
  } catch (err) {
    console.error('[seedTestCase] FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
