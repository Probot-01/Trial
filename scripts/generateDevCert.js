'use strict';


const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'certs');
const key = path.join(dir, 'dev-key.pem');
const cert = path.join(dir, 'dev-cert.pem');

fs.mkdirSync(dir, { recursive: true });
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365',
    '-keyout', key, '-out', cert,
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (err) {
  console.error('[generateDevCert] openssl failed:', (err.stderr || err.message).toString());
  process.exit(1);
}

console.log(`[generateDevCert] wrote ${path.relative(root, key)} and ${path.relative(root, cert)}`);
console.log('Add to .env (central backend):');
console.log(`  TLS_KEY_PATH=${key.replace(/\\/g, '/')}`);
console.log(`  TLS_CERT_PATH=${cert.replace(/\\/g, '/')}`);
console.log('And for the PHC backend, so its sync manager trusts it:');
console.log(`  NODE_EXTRA_CA_CERTS=${cert.replace(/\\/g, '/')}   and   CENTRAL_API_URL=https://localhost:5000`);
