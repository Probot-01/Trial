'use strict';



const path = require('path');
const { createWorkerSupervisor } = require('./workerSupervisor');

const SESSION_DIR = path.join(__dirname, '..', 'ml-pipeline', 'inference', 'segSession');

const HEARTBEAT = process.env.SEG_HEARTBEAT_PATH
  || path.join(SESSION_DIR, 'worker.heartbeat');
const MANAGER = path.join(SESSION_DIR, 'manageSegWorker.ps1');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const ALERT_KIND = 'seg_worker_down';

function enabled() {
  const flag = process.env.SEG_WORKER_SUPERVISOR_ENABLED;
  return !(flag !== undefined && flag !== '' && /^(0|false|no|off)$/i.test(flag.trim()));
}

const supervisor = createWorkerSupervisor({
  name: 'segWorker',
  label: 'segmentation worker',
  sessionDir: SESSION_DIR,
  heartbeatPath: HEARTBEAT,
  managerScript: MANAGER,
  alertKind: ALERT_KIND,
  enabled,
  giveUpHint: 'check ml-pipeline/inference/segSession/worker.log and '
    + 'worker.stderr.log (a missing checkpoint or a Python environment problem '
    + 'will not be fixed by restarting). Grading continues without it, about '
    + '17 s slower per case.',
  intervalMs: num('SEG_SUPERVISOR_INTERVAL_MS', 30_000),
  staleMs: num('SEG_HEARTBEAT_STALE_MS', 30_000),

  startupGraceMs: num('SEG_STARTUP_GRACE_MS', 90_000),
  maxRestarts: num('SEG_MAX_RESTARTS', 3),
  restartWindowMs: num('SEG_RESTART_WINDOW_MS', 30 * 60_000),
});

module.exports = {
  start: supervisor.start,
  stop: supervisor.stop,
  checkOnce: supervisor.checkOnce,
  getStatus: supervisor.getStatus,
  _setManager: supervisor._setManager,
  _reset: supervisor._reset,
  HEARTBEAT, ALERT_KIND,
};
