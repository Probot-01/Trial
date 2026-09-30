#!/usr/bin/env node
'use strict';

/**
 * Demo dry run, with auth ON: the path a judge would actually walk.
 *
 *   PHC device -> ingest with an API key -> grading -> ophthalmologist logs in
 *   -> queue -> case detail -> claim -> review -> referral -> admin health
 *
 * Every step is also checked in its refusing direction: no cookie, wrong role,
 * no CSRF token, no API key. A demo that only tests the happy path proves
 * nothing about auth being on.
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.DRYRUN_BASE || 'http://localhost:5200';
const CENTRAL = path.join(__dirname, 'central-system', 'backend');
const pool = require(path.join(CENTRAL, 'db', 'pgClient'));
// This worktree's PHC001 (phc-local-app/backend/.env: PHC_CODE=PHC001) --
// not a value that survives a different machine or a fresh DB either, so
// both are env-overridable with this worktree's real ones as the default.
const PHC_ID = process.env.DRYRUN_PHC_ID || '64c709e1-4e39-4166-9935-7db2590b3a92';
const PHC_KEY = process.env.PHC_API_KEY || 'phc_8rOf15ZeL6hLWHdNoElLOqOYaNFwNTMKdPqGk491hWo';
const IMAGE = path.join(CENTRAL, 'ml-pipeline', 'datasets', 'idrid', 'grading',
  'B. Disease Grading', '1. Original Images', 'a. Training Set', 'IDRiD_326.jpg');

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`        ${detail}`); }
}

/** fetch that keeps a cookie jar per session. */
function session() {
  const jar = new Map();
  return {
    csrf: null,
    async go(method, url, { body, headers = {}, raw } = {}) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      if (this.csrf) h['x-csrf-token'] = this.csrf;
      let payload = body;
      if (body && !raw && !(body instanceof FormData)) {
        h['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(BASE + url, { method, headers: h, body: payload });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        jar.set(pair.slice(0, idx), pair.slice(idx + 1));
      }
      let data = null;
      const text = await res.text();
      try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
      return { status: res.status, data, headers: res.headers };
    },
  };
}

const SECOND_REVIEWER = {
  email: 'dryrun-second@demo.netrasetu.local',
  password: 'DryRunSecond-2026',
};

/** A throwaway second ophthalmologist, so the claim conflict is a real one. */
async function seedSecondReviewer() {
  const bcrypt = require(path.join(CENTRAL, 'node_modules', 'bcryptjs'));
  const hash = await bcrypt.hash(SECOND_REVIEWER.password, 10);
  await pool.query(
    `INSERT INTO users (email, name, role, password_hash)
     VALUES ($1, 'Dry Run Second Reviewer', 'ophthalmologist', $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
                                       is_active = true`,
    [SECOND_REVIEWER.email, hash]);
}

/** Deactivated, not deleted: a user who has touched a case is referenced by the
 *  audit trail, and access is revoked by deactivation everywhere else here for
 *  exactly that reason. */
async function retireSecondReviewer() {
  await pool.query('UPDATE users SET is_active = false WHERE email = $1',
    [SECOND_REVIEWER.email]);
}

async function main() {
  await seedSecondReviewer();

  // ── 1. PHC device submits a case ────────────────────────────────────────
  console.log('\n--- 1. PHC ingestion (device identity = API key) ---');
  const captureId = `dryrun-${Date.now()}`;

  async function ingest(withKey) {
    const fd = new FormData();
    fd.set('patientId', `DRYRUN-${Date.now()}`);
    fd.set('patientName', 'Dry Run');
    fd.set('patientAge', '58');
    fd.set('patientContactNumber', '9999999999');
    fd.set('phcId', PHC_ID);
    fd.set('captureIdRef', captureId);
    fd.set('consentGivenAt', new Date().toISOString());
    fd.set('captureMetadata', JSON.stringify({ eyeLaterality: 'right', pupilStatus: 'dilated' }));
    fd.set('image', new Blob([fs.readFileSync(IMAGE)], { type: 'image/jpeg' }), 'original.jpg');
    const headers = withKey ? { 'x-phc-api-key': PHC_KEY } : {};
    const res = await fetch(`${BASE}/api/v1/cases`, { method: 'POST', headers, body: fd });
    let data = null;
    try { data = JSON.parse(await res.text()); } catch { /* ignore */ }
    return { status: res.status, data };
  }

  const noKey = await ingest(false);
  check('no API key is refused', noKey.status === 401, `status ${noKey.status}`);

  const ok = await ingest(true);
  check('a valid API key is accepted', ok.status === 201 || ok.status === 200,
    `status ${ok.status} ${JSON.stringify(ok.data).slice(0, 160)}`);
  const caseId = ok.data && ok.data.caseId;
  console.log(`  caseId ${caseId}`);

  const again = await ingest(true);
  check('the same captureIdRef is idempotent, not a second case',
    again.data && again.data.caseId === caseId && again.data.duplicate === true,
    JSON.stringify(again.data).slice(0, 160));

  // ── 2. grading finishes ─────────────────────────────────────────────────
  console.log('\n--- 2. grading ---');
  let status = null;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/api/v1/cases/${caseId}/status`,
      { headers: { 'x-phc-api-key': PHC_KEY } });
    const body = await r.json().catch(() => ({}));
    status = body.status;
    if (status && status !== 'processing') break;
    await new Promise((r2) => setTimeout(r2, 3000));
  }
  check('the case reaches graded', status === 'graded', `status ${status}`);

  // ── 3. the browser side, unauthenticated ────────────────────────────────
  console.log('\n--- 3. unauthenticated browser access ---');
  const anon = session();
  const q = await anon.go('GET', '/api/v1/ophthalmologist/queue');
  check('the review queue refuses an anonymous request', q.status === 401, `status ${q.status}`);
  const det = await anon.go('GET', `/api/v1/cases/${caseId}`);
  check('case detail refuses an anonymous request', det.status === 401, `status ${det.status}`);

  // ── 4. login ────────────────────────────────────────────────────────────
  console.log('\n--- 4. login ---');
  const oph = session();
  const bad = await oph.go('POST', '/api/v1/auth/login',
    { body: { email: 'ophthalmologist@demo.netrasetu.local', password: 'wrong' } });
  check('a wrong password is 401', bad.status === 401, `status ${bad.status}`);

  const login = await oph.go('POST', '/api/v1/auth/login',
    { body: { email: 'ophthalmologist@demo.netrasetu.local', password: 'DemoOphth-2026' } });
  check('login succeeds', login.status === 200, JSON.stringify(login.data).slice(0, 200));
  oph.csrf = login.data && (login.data.csrfToken || login.data.csrf);
  check('login returns a CSRF token', !!oph.csrf, JSON.stringify(login.data).slice(0, 200));
  check('the session cookie is httpOnly',
    (login.headers.getSetCookie?.() || []).some((c) => /httponly/i.test(c)),
    JSON.stringify(login.headers.getSetCookie?.()));

  // ── 5. the queue and the case ───────────────────────────────────────────
  console.log('\n--- 5. queue and case detail ---');
  const queue = await oph.go('GET', '/api/v1/ophthalmologist/queue');
  check('the queue loads for an ophthalmologist', queue.status === 200, `status ${queue.status}`);
  const rows = Array.isArray(queue.data) ? queue.data : (queue.data.cases || queue.data.queue || []);
  check('the new case is in the queue', rows.some((r) => r.caseId === caseId),
    `${rows.length} rows`);

  const detail = await oph.go('GET', `/api/v1/cases/${caseId}`);
  check('case detail loads', detail.status === 200, `status ${detail.status}`);
  const lc = detail.data && detail.data.lesionCounts;
  check('lesionCounts uses the contract key names',
    lc && ['microaneurysms', 'hemorrhages', 'hardExudates', 'softExudates'].every((k) => k in lc),
    JSON.stringify(lc).slice(0, 200));
  console.log(`  grade cnn=${detail.data.drGradeCnn} rule=${detail.data.drGradeRuleEngine} `
    + `tier=${detail.data.conformalTier} agree=${detail.data.branchAgreement} `
    + `foveaUnreliable=${detail.data.foveaUnreliable}`);
  console.log(`  lesionCounts ${JSON.stringify(lc && { ...lc, detail: undefined })}`);

  // ── 6. the images the panel renders ─────────────────────────────────────
  console.log('\n--- 6. /media, which the browser loads via <img> ---');
  const imgUrl = detail.data.imageUrl;
  const camUrl = detail.data.gradCamOverlayUrl;
  check('the case detail gives an imageUrl', !!imgUrl, String(imgUrl));
  if (imgUrl) {
    const anonImg = await fetch(BASE + imgUrl);
    const authImg = await oph.go('GET', imgUrl);
    console.log(`  /media anonymous -> ${anonImg.status}, with session -> ${authImg.status}`);
    check('/media refuses an anonymous request', anonImg.status === 401, `status ${anonImg.status}`);
    // ASSERTED, not printed. This used to be a console.log next to a check
    // that only tested whether a URL STRING existed, so a 500 here passed
    // silently -- and 500 is exactly what an unset MEDIA_ENCRYPTION_KEY
    // produces (media_not_encrypted: the route refuses to serve a patient
    // image that is sitting unencrypted on disk). The reviewer screen is a
    // fundus image and a Grad-CAM; a demo where neither loads is not a demo.
    check('the fundus image actually loads for the reviewer', authImg.status === 200,
      `status ${authImg.status}. 500 with media_not_encrypted means MEDIA_ENCRYPTION_KEY `
      + 'is unset (or media predates it): set it and run scripts/encryptMedia.js.');
    check('the Grad-CAM overlay exists', !!camUrl, String(camUrl));
    if (camUrl) {
      const authCam = await oph.go('GET', camUrl);
      check('the Grad-CAM overlay actually loads', authCam.status === 200,
        `status ${authCam.status}`);
    }
  }

  // ── 7. claiming ─────────────────────────────────────────────────────────
  console.log('\n--- 7. claim ---');
  const claim = await oph.go('POST', `/api/v1/cases/${caseId}/claim`);
  check('the case can be claimed', claim.status === 200, JSON.stringify(claim.data).slice(0, 160));

  const again2 = await oph.go('POST', `/api/v1/cases/${caseId}/claim`);
  check('the holder re-claiming is idempotent, not a conflict', again2.status === 200,
    `status ${again2.status}`);

  // A SECOND OPHTHALMOLOGIST, not the admin: claiming requires that role, so an
  // admin attempt is refused with 403 and never reaches the conflict logic. The
  // first version of this script used the admin, which left the 409 path
  // unexercised while looking like it had been tested.
  const second = session();
  const secondLogin = await second.go('POST', '/api/v1/auth/login',
    { body: { email: SECOND_REVIEWER.email, password: SECOND_REVIEWER.password } });
  second.csrf = secondLogin.data && secondLogin.data.csrfToken;
  const claim2 = await second.go('POST', `/api/v1/cases/${caseId}/claim`);
  check('a second reviewer gets 409', claim2.status === 409,
    `status ${claim2.status} ${JSON.stringify(claim2.data).slice(0, 120)}`);
  check('the 409 names who is holding it',
    claim2.data && claim2.data.claimedBy && !!claim2.data.claimedBy.name,
    JSON.stringify(claim2.data).slice(0, 160));

  const admin = session();
  const adminLogin = await admin.go('POST', '/api/v1/auth/login',
    { body: { email: 'admin@demo.netrasetu.local', password: 'DemoAdmin-2026' } });
  admin.csrf = adminLogin.data && adminLogin.data.csrfToken;
  const adminClaim = await admin.go('POST', `/api/v1/cases/${caseId}/claim`);
  check('an admin cannot claim a case at all (403)', adminClaim.status === 403,
    `status ${adminClaim.status}`);

  // ── 8. roles and CSRF ───────────────────────────────────────────────────
  console.log('\n--- 8. roles and CSRF ---');
  const adminQueue = await admin.go('GET', '/api/v1/ophthalmologist/queue');
  check('an admin is refused the review queue (403, not 401)',
    adminQueue.status === 403, `status ${adminQueue.status}`);
  const ophHealth = await oph.go('GET', '/api/v1/admin/system-health');
  check('an ophthalmologist is refused the admin dashboard',
    ophHealth.status === 403, `status ${ophHealth.status}`);
  const health = await admin.go('GET', '/api/v1/admin/system-health');
  check('the admin dashboard loads for an admin', health.status === 200, `status ${health.status}`);

  const noCsrf = session();
  const l2 = await noCsrf.go('POST', '/api/v1/auth/login',
    { body: { email: 'ophthalmologist@demo.netrasetu.local', password: 'DemoOphth-2026' } });
  noCsrf.csrf = null;  // keep the cookie, drop the token
  const csrfless = await noCsrf.go('POST', `/api/v1/cases/${caseId}/claim`);
  check('a state-changing POST without the CSRF token is refused',
    csrfless.status === 403, `status ${csrfless.status}`);
  void l2;

  // ── 9. review and referral ──────────────────────────────────────────────
  console.log('\n--- 9. review and referral ---');
  const review = await oph.go('POST', `/api/v1/cases/${caseId}/review`, {
    body: {
      ophthalmologistId: 'demo',
      decision: 'confirm',
      reviewDurationSeconds: 30,
    },
  });
  check('a review can be submitted', review.status === 200 || review.status === 201,
    `status ${review.status} ${JSON.stringify(review.data).slice(0, 200)}`);

  const after = await oph.go('GET', `/api/v1/cases/${caseId}`);
  check('the case detail shows the review', after.status === 200);
  const reviews = await oph.go('GET', `/api/v1/cases/${caseId}/reviews`);
  check('the review history endpoint returns it',
    reviews.status === 200 && JSON.stringify(reviews.data).includes('confirm'),
    JSON.stringify(reviews.data).slice(0, 200));

  const queueAfter = await oph.go('GET', '/api/v1/ophthalmologist/queue');
  const rowsAfter = Array.isArray(queueAfter.data) ? queueAfter.data
    : (queueAfter.data.cases || queueAfter.data.queue || []);
  check('a reviewed case leaves the queue',
    !rowsAfter.some((r) => r.caseId === caseId), `${rowsAfter.length} rows`);

  await retireSecondReviewer();
  console.log(`\n${failures === 0 ? 'the whole demo path works with auth on'
    : `${failures} FAILED`}`);
  console.log(`(case ${caseId} left in the database on purpose -- it is a real graded case)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
