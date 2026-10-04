'use strict';



const ENGINES = new Set(['matlab', 'python', 'js-fallback']);

const QUALITY_GATE_ENGINES = new Set([...ENGINES, 'js-device']);
const DETAIL_MAX = 300;

function engineEntry(engine, detail, fallback = false) {
  return { engine, fallback: !!fallback, detail: detail ?? null };
}



function normaliseEngineEntry(e, allowed = ENGINES) {
  if (!e || typeof e !== 'object' || !allowed.has(e.engine)) return null;
  return engineEntry(e.engine,
    typeof e.detail === 'string' ? e.detail.slice(0, DETAIL_MAX) : null,
    e.fallback === true);
}

const SEGMENTATION_MODELS = ['vessel', 'localization', 'hardExudate', 'redLesion'];


function toContractShape(gradingProvenance, qualityGateEngine) {
  const g = gradingProvenance && typeof gradingProvenance === 'object' ? gradingProvenance : {};
  let segmentation = null;
  if (g.segmentation && typeof g.segmentation === 'object') {
    segmentation = {};
    for (const m of SEGMENTATION_MODELS) segmentation[m] = normaliseEngineEntry(g.segmentation[m]);
  }
  return {
    classifier: normaliseEngineEntry(g.classifier),
    segmentation,
    ruleEngine: normaliseEngineEntry(g.ruleEngine),
    qualityGate: normaliseEngineEntry(qualityGateEngine, QUALITY_GATE_ENGINES),
  };
}

module.exports = {
  ENGINES, QUALITY_GATE_ENGINES, SEGMENTATION_MODELS, engineEntry, normaliseEngineEntry, toContractShape,
};
