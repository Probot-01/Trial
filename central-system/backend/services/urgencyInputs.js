'use strict';


const INPUT_ORDER = ['patientAge', 'yearsDiabetic', 'hba1c'];

const INPUT_LABELS = {
  patientAge: 'age',
  yearsDiabetic: 'years diabetic',
  hba1c: 'HbA1c',
};


function assumedInputs(urgencyInputs) {
  const p = urgencyInputs && typeof urgencyInputs === 'object' ? urgencyInputs.provenance : null;
  if (!p || typeof p !== 'object') return null;
  const out = [];
  for (const key of INPUT_ORDER) {
    const v = p[key];
    if (typeof v !== 'string') continue;

    if (v.trim().toLowerCase() !== 'measured') out.push(key);
  }
  return out;
}

/** assumedInputs() as a human phrase, e.g. "HbA1c and years diabetic". */
function assumedInputsText(names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const labels = names.map((n) => INPUT_LABELS[n] || n);
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

module.exports = { INPUT_ORDER, INPUT_LABELS, assumedInputs, assumedInputsText };
