'use strict';



const crypto = require('crypto');
const fs = require('fs');

/** SHA-256 of the file, or null when it cannot be read. */
function hashFile(filePath) {
  if (!filePath) return null;
  try {

    return crypto.createHash('sha256').update(require('./mediaCrypto').readFile(filePath)).digest('hex');
  } catch {

    return null;
  }
}


async function recordLabel(client, { caseId, reviewId, decision, correctedGrade, reviewerId }) {
  const { rows } = await client.query(`
    SELECT c.image_path,
           c.eye_laterality_detected, c.eye_laterality_reported,
           g.dr_grade_cnn, g.conformal_tier,
           p.consent_given_at
      FROM cases c
      JOIN patients p ON p.patient_id = c.patient_id
      LEFT JOIN grading_results g ON g.case_id = c.case_id
     WHERE c.case_id = $1
  `, [caseId]);
  if (!rows.length) return null;
  const r = rows[0];

  const modelGrade = Number.isInteger(r.dr_grade_cnn) ? r.dr_grade_cnn : null;
  const labelGrade = decision === 'override'
    ? (Number.isInteger(correctedGrade) ? correctedGrade : null)
    : modelGrade;

  if (!Number.isInteger(labelGrade)) return null;

  const inserted = await client.query(`
    INSERT INTO dataset_labels
      (case_id, review_id, label_grade, label_source, model_grade, conformal_tier,
       image_path, image_sha256, eye_laterality, consent_given_at, reviewer_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (review_id) DO NOTHING
    RETURNING label_id, label_grade, label_source
  `, [
    caseId, reviewId, labelGrade,
    decision === 'override' ? 'override' : 'confirm',
    modelGrade, r.conformal_tier || null,
    r.image_path || null, hashFile(r.image_path),
    r.eye_laterality_detected || r.eye_laterality_reported || null,
    r.consent_given_at || null,
    reviewerId || null,
  ]);

  return inserted.rows[0] || null;
}

module.exports = { recordLabel, hashFile };
