
const path = require('path');
const {
  runBranchAInference,
  runBranchAInferenceMatlab,
} = require(path.join(__dirname, '..', '..', 'services', 'gradingOrchestrator.js'));

const IDRID_DIR = path.join(
  __dirname, '..', 'datasets', 'idrid', 'grading', 'B. Disease Grading',
  '1. Original Images', 'a. Training Set');

const N = parseInt(process.argv[2] || '5', 10);
const IMAGES = Array.from({ length: N }, (_, i) =>
  path.join(IDRID_DIR, `IDRiD_${163 + i}.jpg`));

async function timeCalls(label, fn) {
  const times = [];
  for (const img of IMAGES) {
    const t0 = Date.now();
    try {
      const out = await fn(img, '');
      const ms = Date.now() - t0;
      times.push(ms);
      console.log(`  ${label}  ${path.basename(img)}  ${ms} ms  grade=${out.drGradeCnn} tier=${out.conformalTier}`);
    } catch (err) {
      const ms = Date.now() - t0;
      times.push(ms);
      console.log(`  ${label}  ${path.basename(img)}  ${ms} ms  FAILED: ${err.message.split('\n')[0]}`);
    }
  }
  return times;
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  return { min: sorted[0], max: sorted[sorted.length - 1], mean, median };
}

(async () => {
  console.log(`Measuring ${N} images per backend, one cold process per call (current architecture).\n`);

  console.log('-- Python backend (branchAInfer.py) --');
  const pyTimes = await timeCalls('python', runBranchAInference);

  console.log('\n-- MATLAB backend (branchAInferMatlab.m) --');
  const mlTimes = await timeCalls('matlab', runBranchAInferenceMatlab);

  const pyStats = stats(pyTimes);
  const mlStats = stats(mlTimes);

  console.log('\n===== Summary (ms) =====');
  console.log(`python  min=${pyStats.min} median=${pyStats.median} mean=${pyStats.mean.toFixed(0)} max=${pyStats.max}`);
  console.log(`matlab  min=${mlStats.min} median=${mlStats.median} mean=${mlStats.mean.toFixed(0)} max=${mlStats.max}`);
  console.log(`\nMATLAB is ${(mlStats.mean / pyStats.mean).toFixed(1)}x the Python cold-start latency per image.`);
})();
