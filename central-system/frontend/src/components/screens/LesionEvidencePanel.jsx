import React from 'react';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const QUADS = ['SUP-TEMP', 'INF-TEMP', 'SUP-NASAL', 'INF-NASAL'];

const CAVEAT_MARKERS = [
  'PROVISIONAL', 'never been measured', 'should be refitted', 'was fitted on',
  'This grade may be an under-call', 'not the literature',
];
function splitCaveat(text) {
  if (!text) return { finding: text, caveat: null };
  const sentences = text.match(/[^.]+\.(\s+|$)/g) || [text];
  const last = sentences[sentences.length - 1] || '';
  if (sentences.length > 1 && CAVEAT_MARKERS.some((m) => last.includes(m))) {
    return {
      finding: sentences.slice(0, -1).join('').trim(),
      caveat: last.trim(),
    };
  }
  return { finding: text, caveat: null };
}

const Quadrants = ({ counts }) => (
  Array.isArray(counts) && counts.length === 4 ? (
    <div className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.6, marginTop: 4 }}>
      {counts.map((n, i) => `${QUADS[i]} ${n}`).join(' · ')}
    </div>
  ) : null
);

const Family = ({ label, color, total, children, footnote }) => (
  <div className="lesion-item" style={{ display: 'block', padding: 'var(--sp-4)', border: 'var(--border)' }}>
    <div className="u-flex u-justify-between u-items-center">
      <span className="t-label" style={{ color }}>● {label}</span>
      <span className="t-mono" style={{ fontWeight: 700, fontSize: 'var(--fs-h3)' }}>
        {isNum(total) ? total : '—'}
      </span>
    </div>
    {children}
    {footnote && (
      <div className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.55, marginTop: 6 }}>{footnote}</div>
    )}
  </div>
);

export const LesionEvidencePanel = ({ caseData }) => {
  const c = caseData;
  const lc = c.lesionCounts;
  const detail = lc?.detail || {};

  const hasSplit = isNum(lc?.microaneurysms) && isNum(lc?.hemorrhages);
  const redTotal = isNum(detail.redTotal)
    ? detail.redTotal
    : (hasSplit ? lc.microaneurysms + lc.hemorrhages : null);

  return (
    <div className="lesion-evidence" style={{ border: 'var(--border)', padding: 'var(--sp-6)' }}>
      <h3 className="t-h3 u-mb-4">LESION EVIDENCE</h3>

      {!lc ? (
        <p className="t-mono" style={{ opacity: 0.6 }}>
          LESION SEGMENTATION DID NOT RUN FOR THIS CASE — no lesion counts are available, and none are shown as zero.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
          <Family label="RED LESIONS" color="var(--c-crimson)" total={redTotal}>
            {hasSplit && (
              <div className="u-flex u-gap-6 u-mt-2" style={{ flexWrap: 'wrap' }}>
                <span className="t-mono">MICROANEURYSMS <strong>{lc.microaneurysms}</strong></span>
                <span className="t-mono">HAEMORRHAGES <strong>{lc.hemorrhages}</strong></span>
              </div>
            )}
            <Quadrants counts={detail.redPerQuadrant} />
          </Family>

          <Family
            label="BRIGHT LESIONS (HARD EXUDATES)"
            color="var(--c-warning)"
            total={lc.hardExudates}
            footnote="Cotton-wool spots (soft exudates) are not detected by this system."
          >
            <Quadrants counts={detail.brightPerQuadrant} />
          </Family>
        </div>
      )}

      {/* NV Suspicion */}
      <div className="u-mt-4" style={{ borderTop: 'var(--border)', paddingTop: 'var(--sp-4)' }}>
        <div className="u-flex u-justify-between u-items-center">
          <span className="t-label">NV SUSPICION SCORE</span>
          {c.nvSuspicionScore !== null && c.nvSuspicionScore !== undefined ? (
            <span className={`badge ${c.nvSuspicionScore > 0.5 ? 'badge--fail' : c.nvSuspicionScore > 0.3 ? 'badge--warning' : 'badge--pass'}`}>
              {(c.nvSuspicionScore * 100).toFixed(0)}% — {c.nvSuspicionScore > 0.5 ? 'HIGH' : c.nvSuspicionScore > 0.3 ? 'MODERATE' : 'LOW'}
            </span>
          ) : (
            <span className="t-mono" style={{ opacity: 0.3 }}>NOT YET AVAILABLE</span>
          )}
        </div>
      </div>

      { }
      {c.evidenceSummaryText && (() => {
        const { finding, caveat } = splitCaveat(c.evidenceSummaryText);
        return (
          <div className="u-mt-4" style={{ borderTop: 'var(--border)', paddingTop: 'var(--sp-4)' }}>
            <span className="t-label" style={{ opacity: 0.5 }}>AI EVIDENCE SUMMARY</span>
            <p className="t-body" style={{ marginTop: 'var(--sp-2)', fontSize: 'var(--fs-small)', lineHeight: 1.6 }}>
              {finding}
            </p>
            {caveat && (
              <p className="t-mono" style={{ marginTop: 'var(--sp-2)', fontSize: 'var(--fs-tiny)', opacity: 0.55 }}>
                ⓘ Methodology note: {caveat}
              </p>
            )}
          </div>
        );
      })()}
    </div>
  );
};
