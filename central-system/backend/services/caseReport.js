'use strict';


const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const pool = require('../db/pgClient');
const mediaPaths = require('./mediaPaths');
const mediaCrypto = require('./mediaCrypto');
const matlabSession = require('./matlabSessionClient');
const engineProvenance = require('./engineProvenance');

const ML_ROOT = path.resolve(__dirname, '..', 'ml-pipeline');
const MATLAB_EXE = process.env.MATLAB_EXECUTABLE || 'matlab';
const SESSION_TIMEOUT_MS = 60_000;
const BATCH_TIMEOUT_MS = 180_000;

const toMatlabStr = (s) => String(s).replace(/\\/g, '/').replace(/'/g, "''");
const inflight = new Map();   // caseId -> promise: concurrent requests share one render

/** One request through the persistent session (matlabSessionClient.js). */
function viaSession(inputPath, outPath) {
  return matlabSession.call({
    report: inputPath.replace(/\\/g, '/'), outPath: outPath.replace(/\\/g, '/'),
  }, { timeoutMs: SESSION_TIMEOUT_MS, prefix: 'report' });
}

/** Fallback: a one-off MATLAB process. */
function viaBatch(inputPath, outPath) {
  const expr = ['explainability', 'preprocessing', 'segmentation']
    .map((d) => `addpath('${toMatlabStr(path.join(ML_ROOT, d))}');`).join(' ')
    + ` generateReport('${toMatlabStr(inputPath)}', '${toMatlabStr(outPath)}');`;
  return new Promise((resolve, reject) => {
    execFile(MATLAB_EXE, ['-batch', expr], { timeout: BATCH_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => (err
        ? reject(new Error(`report generation failed: ${(stderr || err.message).slice(0, 500)}`))
        : resolve()));
  });
}

/** Everything the report shows, straight from the database. */
async function loadReportInput(caseId) {
  const { rows } = await pool.query(`
    SELECT c.case_id, c.image_path, c.captured_at, c.status,
           c.eye_laterality_detected, c.eye_laterality_reported,
           p.patient_reference, p.age,
           site.name AS phc_name,
           g.dr_grade_cnn, g.confidence_score, g.conformal_tier, g.tier_reason,
           g.dr_grade_rule_engine, g.branch_agreement, g.graded_at,
           g.model_version, g.engine_provenance, c.quality_gate_engine,
           s.lesion_counts, s.nv_suspicion_score,
           e.gradcam_path, e.evidence_summary_text, e.rationale_report_path
    FROM cases c
    JOIN patients p ON p.patient_id = c.patient_id
    LEFT JOIN phc_sites site ON site.phc_id = c.phc_id
    LEFT JOIN grading_results g ON g.case_id = c.case_id
    LEFT JOIN segmentation_outputs s ON s.case_id = c.case_id
    LEFT JOIN explainability_outputs e ON e.case_id = c.case_id
    WHERE c.case_id = $1
  `, [caseId]);
  return rows[0] || null;
}

/**
 * provenanceRows(row) -- engine provenance flattened for the PDF.
 *
 * Returns uniform { label, engine, fallback, detail } rows, in reading order,
 * and [] when nothing was recorded. Flattened HERE rather than in MATLAB for
 * two reasons: jsondecode turns a uniform array of objects into a struct array
 * the renderer can just loop over, where a nested object with optional nulls
 * becomes a shape it would have to interrogate field by field; and the
 * contract's shape then lives in one place (services/engineProvenance.js)
 * instead of being re-derived in a .m file.
 *
 * A NOT-RECORDED output is omitted rather than printed as a blank row: the
 * screen can afford to say "not recorded" next to a label, a one-page clinical
 * document should not spend lines on outputs nobody recorded. When NOTHING was
 * recorded the caller prints one honest line saying exactly that.
 */
const PROVENANCE_LABELS = [
  ['classifier', 'Image classifier (Branch A)'],
  ['ruleEngine', 'Rule engine (Branch B)'],
  ['qualityGate', 'Quality gate (at the PHC)'],
];
const SEGMENTATION_LABELS = [
  ['vessel', 'Segmentation - vessel'],
  ['localization', 'Segmentation - localization'],
  ['hardExudate', 'Segmentation - hard exudate'],
  ['redLesion', 'Segmentation - red lesion'],
];

function provenanceRows(row) {
  const p = engineProvenance.toContractShape(row.engine_provenance, row.quality_gate_engine);
  const out = [];
  const push = (label, e) => {
    if (!e) return;
    out.push({
      label,
      engine: e.engine,
      fallback: e.fallback === true,
      detail: e.detail || '',
    });
  };
  push(PROVENANCE_LABELS[0][1], p.classifier);
  push(PROVENANCE_LABELS[1][1], p.ruleEngine);
  for (const [key, label] of SEGMENTATION_LABELS) push(label, p.segmentation?.[key]);
  push(PROVENANCE_LABELS[2][1], p.qualityGate);
  return out;
}

// MATLAB reads the image and Grad-CAM by path and cannot decrypt, so it gets
// temp plaintext copies (mediaCrypto.withPlaintextCopy); the PDF it writes is
// encrypted as soon as it exists.
async function render(caseId, row) {
  const gradcam = row.gradcam_path && fs.existsSync(row.gradcam_path) ? row.gradcam_path : null;
  const out = await mediaCrypto.withPlaintextCopy(row.image_path || null, (imagePath) =>
    mediaCrypto.withPlaintextCopy(gradcam, (gradcamPath) =>
      renderPlain(caseId, { ...row, image_path: imagePath, gradcam_path: gradcamPath })));
  mediaCrypto.encryptFileInPlace(out);
  return out;
}

async function renderPlain(caseId, row) {
  const outPath = path.join(mediaPaths.caseDir(caseId), 'report.pdf');
  const input = {
    caseId,
    patientReference: row.patient_reference,
    patientAge: row.age,
    phcName: row.phc_name,
    capturedAt: row.captured_at ? row.captured_at.toISOString() : null,
    eyeLaterality: row.eye_laterality_detected || row.eye_laterality_reported || null,
    imagePath: row.image_path || null,
    gradcamPath: row.gradcam_path && fs.existsSync(row.gradcam_path) ? row.gradcam_path : null,
    drGradeCnn: row.dr_grade_cnn,
    confidenceScore: row.confidence_score,
    conformalTier: row.conformal_tier,
    drGradeRuleEngine: row.dr_grade_rule_engine,
    branchAgreement: row.branch_agreement,
    // The STORED shape, not the API's: generateReport.m reads red/bright and
    // their per-quadrant arrays to build the evidence table. The clinical key
    // names are an API-boundary concern (services/lesionCounts.js); the PDF is
    // rendered from the measurement itself.
    lesionCounts: row.lesion_counts,
    nvSuspicionScore: row.nv_suspicion_score,
    evidenceSummaryText: row.evidence_summary_text,
    // WHY this tier. generateReport.m has rendered a "Why: ..." line from this
    // since it was written, and nothing ever sent the field -- so the PDF said
    // "Tier B - assisted review recommended" and never which of the five
    // situations produced that B. The screen has shown it since migration 0015.
    tierReason: row.tier_reason || null,
    // WHICH MODEL AND WHICH ENGINE produced the grade. The report is the
    // artifact that leaves the system and goes into a patient record, so it
    // carries its own provenance rather than relying on whoever reads it
    // still having the case open in the reviewer console.
    modelVersion: row.model_version || null,
    provenanceRows: provenanceRows(row),
    generatedAt: new Date().toISOString(),
  };
  const inputPath = path.join(os.tmpdir(), `report_in_${caseId}_${Date.now()}.json`);
  fs.writeFileSync(inputPath, JSON.stringify(input));
  try {
    if (matlabSession.alive()) {
      try {
        await viaSession(inputPath, outPath);
      } catch (err) {
        console.warn(`[caseReport] session render failed (${err.message}); using matlab -batch`);
        await viaBatch(inputPath, outPath);
      }
    } else {
      await viaBatch(inputPath, outPath);
    }
  } finally {
    fs.unlink(inputPath, () => { });
  }
  if (!fs.existsSync(outPath)) throw new Error('report generation produced no file');

  await pool.query(`
    INSERT INTO explainability_outputs (case_id, rationale_report_path)
    VALUES ($1, $2)
    ON CONFLICT (case_id) DO UPDATE SET rationale_report_path = EXCLUDED.rationale_report_path
  `, [caseId, outPath]);
  return outPath;
}

/**
 * @returns {Promise<null | {error: string} | {reportUrl, generatedAt, cached}>}
 *   null when the case does not exist; {error:'case_not_graded'} before grading.
 */
async function getOrCreateReport(caseId, { force = false } = {}) {
  const row = await loadReportInput(caseId);
  if (!row) return null;
  if (row.status !== 'graded' || row.dr_grade_cnn == null) return { error: 'case_not_graded' };

  const existing = row.rationale_report_path;
  if (!force && existing && fs.existsSync(existing)) {
    const mtime = fs.statSync(existing).mtime;
    if (!row.graded_at || mtime >= row.graded_at) {
      return { reportUrl: mediaPaths.toPublicUrl(existing), generatedAt: mtime.toISOString(), cached: true };
    }
  }

  if (!inflight.has(caseId)) {
    inflight.set(caseId, render(caseId, row).finally(() => inflight.delete(caseId)));
  }
  const outPath = await inflight.get(caseId);
  return {
    reportUrl: mediaPaths.toPublicUrl(outPath),
    generatedAt: fs.statSync(outPath).mtime.toISOString(),
    cached: false,
  };
}

// __provenanceRowsForTest: verify_report_provenance.js checks the flattening
// against what the database holds. Exported rather than duplicated there --
// a test that reimplements the thing it tests agrees with itself, not with
// the code.
module.exports = { getOrCreateReport, __provenanceRowsForTest: provenanceRows };
