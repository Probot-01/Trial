'use strict';

/**
 * Quality gate with the JS fallback tier OPTED IN (QUALITY_GATE_ALLOW_FALLBACK=1)
 * and no MATLAB on the machine.
 *
 * The JS tier is switched off in code (its decisions diverged from MATLAB's), so
 * "opted in, MATLAB absent" must end the same way as "not opted in": a truthful
 * 503 quality_gate_failed with the image kept -- NOT a made-up verdict such as the
 * old { status: 'retake', reason: 'MATLAB_UNAVAILABLE' }, which told technicians
 * to retake photographs that had never been checked.
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
let server, base;

before(async () => {
  server = require('../server').createServer().server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); server?.closeAllConnections?.(); });

test('fallback opted in but switched off: 503, never a verdict', async () => {
  const p = await (await fetch(`${base}/patients`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Fallback Test', age: 44, contactNumber: '+919833333333' }),
  })).json();

  const form = new FormData();
  form.append('patientId', p.patientId);
  form.append('image', new Blob([fs.readFileSync(FIXTURE)], { type: 'image/jpeg' }), 'x.jpg');
  const res = await fetch(`${base}/captures`, { method: 'POST', body: form });
  const body = await res.json();

  assert.equal(res.status, 503, JSON.stringify(body));
  assert.equal(body.error, 'quality_gate_failed');
  assert.match(body.message, /switched off/i);
  assert.equal(body.qualityStatus, undefined, 'no quality verdict is invented');
  assert.match(body.captureId, /^PHC001-/);

  const db = require('../db/localDb');
  const c = db.prepare('SELECT quality_status FROM captures WHERE capture_id = ?').get(body.captureId);
  assert.equal(c.quality_status, 'pending', 'the capture waits for a real check');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_queue').get().n, 0);
});
