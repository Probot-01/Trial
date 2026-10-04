'use strict';



const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const backendDir = path.join(ROOT, 'central-system', 'backend');

const pool = require(path.join(backendDir, 'db', 'pgClient'));       // also loads the backend's .env
const bcrypt = require(require.resolve('bcryptjs', { paths: [backendDir] }));
const { hashApiKey } = require(path.join(backendDir, 'services', 'authTokens'));

const BCRYPT_COST = 12;   // same as scripts/seedDemoUsers.js

const USERS = [
  {
    email: 'ophthalmologist@demo.netrasetu.local', name: 'Dr. Demo Ophthalmologist',
    role: 'ophthalmologist', passwordEnv: 'DEMO_OPHTHALMOLOGIST_PASSWORD'
  },
  {
    email: 'admin@demo.netrasetu.local', name: 'Demo District Admin',
    role: 'district_admin', passwordEnv: 'DEMO_ADMIN_PASSWORD'
  },
];

const SITES = [
  { name: 'PHC Kharadi', code: 'PHC001' },
  { name: 'PHC Wagholi', code: 'PHC002' },
];

const FORCE = process.argv.includes('--force');
const WRITE_ENV = process.argv.includes('--write-phc-env');

const randomPassword = () => crypto.randomBytes(12).toString('base64url');
const newApiKey = () => `phc_${crypto.randomBytes(32).toString('base64url')}`;   // provisionPhcKey.js format

async function alreadySeeded(client) {
  const { rows: [u] } = await client.query(
    'SELECT count(*)::int AS n FROM users WHERE email = ANY($1)', [USERS.map((x) => x.email)]);
  const { rows: [s] } = await client.query(
    'SELECT count(*)::int AS n FROM phc_sites WHERE name = ANY($1) AND api_key_hash IS NOT NULL',
    [SITES.map((x) => x.name)]);
  return u.n === USERS.length && s.n === SITES.length;
}

function upsertEnv(file, values) {
  if (!fs.existsSync(file) && fs.existsSync(`${file}.example`)) fs.copyFileSync(`${file}.example`, file);
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '\n')}${key}=${value}\n`;
  }
  fs.writeFileSync(file, text);
}

async function run() {
  const client = await pool.connect();
  try {
    if (!FORCE && await alreadySeeded(client)) {
      console.log('[seed-demo] Already seeded (2 demo users, 2 PHC sites with keys). Nothing changed.');
      console.log('[seed-demo] Credentials are only shown when issued; run with --force to issue new ones.');
      return;
    }

    await client.query('BEGIN');

    const issuedUsers = [];
    for (const u of USERS) {
      const fromEnv = process.env[u.passwordEnv];
      const password = fromEnv || randomPassword();
      const hash = await bcrypt.hash(password, BCRYPT_COST);
      await client.query(`
        INSERT INTO users (email, name, role, password_hash)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email) DO UPDATE
          SET name = EXCLUDED.name, role = EXCLUDED.role,
              password_hash = EXCLUDED.password_hash,
              is_active = true, deactivated_at = NULL
      `, [u.email, u.name, u.role, hash]);
      issuedUsers.push({ ...u, password, source: fromEnv ? `from ${u.passwordEnv}` : 'generated' });
    }

    const issuedSites = [];
    for (const s of SITES) {
      const key = newApiKey();
      const keyHash = hashApiKey(key);
      // Keep an existing row's phc_id (cases already attributed to it stay
      // attributed); otherwise create the row.
      const { rows: [existing] } = await client.query(
        'SELECT phc_id FROM phc_sites WHERE name = $1 ORDER BY phc_id LIMIT 1', [s.name]);
      const { rows: [site] } = existing
        ? await client.query('UPDATE phc_sites SET api_key_hash = $2, phc_code = $3 WHERE phc_id = $1 RETURNING phc_id',
          [existing.phc_id, keyHash, s.code])
        : await client.query('INSERT INTO phc_sites (name, api_key_hash, phc_code) VALUES ($1, $2, $3) RETURNING phc_id',
          [s.name, keyHash, s.code]);
      issuedSites.push({ ...s, phcId: site.phc_id, key });
    }

    await client.query('COMMIT');

    const line = '─'.repeat(78);
    console.log(`\n${line}`);
    console.log('  DEMO CREDENTIALS — shown ONCE. Only hashes are stored; copy what you need now.');
    console.log(line);
    for (const u of issuedUsers) {
      console.log(`  ${u.role.padEnd(16)} ${u.email.padEnd(40)} ${u.password}   (${u.source})`);
    }
    console.log(line);
    for (const s of issuedSites) {
      console.log(`  ${s.name}  (PHC_CODE=${s.code})`);
      console.log(`    PHC_ID=${s.phcId}`);
      console.log(`    PHC_API_KEY=${s.key}`);
    }
    console.log(line);
    console.log('  No cases were created: they arrive only through capture -> sync -> grading.');

    if (WRITE_ENV) {
      const envFile = path.join(ROOT, 'phc-local-app', 'backend', '.env');
      const s = issuedSites[0];
      upsertEnv(envFile, { PHC_ID: s.phcId, PHC_API_KEY: s.key, PHC_CODE: s.code, PHC_NAME: s.name });
      console.log(`  ${s.name}'s PHC_ID / PHC_API_KEY / PHC_CODE / PHC_NAME written to`);
      console.log(`  ${path.relative(ROOT, envFile)} (git-ignored), so the local PHC backend syncs as that site.`);
    }
    console.log(`${line}\n`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('[seed-demo] FAILED:', err.message);
    if (/relation .* does not exist/.test(err.message)) {
      console.error('[seed-demo] Run the migrations first: node scripts/setupCentralDb.js');
    }
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
