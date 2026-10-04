'use strict';



const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { raiseAlert, resolveAlert } = require('./systemAlerts');

/**
 * createWorkerSupervisor(cfg)
 *
 * @param {string}   cfg.name            for log lines, e.g. 'matlab'
 * @param {string}   cfg.label           for human text, e.g. 'MATLAB session'
 * @param {string}   cfg.sessionDir      the worker's own directory
 * @param {string}   cfg.heartbeatPath   the file it refreshes while polling
 * @param {string}   cfg.managerScript   the start/stop/status PowerShell script
 * @param {string}   cfg.alertKind       systemAlerts kind, e.g. 'matlab_session_down'
 * @param {Function} cfg.enabled         () => boolean, re-read every pass
 * @param {string}   cfg.giveUpHint      what to check when restarts do not help
 */
function createWorkerSupervisor(cfg) {
  const {
    name, label, sessionDir, heartbeatPath, managerScript, alertKind, enabled,
    giveUpHint = '',
    intervalMs = 30_000,
    staleMs = 30_000,
    startupGraceMs = 240_000,
    maxRestarts = 3,
    restartWindowMs = 30 * 60_000,
  } = cfg;

  const tag = `[${name}Supervisor]`;

  const state = {
    status: enabled() ? 'restarting' : 'disabled',
    lastHeartbeatAt: null,
    restartStartedAt: null,
    restartTimes: [],       // ms timestamps of restarts inside the window
    lastError: null,
  };

  let timer = null;
  let checking = false;

  /** Runs `<managerScript> <cmd>`; resolves { ok, output }. Test seam. */
  let runManager = (cmd) => new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({
        ok: false, output:
          `Automatic restart uses ${path.basename(managerScript)} and is only `
          + 'implemented on Windows.'
      });
    }
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', managerScript, cmd],
      { cwd: sessionDir, env: process.env, timeout: 90_000, windowsHide: true },
      (err, stdout, stderr) => resolve({
        ok: !err, output: `${stdout || ''}${stderr || ''}`.trim() || (err && err.message) || '',
      }));
  });

  function heartbeatAgeMs() {
    try {
      const { mtimeMs } = fs.statSync(heartbeatPath);
      state.lastHeartbeatAt = new Date(mtimeMs).toISOString();
      return Date.now() - mtimeMs;
    } catch {
      return Infinity;
    }
  }

  async function markDown(message) {
    state.status = 'down';
    state.lastError = message;
    console.error(`${tag} DOWN: ${message}`);
    await raiseAlert(alertKind, '', message);
  }

  async function restart(reason) {
    const now = Date.now();
    state.restartTimes = state.restartTimes.filter((t) => now - t < restartWindowMs);
    if (state.restartTimes.length >= maxRestarts) {
      if (state.status !== 'down') {
        await markDown(`${reason} Gave up after ${maxRestarts} restarts in `
          + `${Math.round(restartWindowMs / 60_000)} min -- ${giveUpHint}`);
      }
      return;
    }

    state.restartTimes.push(now);
    state.status = 'restarting';
    state.restartStartedAt = now;
    console.warn(`${tag} ${reason} Restarting the ${label} `
      + `(attempt ${state.restartTimes.length}/${maxRestarts}).`);

    await runManager('stop');
    const started = await runManager('start');
    if (!started.ok) {
      await markDown(`Restart command failed: ${started.output.slice(0, 500)}`);
    }
  }

  /** One supervision pass. Exported for tests; never throws. */
  async function checkOnce() {
    if (!enabled()) { state.status = 'disabled'; return state.status; }
    if (checking) return state.status;
    checking = true;
    try {
      const age = heartbeatAgeMs();

      if (age <= staleMs) {
        if (state.status !== 'healthy') {
          console.log(`${tag} ${label} is healthy.`);
          await resolveAlert(alertKind);
        }
        state.status = 'healthy';
        state.lastError = null;
        state.restartTimes = [];
        return state.status;
      }

      const inGrace = state.status === 'restarting' && state.restartStartedAt
        && Date.now() - state.restartStartedAt < startupGraceMs;
      if (inGrace) return state.status;   // models still loading

      let reason;
      if (state.status === 'restarting' && state.restartStartedAt) {
        reason = `No heartbeat within ${Math.round(startupGraceMs / 1000)}s of a restart.`;
        await raiseAlert(alertKind, '', reason);
      } else if (age === Infinity) {
        reason = `${label} is not running.`;
      } else {
        reason = `${label} heartbeat is ${Math.round(age / 1000)}s old (hung or crashed).`;
      }
      await restart(reason);
      return state.status;
    } catch (err) {
      state.lastError = err.message;
      console.error(`${tag} check failed: ${err.message}`);
      return state.status;
    } finally {
      checking = false;
    }
  }

  function start() {
    if (timer || !enabled()) {
      if (!enabled()) console.log(`${tag} disabled.`);
      return;
    }

    state.status = 'unknown';
    checkOnce();
    timer = setInterval(checkOnce, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /** For GET /api/v1/admin/system-health. */
  function getStatus() {
    return {
      status: state.status === 'unknown' ? 'restarting' : state.status,
      lastHeartbeatAt: state.lastHeartbeatAt,
      restartsInWindow: state.restartTimes.length,
      lastError: state.lastError,
    };
  }

  /** Test seams. */
  function _setManager(fn) { const prev = runManager; runManager = fn; return prev; }
  function _reset(status = 'unknown') {
    state.status = status; state.lastHeartbeatAt = null; state.restartStartedAt = null;
    state.restartTimes = []; state.lastError = null;
  }

  return {
    start, stop, checkOnce, getStatus, _setManager, _reset,
    HEARTBEAT: heartbeatPath, ALERT_KIND: alertKind,
  };
}

module.exports = { createWorkerSupervisor };
