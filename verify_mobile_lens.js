const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4000;
const BASE_URL = `http://localhost:${PORT}`;

// ── Technician session ──────────────────────────────────────────────────────
// The PHC backend enforces technician auth by default now (its .env.example
// ships LOCAL_AUTH_ENABLED=true), because with it off an anonymous
// GET /patients returns every registered patient's name, age and phone number
// to anything on the clinic LAN. This script registers a patient and uploads a
// capture, so it needs a session like any other client.
//
// Fixed account name, created on the first run and password-reset on every one
// after: a timestamped name would leave a new technician row behind each run,
// and those rows cannot be deleted afterwards because sessions and the access
// log reference them.
const { execFileSync } = require('child_process');
const PHC_BACKEND = path.join(__dirname, 'phc-local-app', 'backend');
const TECH = { u: 'zz_verify_mobile', p: 'Verify-MobileLens-Pw-1!' };

function ensureTechnician() {
  const run = (...args) => execFileSync('node',
    [path.join(PHC_BACKEND, 'scripts', 'technician.js'), ...args],
    { cwd: PHC_BACKEND, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    run('add', TECH.u, 'Verify MobileLens', '--password', TECH.p);
  } catch {
    run('reset', TECH.u, '--password', TECH.p);   // also reactivates
  }
}

async function login() {
  const r = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TECH.u, password: TECH.p }),
  });
  const b = await r.json().catch(() => null);
  if (!r.ok || !b?.token) {
    console.error(`Could not log in as ${TECH.u}: ${r.status}`, b);
    process.exit(1);
  }
  return b.token;
}


// We will use 1_quality_pass.jpg from the dataset
const IMAGE_PATH = path.join(__dirname, 'demo_images', '1_quality_pass.jpg'); 
if (!fs.existsSync(IMAGE_PATH)) {
  console.error(`Image not found at ${IMAGE_PATH}`);
  process.exit(1);
}

// We will test using fetch and FormData
async function runTests() {
  console.log('--- Testing POST /captures/mobile ---');
  let failures = 0;

  function check(label, condition) {
    if (condition) {
      console.log(`  PASS  ${label}`);
    } else {
      console.log(`  FAIL  ${label}`);
      failures++;
    }
  }

  // A hardcoded patientId from a previous run's database doesn't survive a
  // fresh DB (demo-reset, a clean clone, a different machine) -- register
  // one of our own, same as any real capture would need. contactNumber and
  // name are the only two the route actually requires (routes/patients.js).
  ensureTechnician();
  const TOKEN = await login();
  const auth = { Authorization: `Bearer ${TOKEN}` };

  const regRes = await fetch(`${BASE_URL}/patients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      name: 'Verify MobileLens Testpatient',
      contactNumber: '+919999999999',
      age: '45',
    }),
  });
  const regData = await regRes.json();
  if (regRes.status !== 201 || !regData.patientId) {
    console.error('Could not register a test patient:', regRes.status, regData);
    process.exit(1);
  }
  const PATIENT_ID = regData.patientId;
  console.log(`  -> Registered test patient ${PATIENT_ID}`);

  // 1. Test missing patientId
  let form = new FormData();
  form.append('image', new Blob([fs.readFileSync(IMAGE_PATH)], { type: 'image/jpeg' }), 'test.jpg');

  let res = await fetch(`${BASE_URL}/captures/mobile`, {
    method: 'POST',
    headers: auth,          // FormData sets its own multipart boundary
    body: form,
  });
  let data = await res.json();
  if (res.status !== 400 || data.error !== 'patient_id_required') {
     console.log('T1 Failed! Status:', res.status, 'Data:', data);
  }
  check('missing patientId returns 400', res.status === 400 && data.error === 'patient_id_required');

  // 2. Test missing image
  form = new FormData();
  form.append('patientId', PATIENT_ID);
  res = await fetch(`${BASE_URL}/captures/mobile`, {
    method: 'POST',
    headers: auth,          // FormData sets its own multipart boundary
    body: form,
  });
  data = await res.json();
  check('missing image returns 400', res.status === 400 && data.error === 'image_required');

  // 3. Test successful request with patientId and image
  form = new FormData();
  form.append('patientId', PATIENT_ID);
  form.append('image', new Blob([fs.readFileSync(IMAGE_PATH)], { type: 'image/jpeg' }), 'test.jpg');

  console.log('  -> Submitting valid image to /captures/mobile (this will spawn MATLAB and take a few seconds...)');
  res = await fetch(`${BASE_URL}/captures/mobile`, {
    method: 'POST',
    headers: auth,          // FormData sets its own multipart boundary
    body: form,
  });
  data = await res.json();
  
  if (res.status !== 201) {
     console.log('T3 Failed! Status:', res.status, 'Data:', data);
  }

  check('valid capture returns 201 Created', res.status === 201);
  check('response includes captureId', !!data.captureId);

  check('response qualityStatus is passed or retake or borderline', ['pass', 'retake', 'borderline'].includes(data.qualityStatus));
  
  if (data.captureId) {
    console.log(`  -> Successfully captured as ${data.captureId} with status ${data.qualityStatus}`);
    
    // Verify it is in the database with the correct camera_device_id
    const db = require('./phc-local-app/backend/db/localDb');
    const row = db.prepare('SELECT camera_device_id FROM captures WHERE capture_id = ?').get(data.captureId);
    check('database correctly recorded camera_device_id as mobile_lens', row && row.camera_device_id === 'mobile_lens');
  }

  if (failures === 0) {
    console.log('\nAll tests passed successfully!');
    process.exit(0);
  } else {
    console.error(`\n${failures} tests failed.`);
    process.exit(1);
  }
}

// Start the server
console.log('Starting PHC local backend...');
const serverProc = spawn('node', ['server.js'], {
  cwd: path.join(__dirname, 'phc-local-app', 'backend'),
  stdio: 'inherit',
  env: { ...process.env, PORT: PORT.toString(), SYNC_DISABLED: '1' } // Disable sync so it doesn't pollute central server
});

// Give it 2 seconds to start
setTimeout(async () => {
  try {
    await runTests();
  } catch (err) {
    console.error('Test execution failed:', err);
    serverProc.kill();
    process.exit(1);
  } finally {
    serverProc.kill();
  }
}, 2000);
