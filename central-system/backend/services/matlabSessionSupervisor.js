'use strict';


const path = require('path');
const { createWorkerSupervisor } = require('./workerSupervisor');

const SESSION_DIR = path.join(__dirname, '..', 'ml-pipeline', 'inference', 'matlabSession');

const HEARTBEAT = process.env.MATLAB_HEARTBEAT_PATH
  || path.join(SESSION_DIR, 'session.heartbeat');
const MANAGER = path.join(SESSION_DIR, 'manageMatlabSession.ps1');

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const ALERT_KIND = 'matlab_session_down';

function enabled() {

  const classifier = (process.env.INFERENCE_BACKEND || 'matlab').toLowerCase();
  const segmentation = (process.env.SEG_INFERENCE_BACKEND || 'matlab').toLowerCase();
  const flag = process.env.MATLAB_SUPERVISOR_ENABLED;
  const off = flag !== undefined && flag !== '' && /^(0|false|no|off)$/i.test(flag.trim());
  return (classifier === 'matlab' || segmentation === 'matlab') && !off;
}

const supervisor = createWorkerSupervisor({
  name: 'matlab',
  label: 'MATLAB session',
  sessionDir: SESSION_DIR,
  heartbeatPath: HEARTBEAT,
  managerScript: MANAGER,
  alertKind: ALERT_KIND,
  enabled,
  giveUpHint: 'check ml-pipeline/inference/matlabSession/session.log and '
    + 'session.stderr.log (missing models/*.mat files, or a licence problem, '
    + 'will not be fixed by restarting).',
  intervalMs: num('MATLAB_SUPERVISOR_INTERVAL_MS', 30_000),
  staleMs: num('MATLAB_HEARTBEAT_STALE_MS', 30_000),
  startupGraceMs: num('MATLAB_STARTUP_GRACE_MS', 240_000),
  maxRestarts: num('MATLAB_MAX_RESTARTS', 3),
  restartWindowMs: num('MATLAB_RESTART_WINDOW_MS', 30 * 60_000),
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
