'use strict';

/**
 * provisionDemoPhcOnce.js -- idempotent, log-visible twin of
 * `provisionPhcKey.js --create`, for a deployment with no shell access.
 *
 * The online-demo Render deployment has no Shell/Jobs on the free tier, so
 * the normal one-off `npm run provision-phc-key -- --create "<name>"`
 * can't be run interactively. This runs instead from
 * central-system/backend/Dockerfile's own CMD chain, on every container
 * start, but only acts ONCE for the deployment's lifetime: it checks for a
 * PHC site named DEMO_PHC_NAME first, and does nothing if one already
 * exists -- a cold-start restart (the free tier's normal behaviour after
 * inactivity) must never create a second "NetraSetu Demo PHC" row.
 *
 * The new key is printed to stdout (ordinary Render logs, which ARE
 * reachable without Shell) exactly once, the same way provisionPhcKey.js
 * already does for an interactive run -- it is never stored and can never
 * be shown again after this.
 */

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
