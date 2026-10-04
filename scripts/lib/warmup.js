'use strict';



const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const backend = path.resolve(__dirname, '..', '..', 'central-system', 'backend');
require(require.resolve('dotenv', { paths: [backend] })).config({ path: path.join(backend, '.env') });
const matlabSession = require(path.join(backend, 'services', 'matlabSessionClient'));
const segSession = require(path.join(backend, 'services', 'segSessionClient'));

(async () => {
  const image = process.argv[2];
  const py = process.env.PYTHON_EXECUTABLE || 'python';
  const tensor = path.join(os.tmpdir(), `netrasetu_warm_${process.pid}.mat`);
  const r = spawnSync(py, [path.join(backend, 'ml-pipeline', 'inference', 'preprocessBranchATensor.py'), image, tensor],
    { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`preprocessing failed: ${(r.stderr || '').slice(-300)}`);
  try {
    const a = await matlabSession.call({ tensorPath: tensor, gradcamPath: '' }, { timeoutMs: 180000, prefix: 'warm' });
    console.log(`classifier answered (grade ${a.drGradeCnn !== undefined ? a.drGradeCnn : a.dr_grade_cnn})`);
  } finally { fs.rmSync(tensor, { force: true }); }
  const segBackend = (process.env.SEG_INFERENCE_BACKEND || 'matlab').toLowerCase();
  if (segBackend === 'python') {
    await segSession.call({ image, outdir: '' }, { timeoutMs: 240000, prefix: 'seg' });
    console.log('segmentation worker answered');
  } else {
    console.log(`segmentation runs through MATLAB (SEG_INFERENCE_BACKEND=${segBackend}); python seg worker not warmed`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
