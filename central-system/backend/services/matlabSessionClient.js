'use strict';



const path = require('path');
const { createSessionClient } = require('./sessionClient');


const SESSION_DIR = process.env.MATLAB_SESSION_DIR
  || path.join(__dirname, '..', 'ml-pipeline', 'inference', 'matlabSession');

const HEARTBEAT = process.env.MATLAB_HEARTBEAT_PATH
  || path.join(SESSION_DIR, 'session.heartbeat');

const client = createSessionClient({
  dir: SESSION_DIR,
  heartbeatFile: HEARTBEAT,
  staleMs: Number(process.env.MATLAB_HEARTBEAT_STALE_MS) > 0
    ? Number(process.env.MATLAB_HEARTBEAT_STALE_MS) : 30_000,
  label: 'MATLAB session',
});

async function call(payload, opts) {
  try {
    return await client.call(payload, opts);
  } catch (err) {
    if (err.code === 'session_timeout') {
      err.code = 'matlab_session_timeout';
      err.message += ' Is it running? See ml-pipeline/inference/matlabSession/'
        + 'README.md (start it with manageMatlabSession.ps1 start).';
    }
    throw err;
  }
}

module.exports = {
  alive: client.alive,
  call,
  SESSION_DIR,
  REQUEST_DIR: client.REQUEST_DIR,
  RESPONSE_DIR: client.RESPONSE_DIR,
  HEARTBEAT,
};
