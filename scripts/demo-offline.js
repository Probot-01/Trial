#!/usr/bin/env node
'use strict';



const stack = require('./lib/demoStack');

const cfg = stack.config();
const central = cfg.ports.central;
const say = (m) => console.log(m);

async function phcSync() {
  try {
    const { body } = await stack.getJson(`http://localhost:${cfg.ports.phc}/sync/status`);
    return body;
  } catch (e) { return { error: `PHC backend unreachable (${e.message})` }; }
}

async function status() {
  const up = stack.pidsOnPort(central).length > 0;
  const h = up ? await stack.centralHealthy(central).catch(() => false) : false;
  say(`central backend :${central}   ${!up ? 'DOWN' : h ? 'UP, all health checks green' : 'UP, but not yet healthy'}`);
  const s = await phcSync();
  say(`PHC desktop  :${cfg.ports.phc}   ${s.error ? s.error : JSON.stringify(s)}`);
}

async function stop() {
  const pids = await stack.stopPort(central);
  if (!pids.length) { say(`central backend :${central} was already down`); return; }
  say(`central backend :${central} stopped (pid ${pids.join(',')}) -- the PHC desktop is now offline from central`);
}

async function restore() {
  if (stack.pidsOnPort(central).length && await stack.centralHealthy(central).catch(() => false)) {
    say(`central backend :${central} is already up and healthy`); return;
  }
  const t0 = Date.now();
  stack.startCentral(cfg);
  await stack.waitFor(`central /health on :${central}`, () => stack.centralHealthy(central), 5 * 60000, 1000);
  say(`central backend :${central} restored, healthy after ${Math.round((Date.now() - t0) / 1000)} s`);
}

(async () => {
  const cmd = process.argv[2];
  try {
    if (cmd === 'stop') await stop();
    else if (cmd === 'restore') await restore();
    else if (cmd === 'status') await status();
    else if (cmd === 'cycle') { await stop(); await stack.sleep(3000); await restore(); await status(); }
    else { console.error('usage: node scripts/demo-offline.js stop | restore | status | cycle'); process.exitCode = 1; }
  } catch (err) { console.error(`demo-offline ${cmd} FAILED: ${err.message}`); process.exitCode = 1; }
})();
