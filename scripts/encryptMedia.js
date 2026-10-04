'use strict';



const fs = require('fs');
const path = require('path');

const backendDir = path.resolve(__dirname, '..', 'central-system', 'backend');
require(path.join(backendDir, 'loadEnv'));
const mediaCrypto = require(path.join(backendDir, 'services', 'mediaCrypto'));
const { MEDIA_ROOT } = require(path.join(backendDir, 'services', 'mediaPaths'));

const DRY_RUN = process.argv.includes('--dry-run');
const MODEL_EXT = new Set(['.mat', '.pt', '.pth', '.onnx', '.ckpt', '.h5', '.pkl', '.safetensors']);

if (!mediaCrypto.enabled()) {
  console.error('[encryptMedia] MEDIA_ENCRYPTION_KEY is not set in central-system/backend/.env; nothing to do.');
  process.exit(1);
}

const counts = { encrypted: 0, already: 0, skippedModel: 0 };

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (!entry.isFile()) continue;
    if (MODEL_EXT.has(path.extname(entry.name).toLowerCase())) { counts.skippedModel += 1; continue; }
    const head = Buffer.alloc(8);
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    if (mediaCrypto.isEncrypted(Buffer.concat([head, Buffer.alloc(28)]))) { counts.already += 1; continue; }
    if (DRY_RUN) console.log(`  would encrypt ${path.relative(MEDIA_ROOT, p)}`);
    else mediaCrypto.encryptFileInPlace(p);
    counts.encrypted += 1;
  }
}

walk(MEDIA_ROOT);
console.log(`[encryptMedia] ${DRY_RUN ? 'would encrypt' : 'encrypted'} ${counts.encrypted} file(s); ` +
  `${counts.already} already encrypted; ${counts.skippedModel} model file(s) skipped. Root: ${MEDIA_ROOT}`);
