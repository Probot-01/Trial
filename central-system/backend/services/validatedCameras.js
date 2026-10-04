
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'validatedCameras.json');

let cache = null;

function load() {
  if (cache) return cache;

  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    cache = {
      enforce: true,
      entries: [],
      error: `validatedCameras.json could not be read (${err.code}) — `
        + 'treating every camera as UNVALIDATED',
    };
    console.warn(`[validatedCameras] ${cache.error}`);
    return cache;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    cache = {
      enforce: true,
      entries: [],
      error: `validatedCameras.json is not valid JSON (${err.message}) — `
        + 'treating every camera as UNVALIDATED',
    };
    console.error(`[validatedCameras] ${cache.error}`);
    return cache;
  }

  const enforce = parsed.enforce !== false;
  const entries = Array.isArray(parsed.validated) ? parsed.validated : [];

  if (!enforce) {
    console.warn('[validatedCameras] enforce=false — the unvalidated-camera '
      + 'Tier A floor is DISABLED. An unvalidated camera can auto-clear.');
  }

  cache = { enforce, entries, error: null };
  return cache;
}

function reload() {
  cache = null;
  return load();
}


function isValidatedCamera(phcId, cameraDeviceId) {
  const { entries } = load();
  const cam = norm(cameraDeviceId);
  if (!cam) return false;

  const site = norm(phcId);
  return entries.some((e) => {
    if (norm(e.cameraDeviceId) !== cam) return false;
    const entrySite = norm(e.phcId);
    return entrySite === '*' || (entrySite !== '' && entrySite === site);
  });
}



function cameraNotValidated(phcId, cameraDeviceId) {
  if (!load().enforce) return false;
  return !isValidatedCamera(phcId, cameraDeviceId);
}

function norm(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

module.exports = {
  isValidatedCamera,
  cameraNotValidated,
  reload,
  CONFIG_PATH,
};
