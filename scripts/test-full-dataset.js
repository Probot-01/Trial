#!/usr/bin/env node
'use strict';


const fs = require('fs');
const path = require('path');

const BASE = process.env.CENTRAL_BASE || 'http://localhost:5200';
const PHC_ID = process.env.PHC001_ID || '64c709e1-4e39-4166-9935-7db2590b3a92';
const PHC_KEY = process.env.PHC001_API_KEY;
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const GRADING_DIR = path.join(__dirname, '..', 'central-system', 'backend',
  'ml-pipeline', 'datasets', 'idrid', 'grading', 'B. Disease Grading', '1. Original Images');
const FOLDER_NAME = { train: 'a. Training Set', test: 'b. Testing Set' };
const MANIFEST_PATH = path.join(__dirname, '..', 'full_dataset_manifest.json');
const RESULTS_PATH = path.join(__dirname, '..', 'full_dataset_results.jsonl');

function loadDone() {
  const done = new Set();
  if (!fs.existsSync(RESULTS_PATH)) return done;
  for (const line of fs.readFileSync(RESULTS_PATH, 'utf8').split('\n').filter(Boolean)) {
    try { done.add(JSON.parse(line).name); } catch { /* ignore a partial last line */ }
  }
  return done;
}

function appendResult(obj) {
  fs.appendFileSync(RESULTS_PATH, JSON.stringify(obj) + '\n');
}

async function ingest(imageName, loc) {
  const imagePath = path.join(GRADING_DIR, FOLDER_NAME[loc], `${imageName}.jpg`);
  const fd = new FormData();
  fd.set('patientId', `DATASET-${imageName}-${Date.now()}`);
  fd.set('patientName', 'Dataset Test');
  fd.set('patientAge', '55');
  fd.set('patientContactNumber', `9${Math.floor(100000000 + Math.random() * 899999999)}`);
  fd.set('phcId', PHC_ID);
  fd.set('captureIdRef', `dataset-${imageName}-${Date.now()}`);
  fd.set('consentGivenAt', new Date().toISOString());
  fd.set('captureMetadata', JSON.stringify({ eyeLaterality: 'right', pupilStatus: 'dilated' }));
  fd.set('image', new Blob([fs.readFileSync(imagePath)], { type: 'image/jpeg' }), `${imageName}.jpg`);

  const res = await fetch(`${BASE}/api/v1/cases`, { method: 'POST', headers: { 'x-phc-api-key': PHC_KEY }, body: fd });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* leave null */ }
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`ingest ${res.status}: ${text.slice(0, 200)}`);
  }
  return data;
}

async function waitForGrade(caseId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/api/v1/cases/${caseId}/status`, { headers: { 'x-phc-api-key': PHC_KEY } });
    const body = await r.json().catch(() => ({}));
    if (body.status && body.status !== 'processing') return body.status;
    await new Promise((res) => setTimeout(res, 3000));
  }
  return 'timeout';
}

async function runOne(item) {
  const startedAt = Date.now();
  try {
    const ingested = await ingest(item.name, item.loc);
    const status = await waitForGrade(ingested.caseId);
    let cnnGrade = null;
    if (status === 'graded') {
      const r = await fetch(`${BASE}/api/v1/cases/${ingested.caseId}`, { headers: { 'x-phc-api-key': PHC_KEY } });
      const detail = await r.json().catch(() => ({}));
      cnnGrade = detail.drGradeCnn ?? null;
    }
    return {
      name: item.name, groundTruthGrade: item.grade, caseId: ingested.caseId,
      status, cnnGrade, ms: Date.now() - startedAt,
    };
  } catch (err) {
    return { name: item.name, groundTruthGrade: item.grade, status: 'error', error: err.message, ms: Date.now() - startedAt };
  }
}

async function main() {
  if (!PHC_KEY) { console.error('Set PHC001_API_KEY.'); process.exit(1); }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const done = loadDone();
  const todo = manifest.filter((m) => !done.has(m.name));
  console.log(`${manifest.length} total, ${done.size} already done, ${todo.length} to run, concurrency ${CONCURRENCY}.`);

  let idx = 0;
  let ok = 0, failed = 0, timedOut = 0;
  const startAll = Date.now();

  async function worker() {
    while (idx < todo.length) {
      const item = todo[idx++];
      const result = await runOne(item);
      appendResult(result);
      if (result.status === 'graded') ok++;
      else if (result.status === 'timeout') timedOut++;
      else failed++;
      const elapsedMin = ((Date.now() - startAll) / 60000).toFixed(1);
      console.log(`[${idx}/${todo.length}] ${item.name} gt=${item.grade} -> ${result.status}`
        + `${result.cnnGrade != null ? ` cnn=${result.cnnGrade}` : ''}`
        + `${result.error ? ` (${result.error.slice(0, 80)})` : ''} [${elapsedMin}m elapsed]`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nDone. ${ok} graded, ${failed} failed, ${timedOut} timed out, out of ${todo.length} run this session.`);
  console.log(`Full results: ${RESULTS_PATH}`);
  process.exit(failed + timedOut > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
