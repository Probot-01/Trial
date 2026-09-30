#!/usr/bin/env node
'use strict';

/**
 * §I end to end, on a real image the fovea gate actually flags.
 *
 * Everything so far tested a piece: the gate in Python, the rule engine in
 * MATLAB, the JS fallback against MATLAB. This grades two real images through
 * the orchestrator and reads the database afterwards.
 *
 *   IDRiD_224 (Training Set) -- peak 0.1397, gate fires, gross miss of 1649 px
 *   IDRiD_102 (Training Set) -- peak 0.7304, gate does not fire (the control;
 *     note there is a DIFFERENT IDRiD_102 in the Testing Set whose peak is
 *     0.082 -- the ids are reused across folders)
 *
 * The control matters: a check that only ever sees flagged cases cannot tell
 * "the floor works" from "everything is held at B".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CENTRAL = path.join(__dirname, 'central-system', 'backend');
const DATASET = path.join(CENTRAL, 'ml-pipeline', 'datasets', 'idrid',
  'localization', 'C. Localization', '1. Original Images', 'a. Training Set');

const pool = require(path.join(CENTRAL, 'db', 'pgClient'));
const { processCase } = require(path.join(CENTRAL, 'services', 'gradingOrchestrator'));

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`        ${detail}`); }
}

async function makeCase(sourceImage) {
  const caseId = crypto.randomUUID();
  const dir = path.join(CENTRAL, 'media', 'cases', caseId);
  fs.mkdirSync(dir, { recursive: true });
  const imagePath = path.join(dir, 'original.jpg');
  fs.copyFileSync(sourceImage, imagePath);

  const patientId = `FOVEA-E2E-${caseId.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO patients (patient_id, name, age, contact_number, registered_at)
     VALUES ($1, $2, 55, '0000000000', now())`,
    [patientId, 'fovea gate e2e']);

  const phc = await pool.query('SELECT phc_id FROM phc_sites LIMIT 1');
  await pool.query(
    `INSERT INTO cases (case_id, patient_id, phc_id, image_path, status,
                        eye_laterality_reported, capture_metadata)
     VALUES ($1, $2, $3, $4, 'processing', 'right', '{}'::jsonb)`,
    [caseId, patientId, phc.rows[0].phc_id, imagePath]);

  return { caseId, patientId };
}

async function readBack(caseId) {
  const r = await pool.query(
    `SELECT g.dr_grade_cnn, g.dr_grade_rule_engine, g.conformal_tier,
            g.branch_agreement, g.confidence_score,
            s.fovea_unreliable, s.lesion_counts,
            e.evidence_summary_text
       FROM grading_results g
       LEFT JOIN segmentation_outputs s USING (case_id)
       LEFT JOIN explainability_outputs e USING (case_id)
      WHERE g.case_id = $1`, [caseId]);
  return r.rows[0];
}

async function cleanup(cases) {
  for (const { caseId, patientId } of cases) {
    await pool.query('DELETE FROM explainability_outputs WHERE case_id = $1', [caseId]);
    await pool.query('DELETE FROM segmentation_outputs WHERE case_id = $1', [caseId]);
    await pool.query('DELETE FROM grading_results WHERE case_id = $1', [caseId]);
    await pool.query('DELETE FROM cases WHERE case_id = $1', [caseId]);
    await pool.query('DELETE FROM patients WHERE patient_id = $1', [patientId]);
    fs.rmSync(path.join(CENTRAL, 'media', 'cases', caseId), { recursive: true, force: true });
  }
}

async function main() {
  const made = [];
  try {
    for (const [label, file, expectFlag] of [
      ['FLAGGED  IDRiD_224 (peak 0.1397)', 'IDRiD_224.jpg', true],
      ['CONTROL  IDRiD_102 (peak 0.7304)', 'IDRiD_102.jpg', false],
    ]) {
      console.log(`\n${label}`);
      const c = await makeCase(path.join(DATASET, file));
      made.push(c);

      const t = Date.now();
      await processCase(c.caseId);
      const secs = ((Date.now() - t) / 1000).toFixed(1);

      const row = await readBack(c.caseId);
      console.log(`  graded in ${secs}s: cnn=${row.dr_grade_cnn} rule=${row.dr_grade_rule_engine} `
        + `tier=${row.conformal_tier} agree=${row.branch_agreement} `
        + `conf=${Number(row.confidence_score).toFixed(3)} foveaUnreliable=${row.fovea_unreliable}`);

      // 1. the flag survives the whole trip and is a real boolean, not null
      check('fovea_unreliable stored as a real boolean (not null)',
        typeof row.fovea_unreliable === 'boolean', `got ${JSON.stringify(row.fovea_unreliable)}`);
      check(`fovea_unreliable === ${expectFlag}`,
        row.fovea_unreliable === expectFlag, `got ${row.fovea_unreliable}`);

      const text = row.evidence_summary_text || '';
      if (expectFlag) {
        // 2. the tier floor fired (a floor: B or worse, never below)
        check('tier held at B or worse', ['B', 'C'].includes(row.conformal_tier),
          `tier=${row.conformal_tier}`);
        // 3. the evidence says so, in the corrected wording
        check('evidence names the unreliable fovea',
          /fovea could not be located reliably/i.test(text), text.slice(0, 200));
        check('evidence does NOT claim the image-axes fallback',
          !/image axes/i.test(text), text.slice(0, 200));
        check('evidence says (a) and (b) were not applied',
          /were not applied/i.test(text), text.slice(0, 200));
        // 4. and criterion (a) genuinely did not fire
        check('rule grade was not set by the all-four-quadrants criterion',
          !/all four quadrants/i.test(text), text.slice(0, 200));
      } else {
        check('evidence says nothing about an unreliable fovea',
          !/fovea could not be located/i.test(text), text.slice(0, 200));
        check('tier is whatever the predictor said, not forced',
          ['A', 'B', 'C'].includes(row.conformal_tier), `tier=${row.conformal_tier}`);
      }
      console.log(`  evidence: ${text.slice(0, 300)}`);
    }
  } finally {
    await cleanup(made);
  }

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
