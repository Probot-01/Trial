'use strict';


const express = require('express');
const auth = require('../services/localAuth');

const router = express.Router();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map();

function locked(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { failures.delete(key); return false; }
  return f.count >= MAX_FAILURES;
}
function fail(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else f.count += 1;
}

router.post('/login', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.slice(0, 64) : null;
  if (!username || !password) {
    return res.status(400).json({ error: 'invalid_field', message: 'username and password are both required.' });
  }
  const key = `${req.ip}|${username}`;
  if (locked(key)) {
    return res.status(429).json({ error: 'too_many_attempts', message: 'Too many failed logins. Wait 15 minutes.' });
  }
  const user = auth.authenticate(username, password);
  if (!user) {
    fail(key);
    return res.status(401).json({ error: 'invalid_credentials', message: 'Username or password is incorrect.' });
  }
  failures.delete(key);
  const session = auth.issueSession(user, deviceId);
  req.user = user;
  auth.logAccess(req, 'login', 'technician', user.user_id);
  return res.json(session);
});

router.get('/me', (req, res) => {
  const s = auth.readSession(auth.bearer(req));
  if (!s) return res.status(401).json({ error: 'unauthenticated', message: 'No valid session.' });
  return res.json({ user: auth.publicUser(s.user) });
});

router.post('/logout', (req, res) => {
  auth.revokeSession(auth.bearer(req));
  return res.status(204).end();
});

module.exports = router;
