#!/usr/bin/env node
'use strict';

require('../loadEnv');
const crypto = require('crypto');
const db = require('../db/localDb');
const { hashPassword } = require('../services/passwords');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const has = (name) => argv.includes(name);
const now = () => new Date().toISOString();
const randomPassword = () => crypto.randomBytes(9).toString('base64url');

function usage(msg) {
  if (msg) console.error(`[technician] ${msg}`);
  console.error('Usage: technician add <username> "<Full Name>" [--admin] [--password <pw>] | reset <username> [--password <pw>] | deactivate <username> | list');
  process.exitCode = 1;
}

const [cmd, username, name] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--password'));

try {
  if (cmd === 'list') {
    for (const t of db.prepare('SELECT username, name, role, is_active, created_at FROM technicians ORDER BY username').all()) {
      console.log(`${t.username.padEnd(16)} ${t.role.padEnd(11)} ${t.is_active ? 'active  ' : 'INACTIVE'} ${t.name}`);
    }
  } else if (cmd === 'add') {
    if (!username || !name) usage('add needs <username> and "<Full Name>".');
    else if (!/^[a-z0-9._-]{3,32}$/.test(username.toLowerCase())) usage('username: 3-32 of a-z 0-9 . _ -');
    else {
      const pw = opt('--password') || randomPassword();
      db.prepare(`INSERT INTO technicians (user_id, username, name, role, password_hash, is_active, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(`tech-${crypto.randomBytes(6).toString('hex')}`, username.toLowerCase(), name, has('--admin') ? 'phc_admin' : 'technician',
          hashPassword(pw), now(), now());
      console.log(`created ${username.toLowerCase()} (${has('--admin') ? 'phc_admin' : 'technician'})`);
      if (!opt('--password')) console.log(`password: ${pw}   <- shown once, give it to the technician`);
    }
  } else if (cmd === 'reset') {
    const pw = opt('--password') || randomPassword();
    const r = db.prepare('UPDATE technicians SET password_hash = ?, is_active = 1, updated_at = ? WHERE username = ?')
      .run(hashPassword(pw), now(), String(username || '').toLowerCase());
    if (!r.changes) usage(`no technician ${username}`);
    else {
      db.prepare('DELETE FROM sessions WHERE user_id = (SELECT user_id FROM technicians WHERE username = ?)').run(username.toLowerCase());
      console.log(`password reset for ${username}; existing sessions ended`);
      if (!opt('--password')) console.log(`password: ${pw}`);
    }
  } else if (cmd === 'deactivate') {
    const r = db.prepare('UPDATE technicians SET is_active = 0, updated_at = ? WHERE username = ?').run(now(), String(username || '').toLowerCase());
    if (!r.changes) usage(`no technician ${username}`);
    else {
      db.prepare('DELETE FROM sessions WHERE user_id = (SELECT user_id FROM technicians WHERE username = ?)').run(username.toLowerCase());
      console.log(`${username} deactivated; sessions ended`);
    }
  } else {
    usage();
  }
} catch (err) {
  usage(err.message.includes('UNIQUE') ? `username ${username} already exists` : err.message);
}
