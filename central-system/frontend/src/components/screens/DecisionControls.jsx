import React, { useState, useEffect, useRef } from 'react';
import { drGradeLabels, overrideReasonCategories } from '../../api/mockData';


const SMS_TEXT = {
  sent: 'SMS sent to the patient.',
  not_configured: 'SMS was NOT sent: no SMS provider is configured. The referral is in MANUAL FOLLOW-UP — someone must phone the patient.',
  dry_run: 'SMS was NOT sent: the server is in dry-run mode (message logged only).',
  failed: 'SMS FAILED to send. The referral stands and is in MANUAL FOLLOW-UP — someone must phone the patient.',
  not_referable: 'No referral: the final grade is below the referable threshold, so no message was sent.',
  already_sent: 'This case was already referred by an earlier review; no second message was sent.',
  override_without_grade: 'No message sent: an override without a corrected grade cannot be judged referable.',
  no_review_on_record: 'No message sent: no review is on record for this case.',
};

export const describeOutcome = (result) => {
  if (!result) return [];
  const lines = [];
  lines.push(result.referralId ? `Referral created (${String(result.referralId).slice(0, 8).toUpperCase()}).` : 'No referral was raised.');
  if (result.smsStatus) lines.push(SMS_TEXT[result.smsStatus] || `SMS status: ${result.smsStatus}.`);
  return lines;
};

export const DecisionControls = ({ caseData, onSubmit, submitted, claimedBy, priorReview, reviewerName, outcome }) => {
  const [decision, setDecision] = useState(null); // 'confirm' | 'override'
  const [overrideGrade, setOverrideGrade] = useState('');
  const [overrideCategory, setOverrideCategory] = useState('');
  const [overrideText, setOverrideText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const cnn = caseData.drGradeCnn;
  const rule = caseData.drGradeRuleEngine;

  const disagree = caseData.branchAgreement === false;
  const locked = submitted || submitting || !!claimedBy;

  const effectiveDecision = disagree ? 'override' : decision;

  // Live review timer (records the real review duration).
  useEffect(() => {
    if (submitted) return undefined;
    const interval = setInterval(() => setElapsedSeconds((prev) => prev + 1), 1000);
    return () => clearInterval(interval);
  }, [submitted]);

  const problems = [];
  if (effectiveDecision === 'override') {
    if (overrideGrade === '') problems.push(disagree ? 'Choose the final grade.' : 'Choose the corrected grade.');
    if (!overrideCategory) problems.push('Choose a reason.');
    if (!disagree && overrideGrade !== '' && Number(overrideGrade) === cnn) {
      problems.push('The corrected grade equals the AI grade — use Confirm instead.');
    }
  }
  const canSubmit = !locked && !!effectiveDecision && problems.length === 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);

    const reviewData = {
      decision: effectiveDecision,
      overrideReasonCategory: effectiveDecision === 'override' ? overrideCategory : null,
      overrideReasonText: effectiveDecision === 'override' && overrideText.trim() ? overrideText.trim() : null,

      ...(effectiveDecision === 'override' ? { correctedGrade: Number(overrideGrade) } : {}),
      reviewDurationSeconds: elapsedSeconds,
    };
    try {
      await onSubmit(reviewData);
    } catch (err) {

      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const latest = useRef({});
  latest.current = { locked, disagree, canSubmit, handleSubmit, decision };
  useEffect(() => {
    if (submitted) return undefined;
    const onKey = (e) => {
      const s = latest.current;
      if (s.locked) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key === 'Enter' && e.ctrlKey && s.canSubmit) s.handleSubmit();
        return;
      }
      if ((e.key === 'c' || e.key === 'C') && !s.disagree) {
        e.preventDefault();
        setDecision('confirm');
      } else if ((e.key === 'o' || e.key === 'O') && !s.disagree) {
        e.preventDefault();
        setDecision('override');
      } else if (e.key === 'Enter' && s.canSubmit) {
        e.preventDefault();
        s.handleSubmit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submitted]);

  const timerFormatted = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
  const gradeOption = (g) => `Grade ${g} — ${drGradeLabels[g]}`;

  return (
    <div className="decision-controls" style={{ border: 'var(--border)' }}>
      <div style={{
        padding: 'var(--sp-4) var(--sp-6)', borderBottom: 'var(--border)',
        background: 'var(--c-black)', color: 'var(--c-crimson)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px',
      }}>
        <h3 className="t-h3" style={{ margin: 0, color: 'var(--c-crimson)' }}>
          CLINICAL DECISION &amp; SAFETY AUDIT
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="t-mono" data-testid="review-timer" style={{
            fontSize: '11px',
            color: elapsedSeconds < 30 ? 'var(--c-success, #25a244)' : 'var(--c-warning, #ffaa00)',
            fontWeight: 700,
          }}>
            ● REVIEW TIMER: {timerFormatted} / &lt;30s TARGET
          </span>
          <span className="badge badge--pass" style={{ fontSize: '10px' }}>
            {elapsedSeconds < 30 ? 'WITHIN TARGET' : 'EXTENDED REVIEW'}
          </span>
        </div>
      </div>

      <div style={{ padding: 'var(--sp-6)' }}>
        {submitError && (
          <div role="alert" style={{ marginBottom: 'var(--sp-4)', padding: '12px', border: '2px solid var(--c-crimson)', color: 'var(--c-crimson)', fontSize: 'var(--fs-small)' }}>
            <strong>⚠ REVIEW NOT SAVED:</strong> {submitError.message || 'The request failed.'}
            {submitError.code ? ` (${submitError.code})` : ''} Nothing was recorded; submit again once the problem is fixed.
          </div>
        )}
        {claimedBy && (
          <div role="alert" style={{ marginBottom: 'var(--sp-4)', padding: '12px', background: 'var(--c-crimson)', color: '#fff', fontSize: 'var(--fs-small)' }}>
            <strong>⚠ CASE CLAIMED:</strong> This case is currently being reviewed by {claimedBy}. Decision controls are disabled.
          </div>
        )}

        {priorReview && (
          <div style={{ marginBottom: 'var(--sp-4)', padding: '12px', border: '1px solid var(--c-warning)', background: 'rgba(255, 170, 0, 0.1)', color: 'var(--c-warning)', fontSize: 'var(--fs-small)' }}>
            <strong>⚠ PRIOR REVIEW EXISTS:</strong> This case was already reviewed by {priorReview.reviewerName} on {new Date(priorReview.reviewedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} IST.<br />
            Decision: {String(priorReview.decision).toUpperCase()} {priorReview.decision === 'override' ? `(Grade ${priorReview.correctedGrade}, Reason: ${priorReview.overrideReasonCategory})` : ''}.<br />
            Any new submission will be recorded as a correction.
          </div>
        )}

        {disagree && (
          <div role="note" style={{ marginBottom: 'var(--sp-4)', padding: '12px', border: '2px solid var(--c-crimson-dark, #7a0a18)', fontSize: 'var(--fs-small)' }}>
            <strong>⚠ BRANCHES DISAGREE</strong> — CNN says Grade {cnn ?? '—'}, the rule engine says Grade {rule ?? '—'}.
            "Confirm" is not available: you must explicitly choose the final grade below.
          </div>
        )}

        {/* Decision buttons. On a disagreement Confirm is disabled and says why. */}
        <div className="u-flex u-gap-4" style={{ marginBottom: 'var(--sp-6)' }}>
          <button
            className={`decision-btn decision-btn--confirm ${effectiveDecision === 'confirm' ? 'decision-btn--active' : ''}`}
            onClick={() => setDecision('confirm')}
            disabled={locked || disagree}
            title={disagree ? 'Unavailable: the two branches disagree — choose the final grade instead.' : undefined}
          >
            <span className="decision-btn__icon">✓</span>
            <span className="decision-btn__label">CONFIRM</span>
            <span className="decision-btn__desc">
              {disagree ? 'Unavailable — branches disagree' : `AI Grade ${cnn} (${drGradeLabels[cnn]}) is correct`}
            </span>
            {!disagree && <span className="decision-btn__shortcut">Press C</span>}
          </button>

          <button
            className={`decision-btn decision-btn--override ${effectiveDecision === 'override' ? 'decision-btn--active' : ''}`}
            onClick={() => setDecision('override')}
            disabled={locked || disagree}
          >
            <span className="decision-btn__icon">✕</span>
            <span className="decision-btn__label">{disagree ? 'RESOLVE' : 'OVERRIDE'}</span>
            <span className="decision-btn__desc">
              {disagree ? 'Choose the final grade below' : 'I disagree with the AI assessment'}
            </span>
            {!disagree && <span className="decision-btn__shortcut">Press O</span>}
          </button>
        </div>

        {/* Override / resolution form */}
        {effectiveDecision === 'override' && (
          <div className="override-form" style={{ animation: 'fade-in-up 0.3s ease-out' }}>
            {disagree && (
              <div className="u-flex u-gap-3 u-mb-4" style={{ flexWrap: 'wrap' }}>
                {cnn !== null && cnn !== undefined && (
                  <button type="button" className="btn btn--outline" disabled={locked}
                    onClick={() => setOverrideGrade(String(cnn))}>
                    USE CNN GRADE {cnn} ({drGradeLabels[cnn]})
                  </button>
                )}
                {rule !== null && rule !== undefined && (
                  <button type="button" className="btn btn--outline" disabled={locked}
                    onClick={() => setOverrideGrade(String(rule))}>
                    USE RULE-ENGINE GRADE {rule} ({drGradeLabels[rule]})
                  </button>
                )}
              </div>
            )}
            <div className="u-flex u-gap-4 u-mb-4">
              <div style={{ flex: 1 }}>
                <label className="label">{disagree ? 'FINAL GRADE (REQUIRED)' : 'CORRECTED GRADE (REQUIRED)'}</label>
                <select className="select" value={overrideGrade} disabled={locked}
                  onChange={(e) => setOverrideGrade(e.target.value)}>
                  <option value="">Select grade...</option>
                  {Object.keys(drGradeLabels).map((g) => (
                    <option key={g} value={g}>{gradeOption(g)}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label">{disagree ? 'REASON (REQUIRED)' : 'OVERRIDE REASON (REQUIRED)'}</label>
                <select className="select" value={overrideCategory} disabled={locked}
                  onChange={(e) => setOverrideCategory(e.target.value)}>
                  <option value="">Select reason...</option>
                  {overrideReasonCategories.map((cat) => (
                    <option key={cat.value} value={cat.value}>{cat.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="u-mb-4">
              <label className="label">ADDITIONAL NOTES (OPTIONAL)</label>
              <textarea className="input" rows={3} value={overrideText} disabled={locked}
                onChange={(e) => setOverrideText(e.target.value)}
                placeholder="Clinical reasoning..." style={{ resize: 'vertical' }} />
            </div>
            {problems.length > 0 && (
              <p className="t-mono" role="status" style={{ fontSize: 'var(--fs-tiny)', color: 'var(--c-crimson)' }}>
                {problems.join(' ')}
              </p>
            )}
          </div>
        )}

        {/* Submit / result */}
        {submitted ? (
          <div style={{
            marginTop: 'var(--sp-4)', padding: '16px', background: 'rgba(37, 162, 68, 0.12)',
            border: '2px solid var(--c-success, #25a244)', boxShadow: '3px 3px 0px #000', textAlign: 'center',
          }}>
            <div style={{ color: 'var(--c-success, #25a244)', fontWeight: 800, fontSize: '14px', fontFamily: 'var(--font-mono)' }}>
              ✓ REVIEW RECORDED
            </div>
            <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--text-h)' }}>
              <strong>DECISION:</strong> {effectiveDecision === 'confirm'
                ? `Confirmed AI Grade ${cnn}.`
                : `Final grade ${overrideGrade} (${drGradeLabels[overrideGrade]}), reason: ${overrideReasonCategories.find((c) => c.value === overrideCategory)?.label}.`}
              <br />
              Review took <strong>{elapsedSeconds} seconds</strong>; recorded under {reviewerName || 'your login'}.
              {describeOutcome(outcome).map((line) => (<React.Fragment key={line}><br />{line}</React.Fragment>))}
            </div>
          </div>
        ) : effectiveDecision && (
          <button
            className={`btn btn--lg u-w-full ${effectiveDecision === 'confirm' ? 'btn--success' : 'btn--danger'}`}
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{ justifyContent: 'center', marginTop: 'var(--sp-2)' }}
          >
            <span>
              {submitting ? 'SUBMITTING…'
                : `SUBMIT ${priorReview ? 'CORRECTION' : disagree ? 'RESOLUTION' : effectiveDecision.toUpperCase()} (PRESS ENTER)`}
            </span>
          </button>
        )}
      </div>
    </div>
  );
};
