'use strict';



const crypto = require('crypto');
const path = require('path');
const backendDir = path.resolve(__dirname, '..', 'central-system', 'backend');

const pool = require(path.join(backendDir, 'db', 'pgClient'));
const { hashApiKey } = require(path.join(backendDir, 'services', 'authTokens'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function usage(msg) {
  if (msg) console.error(`[provisionPhcKey] ${msg}`);
  console.error('Usage: provisionPhcKey.js --phc-id <uuid> | --create "<PHC name>" | --list');
  process.exitCode = 1;
}

async function run() {
  const phcId = arg('--phc-id');
  const create = arg('--create');

  try {
    if (process.argv.includes('--list')) {
      const { rows } = await pool.query(`
        SELECT phc_id, name, api_key_hash IS NOT NULL AS has_key, last_contact_at
        FROM phc_sites ORDER BY name`);
      for (const r of rows) {
        console.log(`${r.phc_id}  ${r.has_key ? 'key   ' : 'NO KEY'}  ${r.name}` +
          `${r.last_contact_at ? `  (last contact ${r.last_contact_at.toISOString()})` : ''}`);
      }
      return;
    }

    if (!phcId === !create) return usage('Give exactly one of --phc-id or --create.');
    if (phcId && !UUID_RE.test(phcId)) return usage(`--phc-id is not a UUID: ${phcId}`);
    if (create !== undefined && !create.trim()) return usage('--create needs a PHC name.');


    const key = `phc_${crypto.randomBytes(32).toString('base64url')}`;
    const hash = hashApiKey(key);

    let site;
    if (create) {
      ({ rows: [site] } = await pool.query(
        'INSERT INTO phc_sites (name, api_key_hash) VALUES ($1, $2) RETURNING phc_id, name',
        [create.trim(), hash]));
    } else {
      ({ rows: [site] } = await pool.query(
        'UPDATE phc_sites SET api_key_hash = $2 WHERE phc_id = $1 RETURNING phc_id, name',
        [phcId, hash]));
      if (!site) return usage(`No PHC site with id ${phcId}. Use --list, or --create.`);
    }

    console.log('');
    console.log(`  PHC       ${site.name}`);
    console.log(`  PHC_ID=${site.phc_id}`);
    console.log(`  PHC_API_KEY=${key}`);
    console.log('');
    console.log('  Put both lines in THAT PHC\'s .env now. The key is not stored and');
    console.log('  cannot be shown again; any earlier key for this site no longer works.');
    console.log('');
  } catch (err) {
    console.error('[provisionPhcKey] FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
