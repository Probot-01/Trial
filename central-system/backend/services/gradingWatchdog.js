'use strict';



const gradingQueue = require('./gradingQueue');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const INTERVAL_MS = num('GRADING_WATCHDOG_INTERVAL_MS', 90_000);
const MIN_AGE_S = num('WATCHDOG_MIN_AGE_SECONDS', 120);
const MAX_RECOVERIES = num('WATCHDOG_MAX_RECOVERIES', 3);

let timer = null;

function sweep() {
  return gradingQueue.recoverStranded({
    source: 'watchdog', minAgeSeconds: MIN_AGE_S, maxRecoveries: MAX_RECOVERIES,
  });
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    sweep().catch((err) => console.error(`[gradingWatchdog] sweep failed: ${err.message}`));
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, sweep, MAX_RECOVERIES, MIN_AGE_S };
