'use strict';


function totalOf(arr) {
  if (!Array.isArray(arr) || arr.length !== 4) return null;
  if (!arr.every((v) => Number.isFinite(v))) return null;
  return arr.reduce((a, b) => a + b, 0);
}


function pickTotal(stored, quadrants) {
  const fromQuadrants = totalOf(quadrants);
  return fromQuadrants !== null ? fromQuadrants : (Number.isFinite(stored) ? stored : null);
}

function toContractShape(stored) {
  if (!stored || typeof stored !== 'object') return null;

  const ma = pickTotal(stored.maTotal, stored.ma);
  const he = pickTotal(stored.heTotal, stored.he);
  const bright = pickTotal(stored.brightTotal, stored.bright);
  const red = pickTotal(stored.redTotal, stored.red);

  return {
    microaneurysms: ma,
    hemorrhages: he,

    hardExudates: Number.isFinite(stored.hardExudateTotal)
      ? stored.hardExudateTotal : bright,
    softExudates: null,


    detail: {
      redTotal: red,
      redPerQuadrant: Array.isArray(stored.red) ? stored.red : null,
      brightPerQuadrant: Array.isArray(stored.bright) ? stored.bright : null,
      minAreaPx: Number.isFinite(stored.minAreaPx) ? stored.minAreaPx : null,
      procedure: typeof stored.procedure === 'string' ? stored.procedure : null,
    },
  };
}

module.exports = { toContractShape };
