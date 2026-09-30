'use strict';

/**
 * fetch-models.js -- get the 1.5 GB of git-ignored model weights onto a fresh
 * clone, and confirm they're the exact bytes the demo was recorded with
 * (docs/RELEASE.md P0-1: "nobody has to be told twice").
 *
 * The weights themselves are never in git (see .gitignore) -- only their
 * SHA-256 list is, at central-system/backend/ml-pipeline/models.sha256
 * (extracted from docs/RELEASE.md's "Checksums" section, same 27 files).
 *
 * Two modes:
 *
 *   node scripts/fetch-models.js --verify
 *     Check whatever is already on disk against models.sha256. Exits
 *     non-zero and lists every MISSING/MISMATCH file. Safe to run any time,
 *     needs no network and no URL -- this is what CI or a teammate should
 *     run right after cloning to know if they're blocked.
 *
 *   node scripts/fetch-models.js --url <archive-url> [--verify]
 *     Download the archive (whoever holds MODELS_ARCHIVE_URL -- a Drive
 *     direct-download link or a GitHub Release asset), extract it into
 *     central-system/backend/ml-pipeline/, then run the same verification.
 *     Also reads the URL from the MODELS_ARCHIVE_URL env var so it doesn't
 *     have to be retyped. Extraction shells out to `tar` (bsdtar ships with
 *     Windows 10/11 and handles .zip; on Linux/Mac, GNU tar handles .tar.gz
 *     natively and most distros' tar also links bsdtar's zip support -- if
 *     yours doesn't, extract the archive by hand into ml-pipeline/ and
 *     rerun with --verify).
 *
 * Nothing here touches, retrains or re-exports a model file (CLAUDE.md) --
 * this only moves bytes and checks hashes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');

const ML_DIR = path.resolve(__dirname, '..', 'central-system', 'backend', 'ml-pipeline');
const CHECKSUM_FILE = path.join(ML_DIR, 'models.sha256');

function parseArgs(argv) {
  const out = { verify: false, url: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--verify') out.verify = true;
    else if (argv[i] === '--url') out.url = argv[++i];
  }
  return out;
}

/** Reads models.sha256 -> [{ hash, relPath }], same format `sha256sum -c` reads. */
function loadChecksums() {
  if (!fs.existsSync(CHECKSUM_FILE)) {
    throw new Error(`Checksum list not found: ${CHECKSUM_FILE}\n` +
      "This should be tracked in git (it's just hashes, not the weights) -- " +
      're-run from a clean clone or regenerate it from docs/RELEASE.md.');
  }
  return fs.readFileSync(CHECKSUM_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // sha256sum format: "<64-hex-hash>  <path>" (two spaces, or one -- be lenient)
      const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
      if (!m) throw new Error(`Unrecognised line in models.sha256: ${line}`);
      return { hash: m[1].toLowerCase(), relPath: m[2] };
    });
}

function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verify() {
  const entries = loadChecksums();
  const missing = [];
  const mismatched = [];
  let ok = 0;

  for (const { hash, relPath } of entries) {
    const absPath = path.join(ML_DIR, relPath);
    if (!fs.existsSync(absPath)) { missing.push(relPath); continue; }
    const actual = await sha256File(absPath);
    if (actual !== hash) { mismatched.push({ relPath, expected: hash, actual }); continue; }
    ok += 1;
  }

  console.log(`\nmodels.sha256: ${entries.length} files listed, ${ok} verified OK.`);
  if (missing.length) {
    console.log(`\nMISSING (${missing.length}) -- not on disk at all:`);
    missing.forEach((p) => console.log(`  ${p}`));
  }
  if (mismatched.length) {
    console.log(`\nMISMATCH (${mismatched.length}) -- present but different bytes than the demo recording:`);
    mismatched.forEach(({ relPath, expected, actual }) =>
      console.log(`  ${relPath}\n    expected ${expected}\n    actual   ${actual}`));
  }
  if (!missing.length && !mismatched.length) {
    console.log('All model weights present and byte-identical to docs/RELEASE.md.');
  }
  return missing.length === 0 && mismatched.length === 0;
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(destPath);
    console.log(`Downloading ${url} ...`);
    const req = client.get(url, (res) => {
      // Follow one redirect (Drive/Release asset links commonly 302 once).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        return download(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed: HTTP ${res.statusCode} from ${url}`));
      }
      const total = Number(res.headers['content-length']) || null;
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total) process.stdout.write(`\r  ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); process.stdout.write('\n'); resolve(); });
    });
    req.on('error', reject);
  });
}

function extract(archivePath, destDir) {
  console.log(`Extracting ${archivePath} -> ${destDir}`);
  // bsdtar (Windows 10/11's built-in tar.exe) and GNU tar both take this form
  // for .zip/.tar.gz alike; -C sets the extraction root.
  execFileSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
}

async function main() {
  const { verify: verifyOnly, url: cliUrl } = parseArgs(process.argv.slice(2));
  const url = cliUrl || process.env.MODELS_ARCHIVE_URL || null;

  if (url) {
    fs.mkdirSync(ML_DIR, { recursive: true });
    const archivePath = path.join(require('os').tmpdir(), `netrasetu-models-${Date.now()}${path.extname(new URL(url).pathname) || '.zip'}`);
    await download(url, archivePath);
    extract(archivePath, ML_DIR);
    fs.unlinkSync(archivePath);
    console.log('Extraction done.');
  } else if (!verifyOnly) {
    console.log(
      'No --url given and no MODELS_ARCHIVE_URL set -- nothing to download.\n' +
      'Running --verify against whatever is already on disk instead.\n' +
      "(Get the archive link from whoever holds it, then: node scripts/fetch-models.js --url <link>)\n"
    );
  }

  const ok = await verify();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('fetch-models failed:', err.message);
  process.exit(1);
});
