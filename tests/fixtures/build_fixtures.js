'use strict';



const fs = require('fs');
const path = require('path');
const sharp = require(require.resolve('sharp', { paths: [path.resolve(__dirname, '..', '..', 'phc-local-app', 'backend')] }));

const ROOT = process.argv[2] || path.resolve(__dirname, '..', '..', 'central-system', 'backend',
  'ml-pipeline', 'datasets', 'idrid', 'grading', 'B. Disease Grading');
const find = (name) => {
  for (const d of ['a. Training Set', 'b. Testing Set']) {
    const p = path.join(ROOT, '1. Original Images', d, `${name}.jpg`);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${name}.jpg not found under ${ROOT}`);
};
const out = (n) => path.join(__dirname, n);

(async () => {
  // Native originals, byte-for-byte (4288x2848, ~350-400 KB each).
  fs.copyFileSync(find('IDRiD_163'), out('idrid_163_good_borderline.jpg'));
  fs.copyFileSync(find('IDRiD_003'), out('idrid_003_good_borderline.jpg'));
  // Downscaled copy (the gate rates it 'pass').
  await sharp(find('IDRiD_010')).resize({ width: 1800 }).jpeg({ quality: 95 }).toFile(out('idrid_010_good_pass_w1800.jpg'));
  // Deliberately bad.
  await sharp(find('IDRiD_164')).resize({ width: 1500 })
    .blur(12)                          // nothing finer than ~25 px survives
    .modulate({ brightness: 0.35 })    // and dark
    .jpeg({ quality: 90 }).toFile(out('idrid_164_bad_blur_dark.jpg'));
  console.log('fixtures written to', __dirname);
})();
