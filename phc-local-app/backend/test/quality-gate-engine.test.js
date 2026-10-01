'use strict';

/**
 * Quality gate with the JS fallback tier OPTED IN (QUALITY_GATE_ALLOW_FALLBACK=1)
 * and no MATLAB on the machine -- the hosted (Linux, MATLAB-less) PHC's setup.
 *
 * History: the JS tier was switched off on 2026-09-27 because its scores had
 * drifted from MATLAB's, and this test pinned the resulting 503. On
 * 2026-10-02 qualityGateFallback.js was rewritten as a step-by-step port and
 * re-enabled only after verify_quality_gate_parity.js reached zero mismatches
 * (plus a 52-image check: 40 public-dataset images and 12 degraded copies, every
 * decision identical). So this test now demands the stronger property: the
 * opted-in fallback returns the SAME verdict MATLAB gives for this fixture,
 * scores within the parity tolerance, and says which engine produced it.
 *
 * The "gate cannot run at all -> truthful 503, never an invented verdict"
 * guarantee is unchanged and still tested in sync-flow.test.js (fallback NOT
 * opted in).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phc-gate-engine-test-'));
// Auth posture pinned, like every other env var in this file. These are
// SYNC/GATE flow tests, not auth tests: the enforced path has its own suite
// (test/auth-peer.test.js, which pins this to 'true' and asserts patient data
// needs a session). Left unset, the flag came from whichever .env the
// developer had, so the result of this suite depended on local config -- it
// broke the day LOCAL_AUTH_ENABLED started defaulting to true, which is now
// the shipped default precisely because anonymous reads leak patient data.
process.env.LOCAL_AUTH_ENABLED = 'false';
process.env.LOCAL_DB_PATH = path.join(TMP, 'local.sqlite');
process.env.LOCAL_STORAGE_DIR = path.join(TMP, 'storage');
process.env.SYNC_DISABLED = '1';
process.env.MATLAB_EXECUTABLE = path.join(TMP, 'no-such-matlab');
process.env.MATLAB_TIMEOUT_MS = '1000';
process.env.QUALITY_GATE_ALLOW_FALLBACK = '1';
delete process.env.QUALITY_GATE_EXE;

const FIXTURE = path.resolve(__dirname, '../../../tests/fixtures/idrid_163_good_borderline.jpg');

// qualityGateMain('tests/fixtures/idrid_163_good_borderline.jpg', 'unknown') in
// MATLAB R2026a, 2026-10-02.
const MATLAB_REFERENCE = {
  status: 'borderline',
  scores: {
    focusScore: 0.30255740693643762,
    illuminationScore: 0.6237602954220296,
    fovScore: 1,
    coveragePercent: 0.69098585155332881,
    glareScore: 0,
    motionScore: 0.0042264045638183275,
    occlusionScore: 0.060510727182704595,
  },
};
const TOL = 1e-3;   // verify_quality_gate_parity.js's tolerance

let server, base;

before(async () => {
  server = require('../server').createServer().server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); server?.closeAllConnections?.(); });

test('fallback opted in, no MATLAB: MATLAB\'s own verdict, labelled js-fallback', async () => {
  const p = await (await fetch(`${base}/patients`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Fallback Test', age: 44, contactNumber: '+919833333333' }),
  })).json();

  const form = new FormData();
  form.append('patientId', p.patientId);
  form.append('image', new Blob([fs.readFileSync(FIXTURE)], { type: 'image/jpeg' }), 'x.jpg');
  const res = await fetch(`${base}/captures`, { method: 'POST', body: form });
  const body = await res.json();

  assert.equal(res.status, 201, JSON.stringify(body));
  assert.match(body.captureId, /^PHC001-/);
  assert.equal(body.qualityStatus, MATLAB_REFERENCE.status);

  const db = require('../db/localDb');
  const row = db.prepare('SELECT quality_status, quality_scores, quality_engine FROM captures WHERE capture_id = ?')
    .get(body.captureId);
  assert.equal(row.quality_status, MATLAB_REFERENCE.status);

  const engine = JSON.parse(row.quality_engine);
  assert.equal(engine.engine, 'js-fallback', 'the engine that judged the image is recorded');
  assert.equal(engine.fallback, true);

  const scores = JSON.parse(row.quality_scores);
  for (const [k, want] of Object.entries(MATLAB_REFERENCE.scores)) {
    assert.ok(Math.abs(scores[k] - want) <= TOL, `${k}: js=${scores[k]} matlab=${want}`);
  }
});
