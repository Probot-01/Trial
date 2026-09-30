import React from 'react';
import { useTranslation } from 'react-i18next';
import { qualityReasonMessages } from '../../api/mockData';
import { USE_MOCK_DATA } from '../../config';
import { InfoModalButton } from '../shared/InfoModalButton';

const QUALITY_INFO_ROWS = [
  { term: 'QUALITY PASS / BORDERLINE / FAIL', text: 'PASS means the image is good enough to grade as-is. BORDERLINE means no single problem is bad enough to reject it, but overall quality is on the low side — it will still be graded, with extra image enhancement applied centrally. FAIL means retake: the image is not usable.' },
  { term: 'QUALITY SCORE', text: 'One combined number (0–100%) summarising focus, lighting and framing together. Below 70% is why an otherwise-passing image gets marked borderline.' },
  { term: 'FOCUS', text: 'How sharp the image is. A low score usually means camera shake or the lens not focused on the retina.' },
  { term: 'ILLUMINATION', text: 'How well-lit the retina is. Too dark or too bright both hurt grading.' },
  { term: 'COVERAGE', text: 'How much of the frame the retina itself fills. Too little means the camera was too far away or poorly aligned.' },
  { term: 'RETAKE LIMIT / BEST EFFORT', text: 'After several failed retakes for the same patient today, you can mark the image "best effort" and proceed anyway rather than retaking indefinitely — the case is still sent, flagged so the ophthalmologist knows it was a difficult capture.' },
];

// Design doc §10.2: after this many failed attempts today, offer "proceed as
// ungradable" instead of an infinite retry loop. Matches the mobile app's own
// POLICY.maxRetakesBeforeBestEffort, so the two front-ends agree on the count.
const MAX_RETAKES_BEFORE_BEST_EFFORT = 3;

export const QualityResultPanel = ({ result, onRetake, onAccept, onBestEffort }) => {
  const { t } = useTranslation();
  const isPass       = result.qualityStatus === 'pass';
  const isRetake     = result.qualityStatus === 'retake';
  const isBorderline = result.qualityStatus === 'borderline';

  // Only what the gate actually reported. POST /captures returns a status and
  // a reason (api-contracts.md), not a score or per-metric numbers; when those
  // are absent their cards are left out rather than filled with stand-ins.
  const qualityScore = result.qualityScore != null ? Math.round(result.qualityScore * 100) : null;
  const metrics      = result.metrics || result.imageQuality?.metrics || null;

  // Status configuration matching reference image 2
  const statusCfg = isPass
    ? {
        icon: '✓',
        title: 'Quality pass',
        sub: 'image meets diagnostic threshold',
        type: 'pass',
      }
    : isRetake
    ? {
        icon: '✕',
        title: 'Quality fail',
        sub: 'image below diagnostic threshold',
        type: 'fail',
      }
    : {
        icon: '⚠',
        title: 'Borderline quality',
        sub: 'image meets partial diagnostic criteria',
        type: 'borderline',
      };

  // Metric definitions matching reference layout. Only metrics with a real
  // value are shown, and "lowest" is computed from them, not fixed.
  const metricList = metrics ? [
    { id: 'focus',        label: 'FOCUS',        value: metrics.focusScore },
    { id: 'illumination', label: 'ILLUMINATION', value: metrics.illuminationScore },
    { id: 'contrast',     label: 'CONTRAST',     value: metrics.contrastScore },
    { id: 'coverage',     label: 'COVERAGE',     value: metrics.retinalCoverageScore },
  ].filter(m => typeof m.value === 'number') : [];
  const lowestValue = metricList.length > 1 ? Math.min(...metricList.map(m => m.value)) : null;
  metricList.forEach(m => { m.isLowest = m.value === lowestValue; });

  // retakeCount counts PRIOR failed attempts today, before this one; this
  // attempt itself also failed (isRetake), so it counts as +1.
  const failedAttempts = (result.retakeCount || 0) + (isRetake ? 1 : 0);
  const bestEffortAvailable = isRetake && !USE_MOCK_DATA
    && failedAttempts >= MAX_RETAKES_BEFORE_BEST_EFFORT && typeof onBestEffort === 'function';

  return (
    <div className="qr-panel">

      {/* ── 1. Status Hero Banner (Green card in reference) ── */}
      <div className={`qrp-hero qrp-hero--${statusCfg.type}`}>
        <div className="qrp-hero__icon-box">
          <span className="qrp-hero__icon">{statusCfg.icon}</span>
        </div>
        <div className="qrp-hero__text">
          <div className="qrp-hero__title u-flex u-items-center">
            {statusCfg.title}
            <InfoModalButton title="QUALITY CHECK" rows={QUALITY_INFO_ROWS} />
          </div>
          <div className="qrp-hero__sub">{statusCfg.sub}</div>
        </div>
      </div>

      {/* Which engine produced this verdict is still recorded on every capture
          (standing rule: no silent engine fallback) and is fully visible to
          reviewers on the central admin side (ProvenancePanel). A PHC
          technician is not an engineer and doesn't need "MATLAB" or a script
          filename during a normal capture -- but a FALLBACK engine (a backup
          system standing in for the reference gate) is exactly the kind of
          thing they should be told about in plain language, since it changes
          how much to trust the verdict in front of them. So: silent when
          normal, loud in plain words when it isn't. */}
      {(() => {
        const engine = result.qualityGateEngine;
        const isFallback = !!engine && engine.fallback;
        if (USE_MOCK_DATA || !isFallback) return null;
        return (
          <div
            className="qrp-card"
            data-testid="quality-gate-engine"
            style={{
              display: 'flex', flexDirection: 'column', gap: 4,
              border: '2px solid var(--c-warning, #D4860A)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-warning, #D4860A)' }}>
              ⚠ THIS CHECK RAN ON A BACKUP SYSTEM
            </div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>
              The usual quality check was unavailable, so a backup one checked this image instead.
              Treat this result with a little more care than usual.
            </div>
          </div>
        );
      })()}

      {/* ── 2. Quality Score Card (only when the gate reported one) ── */}
      {qualityScore != null && (
      <div className="qrp-card qrp-score-card">
        <div className="qrp-card__header-row">
          <span className="qrp-label">QUALITY SCORE</span>
          <span className="qrp-score-num">{qualityScore}%</span>
        </div>
        <div className="qrp-progress-track">
          <div
            className="qrp-progress-fill qrp-progress-fill--green"
            style={{ width: `${qualityScore}%` }}
          />
        </div>
      </div>
      )}

      {/* ── 3. 2x2 Metrics Grid (only the metrics the gate reported) ── */}
      {metricList.length > 0 && <div className="qrp-metrics-grid">
        {metricList.map(m => {
          const pct = Math.round(m.value * 100);
          return (
            <div className="qrp-card qrp-metric-card" key={m.id}>
              <div className="qrp-card__header-row">
                <span className="qrp-label">
                  {m.label}
                  {m.isLowest && (
                    <span className="qrp-lowest-tag"> = lowest</span>
                  )}
                </span>
                <span className="qrp-metric-num">{pct}%</span>
              </div>
              <div className="qrp-progress-track">
                <div
                  className={`qrp-progress-fill ${m.isLowest ? 'qrp-progress-fill--amber' : 'qrp-progress-fill--green'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>}

      {/* Issues if any */}
      {result.issues && result.issues.length > 0 && !isPass && (
        <div className="qrp-card qrp-issues-card">
          <span className="qrp-label" style={{ color: 'var(--c-warning)' }}>
            DETECTED ISSUES
          </span>
          <div className="qrp-issue-tags">
            {result.issues.map((issue, i) => (
              <span className="qrp-issue-chip" key={i}>
                {qualityReasonMessages[issue] || issue.replace(/_/g, ' ').toUpperCase()}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Action Row: Retake & Accept Buttons ── */}
      {isRetake ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
          <div style={{
            padding: '12px 14px',
            background: 'rgba(230, 20, 20, 0.1)',
            border: '2px solid var(--c-crimson)',
            boxShadow: '2px 2px 0px #000',
          }}>
            <div style={{ color: 'var(--c-crimson)', fontWeight: 800, fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
              ✕ INSTANT RETAKE ADVISORY
            </div>
            <div style={{ marginTop: '6px', fontSize: '12px', lineHeight: 1.4, color: 'var(--text-h)' }}>
              {result.issues && result.issues.length > 0 
                ? result.issues.map(iss => qualityReasonMessages[iss] || iss).join('. ')
                : 'Image is blurry and falls below diagnostic threshold. Hold the camera or lens steady on the patient’s eye and retake.'}
            </div>
          </div>

          <button
            type="button"
            className="btn btn--danger btn--lg"
            onClick={onRetake}
            style={{ width: '100%', justifyContent: 'center', fontWeight: 800, padding: '12px', fontSize: '13px' }}
          >
            <span style={{ marginRight: '6px' }}>↺</span> RETAKE IMAGE (RESOLVE DEFECT)
          </button>

          {/* §10.2: after MAX_RETAKES_BEFORE_BEST_EFFORT failed attempts, an
              honest way forward that is not "retake forever" or "silently drop
              the patient". Unlike the mock-only override below, this does NOT
              pretend the image passed -- qualityStatus stays 'retake', the
              capture is still queued for real (POST .../best-effort), and it
              carries an explicit flag central can hold at mandatory review. */}
          {bestEffortAvailable && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ fontSize: '11px', color: 'var(--c-crimson)', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                {failedAttempts} FAILED ATTEMPTS FOR THIS PATIENT TODAY
              </div>
              <button
                type="button"
                className="btn btn--outline"
                onClick={onBestEffort}
                style={{ width: '100%', justifyContent: 'center', fontWeight: 700, padding: '10px', fontSize: '12px' }}
              >
                PROCEED AS UNGRADABLE (BEST EFFORT) →
              </button>
              <div style={{ fontSize: '11px', opacity: 0.75, lineHeight: 1.4 }}>
                Sends this image as-is. It is flagged for mandatory ophthalmologist review — it does not report as a pass.
              </div>
            </div>
          )}

          {/* Demo only. In live mode a plain 'retake' capture (not yet at the
              best-effort threshold above) is never queued for upload. */}
          {USE_MOCK_DATA && (
            <button
              type="button"
              className="btn btn--outline"
              onClick={onAccept}
              style={{ opacity: 0.5, fontSize: '10px', padding: '6px', borderStyle: 'dashed' }}
            >
              OVERRIDE QUALITY GATE & PROCEED ANYWAY
            </button>
          )}
        </div>
      ) : (
        <div className="qrp-actions">
          <button
            type="button"
            className="btn btn--outline qrp-retake-btn"
            onClick={onRetake}
          >
            <span className="qrp-btn-icon">↺</span> RETAKE
          </button>
          <button
            type="button"
            className="btn btn--success qrp-accept-btn"
            onClick={onAccept}
          >
            ACCEPT & CONTINUE →
          </button>
        </div>
      )}

    </div>
  );
};
