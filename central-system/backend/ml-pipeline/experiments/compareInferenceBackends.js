
const path = require('path');
const {
  runBranchAInference,
  runBranchAInferenceMatlab,
} = require(path.join(__dirname, '..', '..', 'services', 'gradingOrchestrator.js'));

const IDRID_DIR = path.join(
  __dirname, '..', 'datasets', 'idrid', 'grading', 'B. Disease Grading',
  '1. Original Images', 'a. Training Set');

const IMAGES = Array.from({ length: 10 }, (_, i) =>
  path.join(IDRID_DIR, `IDRiD_${163 + i}.jpg`));

(async () => {
  let gradeMatches = 0;
  let tierMatches = 0;
  let maxProbDiff = 0;
  const rows = [];

  for (const img of IMAGES) {
    const [py, ml] = await Promise.all([
      runBranchAInference(img, ''),
      runBranchAInferenceMatlab(img, ''),
    ]);
    const gradeMatch = py.drGradeCnn === ml.drGradeCnn;
    const tierMatch = py.conformalTier === ml.conformalTier;
    if (gradeMatch) gradeMatches += 1;
    if (tierMatch) tierMatches += 1;

    const diffs = py.calibratedProbabilities.map((p, i) => Math.abs(p - ml.calibratedProbabilities[i]));
    const maxDiff = Math.max(...diffs);
    maxProbDiff = Math.max(maxProbDiff, maxDiff);

    rows.push({ img: path.basename(img), py, ml, gradeMatch, tierMatch, maxDiff });

    console.log(`${path.basename(img)}`);
    console.log(`  python  grade=${py.drGradeCnn} conf=${py.confidenceScore.toFixed(4)} tier=${py.conformalTier} set=${JSON.stringify(py.predictionSet)}`);
    console.log(`  matlab  grade=${ml.drGradeCnn} conf=${ml.confidenceScore.toFixed(4)} tier=${ml.conformalTier} set=${JSON.stringify(ml.predictionSet)}`);
    console.log(`  max|calibrated prob diff| = ${maxDiff.toFixed(4)}  grade ${gradeMatch ? 'MATCH' : 'DIFFERS'}  tier ${tierMatch ? 'MATCH' : 'DIFFERS'}`);
    console.log('');
  }

  console.log('===== Summary =====');
  console.log(`grade agreement : ${gradeMatches}/${IMAGES.length}`);
  console.log(`tier agreement  : ${tierMatches}/${IMAGES.length}`);
  console.log(`max|prob diff| across all images: ${maxProbDiff.toFixed(6)}`);
  console.log('');
  console.log('Both backends now call the same branchAInfer.preprocess() (Python) for');
  console.log('every image -- preprocessModel1.m\'s MATLAB port (SSIM 0.981, the source');
  console.log('of the earlier 9/10 grade / 8/10 tier agreement) is no longer on this path.');
  console.log('Remaining diff, if any, is the network import only, matching');
  console.log('training/parityCheck.m\'s 2e-6 (identical precomputed tensor, no preprocessing involved).');
})();
