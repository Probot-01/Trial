#!/usr/bin/env node
'use strict';

/**
 * seed-real-demo-cases.js -- give the district-worker dashboards something
 * real to show, without inventing any data.
 *
 * seed-demo.js deliberately creates zero cases ("a case has to arrive the
 * real way -- capture on a PHC, quality gate, sync, grading -- or the system
 * is being demonstrated on data it never produced"). This script honours that:
 * it submits real IDRiD fundus images to central's real device-ingestion
 * endpoint (POST /api/v1/cases, the same route a PHC's sync manager calls),
 * with a real PHC API key, so every case that results went through the actual
 * MATLAB/segmentation grading pipeline -- it is just more VOLUME, across both
 * seeded PHCs, not synthetic rows written into Postgres.
 *
 * Usage:
 *   node scripts/seed-real-demo-cases.js
 *
 * Requires PHC001_API_KEY / PHC002_API_KEY (and their phcIds) -- seed-demo.js
 * only prints these once, so pass the current ones as env vars, or edit the
 * defaults below right after re-running `node scripts/seed-demo.js --force`.
 *
 * Cases are submitted one at a time (the grading queue's own concurrency is
 * 2; this deliberately does not race it) and this script waits for each to
 * finish grading before moving on, so it can report a real grade per case.
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.CENTRAL_BASE || 'http://localhost:5200';
const GRADING_DIR = path.join(__dirname, '..', 'central-system', 'backend',
  'ml-pipeline', 'datasets', 'idrid', 'grading', 'B. Disease Grading', '1. Original Images');
// This repo's copy splits "Training Set"/"Testing Set" by image-number range
// (163-413 vs 001-103ish), not by the Groundtruths CSVs' own train/test split
// -- several images the training-labels CSV names actually sit in the
// "Testing Set" folder here. Each entry below records which folder its file
// is actually in, checked directly against the filesystem.

const PHCS = [
  {
    name: 'PHC Kharadi',
    phcId: process.env.PHC001_ID || '64c709e1-4e39-4166-9935-7db2590b3a92',
    key: process.env.PHC001_API_KEY,
  },
  {
    name: 'PHC Wagholi',
    phcId: process.env.PHC002_ID,
    key: process.env.PHC002_API_KEY,
  },
];

// Three real images per DR grade (docs/../grading/2. Groundtruths CSVs,
// cross-checked against which folder each file actually exists in), so the
// queue and dashboards show a realistic severity spread rather than one
// repeated image.
const IMAGES_BY_GRADE = {
  0: [['IDRiD_163', 'train'], ['IDRiD_164', 'train'], ['IDRiD_165', 'train']],
  1: [['IDRiD_021', 'test'], ['IDRiD_079', 'test'], ['IDRiD_194', 'train']],
  2: [['IDRiD_003', 'test'], ['IDRiD_016', 'test'], ['IDRiD_018', 'test']],
  3: [['IDRiD_001', 'test'], ['IDRiD_002', 'test'], ['IDRiD_004', 'test']],
  4: [['IDRiD_005', 'test'], ['IDRiD_006', 'test'], ['IDRiD_007', 'test']],
};
const FOLDER_NAME = { train: 'a. Training Set', test: 'b. Testing Set' };

// Varied, plausible risk factors so urgency scores and referral reasons are
// not all identical -- still fictional demo patients (no real patient data),
// same as every other capture this project has used for testing.
const RISK_PROFILES = [
  { age: 45, yearsSinceDiagnosis: 'lt1', hba1c: null, glycemicControl: 'good', bloodPressure: 'normal' },
  { age: 58, yearsSinceDiagnosis: '1to5', hba1c: 7.2, glycemicControl: 'moderate', bloodPressure: 'elevated' },
  { age: 67, yearsSinceDiagnosis: '5to10', hba1c: 9.1, glycemicControl: 'poor', bloodPressure: 'high' },
  { age: 72, yearsSinceDiagnosis: 'gt10', hba1c: null, glycemicControl: 'poor', bloodPressure: 'high' },
];

function randomPhone() {
  return `9${Math.floor(100000000 + Math.random() * 899999999)}`;
}

async function ingest(phc, imageName, loc, riskProfile, eyeLaterality) {
  const imagePath = path.join(GRADING_DIR, FOLDER_NAME[loc], `${imageName}.jpg`);
  const fd = new FormData();
  const captureIdRef = `seed-${phc.phcId.slice(0, 8)}-${imageName}-${Date.now()}`;
  fd.set('patientId', `SEED-${phc.phcId.slice(0, 8)}-${Date.now()}-${Math.floor(Math.random() * 9999)}`);
  fd.set('patientName', 'Demo Patient');
  fd.set('patientAge', String(riskProfile.age));
  fd.set('patientContactNumber', randomPhone());
  fd.set('phcId', phc.phcId);
  fd.set('captureIdRef', captureIdRef);
  fd.set('consentGivenAt', new Date().toISOString());
  fd.set('captureMetadata', JSON.stringify({
    eyeLaterality,
    pupilStatus: 'dilated',
    cameraDeviceReported: 'forus_3nethra_v2',
  }));
  fd.set('questionnaireData', JSON.stringify({
    riskFactors: {
      yearsSinceDiagnosis: riskProfile.yearsSinceDiagnosis,
      hba1c: riskProfile.hba1c,
      bloodPressure: riskProfile.bloodPressure,
      glycemicControl: riskProfile.glycemicControl,
    },
    symptoms: {},
  }));
  fd.set('image', new Blob([fs.readFileSync(imagePath)], { type: 'image/jpeg' }), `${imageName}.jpg`);

  const res = await fetch(`${BASE}/api/v1/cases`, {
    method: 'POST',
    headers: { 'x-phc-api-key': phc.key },
    body: fd,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* leave null */ }
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`ingest failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return data;
}

async function waitForGrade(caseId, phc, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/api/v1/cases/${caseId}/status`, {
      headers: { 'x-phc-api-key': phc.key },
    });
    const body = await r.json().catch(() => ({}));
    if (body.status && body.status !== 'processing') return body.status;
    await new Promise((res) => setTimeout(res, 3000));
  }
  return 'timeout';
}

async function main() {
  for (const phc of PHCS) {
    if (!phc.key || !phc.phcId) {
      console.log(`Skipping ${phc.name}: no API key/phcId given (set env vars). See the header comment.`);
      continue;
    }
  }
  const active = PHCS.filter((p) => p.key && p.phcId);
  if (active.length === 0) {
    console.error('No PHC has both an id and a key. Nothing to do.');
    process.exit(1);
  }

  let ok = 0;
  let failed = 0;
  let phcIdx = 0;
  const eyeChoices = ['left', 'right'];

  for (const [grade, images] of Object.entries(IMAGES_BY_GRADE)) {
    for (const [imageName, loc] of images) {
      const phc = active[phcIdx % active.length];
      phcIdx += 1;
      const riskProfile = RISK_PROFILES[Math.floor(Math.random() * RISK_PROFILES.length)];
      const eye = eyeChoices[Math.floor(Math.random() * eyeChoices.length)];
      process.stdout.write(`[${phc.name}] ${imageName} (expected grade ${grade}) ... `);
      try {
        const ingested = await ingest(phc, imageName, loc, riskProfile, eye);
        const status = await waitForGrade(ingested.caseId, phc);
        console.log(`caseId=${ingested.caseId} status=${status}`);
        if (status === 'graded') ok += 1; else failed += 1;
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        failed += 1;
      }
    }
  }

  console.log(`\n${ok} graded, ${failed} failed/timed out.`);
  process.exit(failed > 0 && ok === 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
