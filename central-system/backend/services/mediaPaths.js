'use strict';


const fs = require('fs');
const path = require('path');

// MEDIA_ROOT overrides the default so tests can write to a scratch directory.
const MEDIA_ROOT = process.env.MEDIA_ROOT
  ? path.resolve(process.env.MEDIA_ROOT)
  : path.resolve(__dirname, '..', 'media');
const CASES_ROOT = path.join(MEDIA_ROOT, 'cases');

/** Absolute directory holding one case's media. Created if absent. */
function caseDir(caseId) {
  const dir = path.join(CASES_ROOT, caseId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}


function originalPath(caseId, ext = '.jpg') {
  return path.join(caseDir(caseId), `original${ext}`);
}
function originalUrl(caseId, ext = '.jpg') {
  return `/media/cases/${caseId}/original${ext}`;
}

/** Grad-CAM overlay produced by the grading pipeline. */
function gradcamPath(caseId) {
  return path.join(caseDir(caseId), 'gradcam.png');
}
function gradcamUrl(caseId) {
  return `/media/cases/${caseId}/gradcam.png`;
}


function toPublicUrl(absPath) {
  if (!absPath) return null;
  const rel = path.relative(MEDIA_ROOT, path.resolve(absPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `/media/${rel.split(path.sep).join('/')}`;
}

module.exports = {
  MEDIA_ROOT, CASES_ROOT,
  caseDir, originalPath, originalUrl, gradcamPath, gradcamUrl, toPublicUrl,
};
