#!/usr/bin/env node
'use strict';



const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pool = require(path.join(ROOT, 'central-system', 'backend', 'db', 'pgClient'));

const mediaCrypto = require(path.join(ROOT, 'central-system', 'backend', 'services', 'mediaCrypto'));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] || fallback);
}
const has = (name) => process.argv.includes(name);

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(mediaCrypto.readFile(file)).digest('hex');
  } catch {
    return null;
  }
}

async function list() {
  const { rows } = await pool.query(`
    SELECT label_source, label_grade, count(*)::int AS n,
           count(*) FILTER (WHERE consent_given_at IS NOT NULL)::int AS consented,
           count(*) FILTER (WHERE exported_at IS NOT NULL)::int AS exported
      FROM dataset_labels
     GROUP BY label_source, label_grade
     ORDER BY label_source, label_grade
  `);
  if (!rows.length) {
    console.log('no labels yet — dataset_labels is empty. It fills as ophthalmologists review cases.');
    return;
  }
  console.table(rows);
  const { rows: t } = await pool.query(`
    SELECT count(*)::int AS labels,
           count(DISTINCT case_id)::int AS cases,
           count(DISTINCT image_sha256)::int AS distinct_images,
           count(*) FILTER (WHERE consent_given_at IS NULL)::int AS without_consent
      FROM dataset_labels
  `);
  console.table(t);
}

async function main() {
  if (has('--list')) { await list(); await pool.end(); return 0; }

  const includeUnconsented = has('--include-unconsented');
  const copyImages = has('--copy-images');
  const dryRun = has('--dry-run');
  const batch = `batch-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(arg('--out', path.join(ROOT, 'exports', batch)));

  // Newest label per case (rule 2), optionally only what has never been
  // exported (the default).
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (case_id)
           label_id, case_id, label_grade, label_source, model_grade,
           conformal_tier, image_path, image_sha256, eye_laterality,
           consent_given_at, labelled_at, exported_at
      FROM dataset_labels
     ORDER BY case_id, labelled_at DESC
  `);

  const skipped = { unconsented: 0, alreadyExported: 0, missingFile: 0, hashMismatch: 0, noHash: 0 };
  const bySha = new Map();
  const disagreements = [];

  for (const r of rows) {
    if (!has('--all') && r.exported_at) { skipped.alreadyExported += 1; continue; }
    if (!r.consent_given_at && !includeUnconsented) { skipped.unconsented += 1; continue; }
    if (!r.image_sha256) { skipped.noHash += 1; continue; }
    if (!r.image_path || !fs.existsSync(r.image_path)) { skipped.missingFile += 1; continue; }
    if (sha256(r.image_path) !== r.image_sha256) { skipped.hashMismatch += 1; continue; }

    const seen = bySha.get(r.image_sha256);
    if (seen) {
      // Rule 3: same bytes, already have an example. Report a contradiction.
      if (seen.label_grade !== r.label_grade) {
        disagreements.push({
          sha: r.image_sha256.slice(0, 12),
          kept: `${seen.case_id} -> ${seen.label_grade}`,
          dropped: `${r.case_id} -> ${r.label_grade}`
        });
      }
      continue;
    }
    bySha.set(r.image_sha256, r);
  }

  const examples = [...bySha.values()];
  const dist = {};
  for (const e of examples) dist[e.label_grade] = (dist[e.label_grade] || 0) + 1;

  console.log(`\ncandidate labels (newest per case): ${rows.length}`);
  console.log(`exportable examples:                ${examples.length}`);
  console.log('skipped:', skipped);
  console.log('grade distribution:', dist);
  if (disagreements.length) {
    console.log(`\n${disagreements.length} identical image(s) labelled differently by different reviews:`);
    console.table(disagreements);
  }
  if (dryRun) { console.log('\n--dry-run: nothing written'); await pool.end(); return 0; }
  if (!examples.length) { console.log('\nnothing to export'); await pool.end(); return 0; }

  fs.mkdirSync(outDir, { recursive: true });
  if (copyImages) fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });

  // Manifest: no patient identifiers (rule 4).
  const header = 'image,label,label_source,model_grade,conformal_tier,eye,case_id,labelled_at,sha256\n';
  const lines = examples.map((e) => {
    const name = `${e.image_sha256.slice(0, 16)}${path.extname(e.image_path) || '.jpg'}`;
    // Decrypted on export: the training pipeline reads plain image files.
    if (copyImages) fs.writeFileSync(path.join(outDir, 'images', name), mediaCrypto.readFile(e.image_path));
    const rel = copyImages ? `images/${name}` : e.image_path;
    return [rel, e.label_grade, e.label_source, e.model_grade ?? '', e.conformal_tier || '',
      e.eye_laterality || '', e.case_id, new Date(e.labelled_at).toISOString(),
      e.image_sha256].join(',');
  });
  fs.writeFileSync(path.join(outDir, 'labels.csv'), header + lines.join('\n') + '\n');

  fs.writeFileSync(path.join(outDir, 'DATASET_CARD.md'), card({
    batch, examples, dist, skipped, disagreements, includeUnconsented, copyImages,
  }));

  if (!has('--all')) {
    await pool.query(
      'UPDATE dataset_labels SET exported_at = now(), export_batch = $1 WHERE label_id = ANY($2)',
      [batch, examples.map((e) => e.label_id)]);
  }

  console.log(`\nwrote ${examples.length} examples to ${outDir}`);
  console.log(copyImages ? '  images copied into images/' : '  manifest references images in place (--copy-images to materialise)');
  await pool.end();
  return 0;
}

function card({ batch, examples, dist, skipped, disagreements, includeUnconsented, copyImages }) {
  const grades = [0, 1, 2, 3, 4].map((g) => `| ${g} | ${dist[g] || 0} |`).join('\n');
  return `# Review-labelled corpus — ${batch}

${examples.length} examples, one per distinct image, labelled by ophthalmologists
while reviewing real screening cases. Generated by \`scripts/exportTrainingSet.js\`.

| grade | examples |
|---|---|
${grades}

| label source | n |
|---|---|
| confirm (reviewer accepted the model's grade) | ${examples.filter((e) => e.label_source === 'confirm').length} |
| override (reviewer replaced it) | ${examples.filter((e) => e.label_source === 'override').length} |

## Read this before training on it

**This is not a random sample of screening.** Tier A cases are auto-cleared and
never reach a reviewer, so every example here is a case the system was unsure
about (Tier B or C) or one flagged for another reason. The ordinary negatives
that dominate real screening are under-represented by construction. Fine-tuning
on this corpus alone will shift a model toward the hard tail; mix it with the
original training distribution rather than replacing it.

**A confirm is a weaker label than an override.** It means the reviewer did not
disagree with the grade they were shown, having seen that grade first. Anchoring
is real: that is not the same as an independent reading. \`label_source\` is in
the manifest so the two can be weighted differently.

**Grade 4 is rare here** for the same reason it is rare everywhere in this
project, and a handful of examples cannot fix a recall problem on that class.

## Provenance and safeguards

- Consent: ${includeUnconsented
      ? '**INCLUDED WITHOUT CONSENT** (`--include-unconsented`). Rows whose patient had not consented at labelling time are present. Do not distribute this corpus.'
      : 'every example had patient consent recorded at labelling time.'}
- Excluded: ${skipped.unconsented} without consent, ${skipped.missingFile} image file missing, ${skipped.hashMismatch} image bytes changed since labelling, ${skipped.noHash} unverifiable, ${skipped.alreadyExported} exported in an earlier batch.
- Deduplicated by SHA-256. ${disagreements.length} identical image(s) carried conflicting labels; the newest review was kept and the conflict is listed in the export log.
- No patient identifiers: the manifest carries case ids and labels only${copyImages ? ', and image files are named by content hash' : ''}.
- Labels are one row per review in \`dataset_labels\`; this export took the newest per case.

Generated ${new Date().toISOString()}.
`;
}

main().catch((e) => { console.error(e); process.exit(1); });
