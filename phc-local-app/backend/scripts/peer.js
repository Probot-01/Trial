#!/usr/bin/env node
'use strict';


const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
require('../loadEnv');
const db = require('../db/localDb');
const peerCrypto = require('../services/peerCrypto');
const peerBundle = require('../services/peerBundle');

const [cmd, a1, a2] = process.argv.slice(2);
const port = Number(process.env.PORT || 4000);

function lanUrls() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  return out;
}

(async () => {
  if (cmd === 'pair') {
    const deviceId = `ph-${crypto.randomBytes(6).toString('hex')}`;
    const key = peerCrypto.newKeyB64();
    db.prepare('INSERT INTO peer_devices (device_id, name, key_b64, created_at) VALUES (?, ?, ?, ?)')
      .run(deviceId, String(a1 || 'Phone').slice(0, 60), key, new Date().toISOString());
    const pairing = {
      kind: 'netrasetu-pair', v: 1, deviceId, key, pcDeviceId: db.deviceId(), urls: lanUrls(),
      phcCode: process.env.PHC_CODE || 'PHC001', phcName: process.env.PHC_NAME || null,
    };
    const text = JSON.stringify(pairing);
    console.log(await require('qrcode').toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }));
    console.log(`Paired "${a1 || 'Phone'}" as ${deviceId}. Scan the code in the app: Menu -> Pair with PHC PC.`);
    console.log(`PC addresses offered: ${pairing.urls.join(', ') || '(none found -- is the PC on a network?)'}`);
    console.log('\nThe code contains this phone\'s encryption key: do not photograph or share it.');
  } else if (cmd === 'devices') {
    for (const d of db.prepare('SELECT * FROM peer_devices ORDER BY created_at').all()) {
      console.log(`${d.device_id}  ${d.revoked_at ? 'REVOKED' : 'active '}  last seen ${d.last_seen_at || 'never'}  ${d.name}`);
    }
  } else if (cmd === 'revoke') {
    const r = db.prepare('UPDATE peer_devices SET revoked_at = ? WHERE device_id = ?').run(new Date().toISOString(), a1);
    console.log(r.changes ? `${a1} revoked` : `no device ${a1}`);
  } else if (cmd === 'import') {
    const out = peerBundle.importBundle(JSON.parse(fs.readFileSync(a1, 'utf8')));
    console.log(`imported ${out.records} records from ${out.fromDevice}: ${out.applied} applied, ${out.skipped} already present`);
  } else if (cmd === 'export') {
    const bundle = peerBundle.exportBundle(a1);
    fs.writeFileSync(a2, JSON.stringify(bundle));
    console.log(`wrote ${a2} for ${a1}`);
  } else {
    console.error('Usage: peer pair "<name>" | devices | revoke <deviceId> | import <file> | export <deviceId> <file>');
    process.exitCode = 1;
  }
})().catch((err) => { console.error(`[peer] ${err.message}`); process.exitCode = 1; });
