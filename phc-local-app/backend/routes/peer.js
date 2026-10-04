'use strict';


const os = require('os');
const express = require('express');
const db = require('../db/localDb');
const peerCrypto = require('../services/peerCrypto');
const peerSync = require('../services/peerSync');
const auth = require('../services/localAuth');
const requireTechnician = require('../middleware/requireTechnician');

const router = express.Router();
const json = express.json({ limit: '60mb' });

const MAX_SKEW_MS = 15 * 60 * 1000;
const NONCE_TTL_MS = 2 * MAX_SKEW_MS;
const seenNonces = new Map(); // nonce -> expiry
const nowIso = () => new Date().toISOString();

function rememberNonce(nonce) {
  const now = Date.now();
  if (seenNonces.size > 5000) for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  if (seenNonces.has(nonce) && seenNonces.get(nonce) > now) return false;
  seenNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}

function lanAddresses(port) {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  return out;
}


function pairingAllowed(req, res, next) {
  const ip = String(req.socket.remoteAddress || '');
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (local) return requireTechnician(req, res, next);
  const s = auth.readSession(auth.bearer(req));
  if (s?.user.role === 'phc_admin') { req.user = s.user; return next(); }
  return res.status(403).json({ error: 'forbidden', message: 'Pair from the PHC PC itself, or as a logged-in PHC admin.' });
}

router.post('/pair', json, pairingAllowed, (req, res) => {
  const name = String(req.body?.name || 'Phone').slice(0, 60);
  const deviceId = `ph-${require('crypto').randomBytes(6).toString('hex')}`;
  const key = peerCrypto.newKeyB64();
  db.prepare('INSERT INTO peer_devices (device_id, name, key_b64, created_at) VALUES (?, ?, ?, ?)')
    .run(deviceId, name, key, nowIso());
  auth.logAccess(req, 'peer_pair', 'peer_device', deviceId);
  const port = Number(process.env.PORT || 4000);
  res.status(201).json({
    pairing: {
      kind: 'netrasetu-pair', v: 1, deviceId, key,
      pcDeviceId: db.deviceId(), urls: lanAddresses(port),
      phcCode: process.env.PHC_CODE || 'PHC001', phcName: process.env.PHC_NAME || null,
    },
  });
});

router.get('/devices', requireTechnician, (req, res) => {
  res.json(db.prepare('SELECT device_id AS deviceId, name, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM peer_devices ORDER BY created_at').all());
});

router.post('/devices/:id/revoke', json, requireTechnician.admin, (req, res) => {
  const r = db.prepare('UPDATE peer_devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(nowIso(), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'device_not_found', message: 'No active paired device with that id.' });
  auth.logAccess(req, 'peer_revoke', 'peer_device', req.params.id);
  return res.status(204).end();
});

function sealed({ checkClock = true } = {}) {
  return (req, res, next) => {
    const deviceId = req.get('x-netra-device');
    const ts = req.get('x-netra-ts');
    const nonce = req.get('x-netra-nonce');
    const deny = (status, error, message) => res.status(status).json({ error, message });
    if (!deviceId || !ts || !nonce || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
      return deny(400, 'peer_headers_missing', 'x-netra-device, x-netra-ts and x-netra-nonce are required.');
    }
    const device = db.prepare('SELECT * FROM peer_devices WHERE device_id = ?').get(deviceId);
    if (!device || device.revoked_at) return deny(401, 'peer_unknown', 'This device is not paired with this PC (or was revoked).');
    if (checkClock && Math.abs(Date.now() - Number(ts)) > MAX_SKEW_MS) {
      return deny(401, 'peer_clock_skew', 'Request timestamp is outside the allowed window. Call /peer/hello to resync.');
    }
    const key = peerCrypto.keyFromB64(device.key_b64);
    const pathOnly = req.baseUrl + req.path;
    let body;
    try {
      body = peerCrypto.openJson(key, req.body, peerCrypto.requestAad({ deviceId, method: req.method, path: pathOnly, ts, nonce }));
    } catch (err) {
      return deny(401, err.code || 'envelope_invalid', 'Could not decrypt the request (wrong key or tampered).');
    }
    // Only a request that decrypted may consume a nonce, or anyone could burn them.
    if (!rememberNonce(`${deviceId}|${nonce}`)) return deny(401, 'peer_replay', 'This request was already processed.');

    db.prepare('UPDATE peer_devices SET last_seen_at = ? WHERE device_id = ?').run(nowIso(), deviceId);
    req.peerDevice = device;
    req.peerBody = body;
    res.sealed = (obj, status = 200) => res.status(status).json(
      peerCrypto.seal(key, obj, peerCrypto.responseAad({ deviceId, path: pathOnly, nonce })));
    return next();
  };
}

/** Technician session for sealed routes: token inside the envelope, not a header. */
function peerTechnician(req, res, next) {
  const token = req.peerBody?.token;
  if (!token) {
    if (!auth.LOCAL_AUTH_ENABLED) return next();
    return res.sealed({ error: 'unauthenticated', message: 'Log in on this device first.' }, 401);
  }
  const s = auth.readSession(token);
  if (!s) return res.sealed({ error: 'session_invalid', message: 'Session expired. Log in again.' }, 401);
  req.user = s.user;
  return next();
}

const fail = (res, err) => {
  const status = ['image_missing', 'checksum_mismatch', 'invalid_field'].includes(err.code) ? 400 : 500;
  if (status === 500) console.error('[peer]', err);
  return res.sealed({ error: err.code || 'internal_error', message: err.message }, status);
};

router.post('/hello', json, sealed({ checkClock: false }), (req, res) => {
  res.sealed({
    serverTime: Date.now(), pcDeviceId: db.deviceId(),
    phcCode: process.env.PHC_CODE || 'PHC001', phcName: process.env.PHC_NAME || null,
    authRequired: auth.LOCAL_AUTH_ENABLED,
  });
});

router.post('/login', json, sealed(), (req, res) => {
  const user = auth.authenticate(req.peerBody?.username, req.peerBody?.password);
  if (!user) return res.sealed({ error: 'invalid_credentials', message: 'Username or password is incorrect.' }, 401);
  const session = auth.issueSession(user, req.peerDevice.device_id);
  req.user = user;
  auth.logAccess(req, 'login', 'technician', user.user_id);
  return res.sealed(session);
});

router.post('/pull', json, sealed(), peerTechnician, (req, res) => {
  try {
    const out = peerSync.changesSince(req.peerBody?.cursor ?? 0, req.peerDevice.device_id);
    auth.logAccess(req, 'peer_pull', 'records', String(out.records.length));
    res.sealed(out);
  } catch (err) { fail(res, err); }
});

router.post('/push', json, sealed(), peerTechnician, (req, res) => {
  try {
    const records = Array.isArray(req.peerBody?.records) ? req.peerBody.records : [];
    const out = peerSync.applyRecords(records, req.peerDevice.device_id);
    auth.logAccess(req, 'peer_push', 'records', String(records.length));
    res.sealed(out);
  } catch (err) { fail(res, err); }
});

router.post('/image/get', json, sealed(), peerTechnician, (req, res) => {
  const img = peerSync.readImage(String(req.peerBody?.captureId || ''));
  if (!img) return res.sealed({ error: 'image_not_found', message: 'No image for that capture on this PC.' }, 404);
  auth.logAccess(req, 'peer_image_get', 'capture', req.peerBody.captureId);
  return res.sealed({ bytesB64: img.bytes.toString('base64'), sha256: img.sha256, ext: img.ext });
});

router.post('/image/put', json, sealed(), peerTechnician, (req, res) => {
  try {
    const b = req.peerBody || {};
    peerSync.writeImage(String(b.captureId || ''), Buffer.from(String(b.bytesB64 || ''), 'base64'), b.sha256, b.ext);
    auth.logAccess(req, 'peer_image_put', 'capture', b.captureId);
    res.sealed({ stored: true });
  } catch (err) { fail(res, err); }
});

/**
 * An export bundle made on a phone (for when there is no network at all),
 * uploaded through the desktop -- same key, same merge. Also importable
 * without a server: scripts/peerBundle.js import <file>.
 */
router.post('/bundle', json, requireTechnician, (req, res) => {
  try {
    const out = require('../services/peerBundle').importBundle(req.body);
    auth.logAccess(req, 'peer_bundle_import', 'bundle', `${out.fromDevice}:${out.applied}`);
    res.json(out);
  } catch (err) {
    res.status(err.code === 'envelope_invalid' || err.code === 'peer_unknown' ? 401 : 400)
      .json({ error: err.code || 'bundle_invalid', message: err.message });
  }
});

router.pairingAllowed = pairingAllowed; // exported for tests
module.exports = router;
