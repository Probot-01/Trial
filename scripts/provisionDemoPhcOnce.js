'use strict';



const path = require('path');
const crypto = require('crypto');
const backendDir = path.resolve(__dirname, '..', 'central-system', 'backend');

const pool = require(path.join(backendDir, 'db', 'pgClient'));
const { hashApiKey } = require(path.join(backendDir, 'services', 'authTokens'));

const DEMO_PHC_NAME = process.env.DEMO_PHC_NAME || 'NetraSetu Demo PHC';

async function run() {
  try {
    const { rows } = await pool.query(
      'SELECT phc_id, name FROM phc_sites WHERE name = $1', [DEMO_PHC_NAME]);
    if (rows.length > 0) {
      console.log(`[provisionDemoPhcOnce] "${DEMO_PHC_NAME}" already provisioned `
        + `(phc_id=${rows[0].phc_id}) -- its key was printed once on an earlier `
        + 'deploy/start and is not re-shown. Nothing to do.');
      return;
    }

    const key = `phc_${crypto.randomBytes(32).toString('base64url')}`;
    const hash = hashApiKey(key);
    const { rows: [site] } = await pool.query(
      'INSERT INTO phc_sites (name, api_key_hash) VALUES ($1, $2) RETURNING phc_id, name',
      [DEMO_PHC_NAME, hash]);

    console.log('');
    console.log('[provisionDemoPhcOnce] Provisioned a new PHC site:');
    console.log(`  PHC       ${site.name}`);
    console.log(`  PHC_ID=${site.phc_id}`);
    console.log(`  PHC_API_KEY=${key}`);
    console.log('');
    console.log('  Put both lines into netrasetu-phc\'s env vars now. The key is not');
    console.log('  stored and cannot be shown again -- this message will not repeat.');
    console.log('');
  } catch (err) {
    // Must not take the whole service down over a one-off provisioning
    // step -- log and let the real server start regardless.
    console.error('[provisionDemoPhcOnce] FAILED (non-fatal, server will still start):',
      err.message);
  } finally {
    await pool.end();
  }
}

run();
