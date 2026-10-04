'use strict';


function fromMatlab(v) {
  if (Array.isArray(v) && v.length === 0) return null;
  return v ?? null;
}

function fromMatlabDeep(v) {
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return v.map(fromMatlabDeep);
  }
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = fromMatlabDeep(val);
    return out;
  }
  return v === undefined ? null : v;
}

module.exports = { fromMatlab, fromMatlabDeep };
