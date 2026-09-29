import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { centralApi } from '../../api/centralApiClient';
import { CENTRAL_API_BASE } from '../../config';
import { drGradeLabels } from '../../api/mockData';
import { GradCamOverlay } from './GradCamOverlay';
import { LesionEvidencePanel } from './LesionEvidencePanel';
import { BranchComparisonPanel } from './BranchComparisonPanel';
import { ProvenancePanel } from './ProvenancePanel';
import { CaseStatusBanner } from './CaseStatusBanner';
import { LesionAttentionMetric } from './LesionAttentionMetric';
import { DecisionControls, describeOutcome } from './DecisionControls';
import { CaseHistoryTimeline } from './CaseHistoryTimeline';
import { InfoBanner } from '../shared/InfoBanner';
import { LoadError } from '../shared/LoadError';

const MetricBar = ({ label, value, maxVal = 1, color = 'var(--c-crimson)', nullReason }) => {
  const pct = Math.round((value / maxVal) * 100);
  return (
    <div className="u-mb-4">
      <div className="u-flex u-justify-between u-items-center" style={{ marginBottom: 'var(--sp-1)' }}>
        <span className="t-label">{label}</span>
        <span
          className="t-mono"
          style={{ fontWeight: 700, fontSize: 'var(--fs-small)' }}
          title={typeof value !== 'number' ? nullReason : undefined}
        >
          {typeof value === 'number' ? `${pct}%` : 'NOT COMPUTED'}
        </span>
      </div>
      <div className="bar">
        <div className="bar__fill" style={{ width: value !== null ? `${pct}%` : '0%', background: color }} />
      </div>
    </div>
  );
};

const SeverityBadge = ({ grade }) => {
  let cls = 'badge badge--neutral';
  let label = 'UNKNOWN';
  if (grade === 0) {
    cls = 'badge badge--pass';
    label = 'LOW';
  } else if (grade === 1 || grade === 2) {
    cls = 'badge badge--warning';
    label = 'MID';
  } else if (grade === 3 || grade === 4) {
    cls = 'badge badge--fail';
    label = 'HIGH';
  }
  return <span className={cls}>SEVERITY: {label}</span>;
};

/**
 * ReportButton -- the downloadable clinical-rationale PDF (design doc §5.2,
 * §6.9). GET /cases/:id/report renders it on demand (up to ~40 s the first
 * time), then this opens the file the server hands back. A failure is shown
 * as a failure; there is no substitute document.
 */
const ReportButton = ({ caseId }) => {
  const [state, setState] = useState({ busy: false, error: null, url: null });
  const generate = async () => {
    setState({ busy: true, error: null, url: null });
    try {
      const r = await centralApi.getCaseReport(caseId);
      setState({ busy: false, error: null, url: r.reportUrl });
      window.open(`${CENTRAL_API_BASE}${r.reportUrl}`, '_blank', 'noopener');
    } catch (err) {
      setState({ busy: false, error: err, url: null });
    }
  };
  return (
    <div className="u-flex u-items-center u-gap-3" style={{ flexWrap: 'wrap' }}>
      <button className="btn btn--outline" onClick={generate} disabled={state.busy}
        style={{ padding: 'var(--sp-1) var(--sp-3)', fontSize: 'var(--fs-tiny)' }}>
        <span>{state.busy ? 'GENERATING REPORT…' : '⬇ EVIDENCE REPORT (PDF)'}</span>
      </button>
      {state.url && (
        <a className="t-mono" style={{ fontSize: 'var(--fs-tiny)' }} href={`${CENTRAL_API_BASE}${state.url}`}
          target="_blank" rel="noopener noreferrer">OPEN AGAIN</a>
      )}
      {state.error && (
        <span role="alert" className="t-mono" style={{ fontSize: 'var(--fs-tiny)', color: 'var(--c-crimson)' }}>
          REPORT FAILED: {state.error.message}{state.error.code ? ` (${state.error.code})` : ''}
        </span>
      )}
    </div>
  );
};

export const CaseDetailPage = () => {
  const { caseId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const outlet = useOutletContext() || {};
  const reviewerName = outlet.userProfile?.fullName || outlet.userProfile?.email || null;
  const [caseData, setCaseData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showGradCam, setShowGradCam] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);
  const [reviewOutcome, setReviewOutcome] = useState(null);
  const [claimedBy, setClaimedBy] = useState(null);   // name of ANOTHER reviewer holding it
  const [claimedByMe, setClaimedByMe] = useState(false);
  const [priorReview, setPriorReview] = useState(null);
  // Failures, kept apart: without the case there is nothing to show; a failed
  // claim or review-history call is shown next to the case, not hidden.
  const [loadError, setLoadError] = useState(null);
  const [sideErrors, setSideErrors] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);
  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    startTimeRef.current = Date.now();
    setLoading(true);
    setLoadError(null);
    setSideErrors([]);
    const noteSideError = (what) => (err) => {
      if (!cancelled) setSideErrors(prev => [...prev, { what, err }]);
    };

    setClaimedBy(null);
    setClaimedByMe(false);
    Promise.all([
      centralApi.getCaseDetail(caseId),
      centralApi.claimCase(caseId).then(() => {
        if (!cancelled) setClaimedByMe(true);
      }).catch(err => {
        if (cancelled) return;
        // Only case_claimed means "someone else holds it". Any other 409
        // (case_not_graded) or failure is a different problem and is shown as
        // one -- not passed off as a claim by another reviewer.
        if (err.code === 'case_claimed') {
          setClaimedBy(err.details?.claimedBy?.name || 'another reviewer');
        } else {
          noteSideError('COULD NOT CLAIM THIS CASE — another reviewer may open it too')(err);
        }
      }),
      centralApi.getReviews(caseId).then(reviews => {
        if (reviews && reviews.length > 0) setPriorReview(reviews[0]);
      }).catch(noteSideError('COULD NOT LOAD THE REVIEW HISTORY — a prior review may exist')),
    ]).then(([data]) => {
      if (cancelled) return;
      setCaseData(data);
      setLoading(false);
    }).catch(err => {
      if (cancelled) return;
      setLoadError(err);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [caseId, reloadKey]);

  const handleReviewSubmit = async (reviewData) => {
    const durationSec = Math.round((Date.now() - startTimeRef.current) / 1000);
    const result = await centralApi.submitReview(caseId, {
      ...reviewData,
      reviewDurationSeconds: durationSec,
    });
    setReviewOutcome(result);
    setReviewSubmitted(true);
    // Long enough to read the referral / SMS outcome the server reported.
    setTimeout(() => navigate('/ophth/queue'), 6000);
  };

  if (loading) {
    return (
      <div className="section">
        <div className="skeleton" style={{ height: '40px', width: '400px', marginBottom: 'var(--sp-6)' }} />
        <div className="grid--2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
          <div className="skeleton" style={{ height: '500px' }} />
          <div className="skeleton" style={{ height: '500px' }} />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="section">
        <LoadError error={loadError} what={`case ${String(caseId).slice(0, 8).toUpperCase()}`}
          onRetry={() => setReloadKey(k => k + 1)} />
        <button className="btn btn--outline" onClick={() => navigate('/ophth/queue')}>
          ← {t('central.caseDetail.nav.queue', 'CASES')}
        </button>
      </div>
    );
  }

  if (!caseData) {
    return <div className="section"><p className="t-mono">{t('central.caseDetail.notFound', 'Case not found.')}</p></div>;
  }

  const c = caseData;
  const isBranchMismatch = c.branchAgreement === false;

  return (
    <div className={`section case-detail ${reviewSubmitted ? 'case-detail--submitted' : ''}`}>
      {sideErrors.map(({ what, err }) => (
        <LoadError key={what} error={err} title={what} compact />
      ))}
      {/* Top Bar — Case ID + Tier + Mismatch Warning */}
      <div className={`case-detail__top-bar ${isBranchMismatch ? 'case-detail__top-bar--mismatch' : ''}`}>
        <div className="u-flex u-items-center u-gap-4">
          <button className="btn btn--outline" onClick={() => navigate('/ophth/queue')} style={{ padding: 'var(--sp-2) var(--sp-3)' }}>
            <span>← {t('central.caseDetail.nav.queue', 'CASES')}</span>
          </button>
          <div>
            <span className="t-mono" style={{ fontSize: 'var(--fs-small)', opacity: 0.5 }}>{t('central.caseDetail.caseLabel', 'CASE')}</span>
            {/* The patient reference (PT-1234) is the readable case identifier the
                queue and referral screens also show; the raw case UUID stays in the tooltip. */}
            <span className="t-mono" title={`Case ID ${caseId}`} style={{ fontWeight: 700, marginLeft: 'var(--sp-2)', color: 'var(--c-crimson)' }}>
              {c.patientReference || caseId}
            </span>
          </div>
        </div>

        <div className="u-flex u-items-center u-gap-4">
          {claimedByMe && !claimedBy && !reviewSubmitted && (
            <span className="badge badge--neutral" data-testid="claimed-by-me">● CLAIMED BY YOU</span>
          )}
          {claimedBy && (
            <span className="badge badge--fail" data-testid="claimed-by-other">● CLAIMED BY {String(claimedBy).toUpperCase()}</span>
          )}
          <SeverityBadge grade={c.drGradeCnn} />

          {/* WHY this case is in its tier, not just which tier.
              Five different situations produce a "B" -- the model being
              unsure, an unreliable fovea, an eye-laterality mismatch, a
              camera on probation, or a camera nobody has validated -- and
              they ask different things of the reviewer. The backend has
              recorded the reason since migration 0015; showing only the
              letter threw that away at the last step. */}
          {c.conformalTier && (
            <span
              className="badge badge--neutral"
              title={c.tierReason
                || 'Reason not recorded: this case was graded before the reason was stored.'}
              data-testid="tier-badge"
            >
              TIER {String(c.conformalTier).toUpperCase()}
            </span>
          )}

          {/* The fovea gate. When it fires, the quadrant-based severe-NPDR
              criteria (a) and (b) were SKIPPED for this eye, so the grade may
              be an under-call. That is said inside the evidence prose; a
              reviewer scanning the header should not have to read for it. */}
          {c.foveaUnreliable === true && (
            <span
              className="badge badge--fail"
              title={'The fovea could not be located reliably, so lesion quadrants '
                + 'cannot be trusted. The quadrant-based severe-NPDR criteria were '
                + 'not applied and this grade may be an under-call.'}
              data-testid="fovea-unreliable-badge"
            >
              ⚠ FOVEA UNRELIABLE
            </span>
          )}

          {isBranchMismatch && (
            <span className="badge badge--fail case-detail__mismatch-badge">
              {t('central.caseDetail.mismatchWarning', '⚠ BRANCH MISMATCH — REVIEW REQUIRED')}
            </span>
          )}

          {/* Design doc §10.2: the PHC technician sent this image after it failed
              the local quality gate, rather than retaking forever or dropping
              the patient. Carried inside captureMetadata (additive, no contract
              change) since it comes from the PHC front-ends, not the grading
              pipeline. The grade above still reflects whatever the classifier
              said about a genuinely substandard image -- this badge is the
              reviewer's warning that it may not be trustworthy. */}
          {c.captureMetadata?.bestEffort === true && (
            <span
              className="badge badge--fail"
              title="The PHC's local quality gate rejected this image; the technician sent it anyway as best effort, after repeated failed retakes, rather than leave the patient unscreened."
              data-testid="best-effort-badge"
            >
              ⚠ BEST EFFORT — FAILED LOCAL QUALITY GATE
            </span>
          )}
        </div>
      </div>

      {/* Whether this case HAS a grade at all. A failed case and one still
          being graded both render every ML field as null, so without this
          they read identically -- which api-contracts.md explicitly forbids.
          Renders nothing once the case is graded. */}
      <CaseStatusBanner caseData={c} />

      <InfoBanner title={t('central.caseDetail.banner.title', 'CLINICAL REVIEW GUIDANCE')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div><strong style={{ color: 'var(--c-crimson)' }}>CONFIDENCE:</strong> The confidence score shows the model's certainty. Lower scores should be scrutinized closely.</div>
          <div><strong style={{ color: 'var(--c-crimson)' }}>UNCERTAINTY:</strong> Measures the model's epistemic uncertainty regarding the grade.</div>
          <div><strong style={{ color: 'var(--c-crimson)' }}>CONSISTENCY:</strong> Lesion-attention consistency ensures the model is looking at valid physiological features (like microaneurysms) rather than artifacts.</div>
          <div><strong style={{ color: 'var(--c-crimson)' }}>BRANCH MISMATCH:</strong> If the CNN and Rule Engine disagree, you must resolve this manually by providing a clinical reason.</div>
          <div><strong style={{ color: 'var(--c-crimson)' }}>GRAD-CAM:</strong> Use the Grad-CAM toggle to verify where the model is placing its attention on the fundus image.</div>
        </div>
      </InfoBanner>

      {/* Main Content Grid */}
      <div className="case-detail__grid">
        {/* LEFT COLUMN — Image + Metrics */}
        <div className="case-detail__left">
          {/* Fundus Image with Grad-CAM Toggle */}
          <div className="case-detail__image-panel panel--dark">
            <div className="case-detail__image-header u-flex u-justify-between u-items-center">
              <span className="t-label" style={{ color: 'var(--c-crimson)' }}>
                {t('central.caseDetail.image.fundus', 'FUNDUS IMAGE')} — {c.patientReference}
                {c.eyeLaterality ? ` · ${c.eyeLaterality.toUpperCase()} EYE` : ''}
              </span>
              <button
                className={`btn ${showGradCam ? 'btn--danger' : 'btn--outline'}`}
                onClick={() => setShowGradCam(!showGradCam)}
                style={{ padding: 'var(--sp-1) var(--sp-3)', fontSize: 'var(--fs-tiny)' }}
              >
                <span>{showGradCam ? t('central.caseDetail.image.gradCamOn', '✦ GRAD-CAM ON') : t('central.caseDetail.image.gradCamOff', '○ GRAD-CAM OFF')}</span>
              </button>
            </div>
            <GradCamOverlay showOverlay={showGradCam} caseData={c} />
          </div>

          {/* Downloadable clinical-rationale report (PDF) */}
          <div style={{ padding: 'var(--sp-3) var(--sp-6)', border: 'var(--border)' }}>
            <ReportButton caseId={caseId} />
          </div>

          {/* Metric Bars */}
          <div className="case-detail__metrics" style={{ padding: 'var(--sp-6)', border: 'var(--border)' }}>
            <MetricBar
              label={t('central.caseDetail.metrics.confidence', 'CONFIDENCE')}
              value={c.confidenceScore}
              color={c.confidenceScore > 0.85 ? 'var(--c-success)' : c.confidenceScore > 0.7 ? 'var(--c-warning)' : 'var(--c-crimson)'}
            />
            <MetricBar
              label={t('central.caseDetail.metrics.uncertainty', 'UNCERTAINTY')}
              value={c.uncertaintyScore}
              color="var(--c-warning)"
              /* The scope caveat travels with the number, the way the urgency
                 limitation does. MC-dropout here samples ONE dropout layer on
                 the classifier head, over features the trunk fixed -- so it
                 measures the head's uncertainty and cannot see representation
                 uncertainty. A confidently wrong out-of-distribution image
                 scores LOW, which is the opposite of what a reader assumes a
                 high-uncertainty flag protects them from. */
              title={typeof c.uncertaintyScore === 'number'
                ? 'Normalised predictive entropy over 20 Monte-Carlo dropout passes '
                  + '(0 = certain, 1 = uniform across all five grades). It samples the '
                  + 'classifier HEAD over fixed image features, so it measures whether '
                  + 'the classifier is torn between grades — it cannot see that an '
                  + 'image is unlike anything the model was trained on. A confidently '
                  + 'wrong out-of-distribution image scores LOW here.'
                : undefined}
              // Kept from Tanuj's fallback (2582cbf), with the reason corrected.
              // His version said uncertainty "is not computed on the MATLAB
              // classifier backend -- only under Python", which was true when he
              // wrote it and is not any more: mcDropoutMatlab.m now computes it
              // there too. A null on a MATLAB-graded case therefore means the
              // case predates that wiring, or the measurement itself failed --
              // never that the engine cannot do it.
              nullReason={c.uncertaintyScore == null
                ? 'Not computed for this case. Not a score of zero — zero would mean '
                  + 'the model was maximally certain. Cases graded before MC-dropout was '
                  + 'wired on this engine have no value stored; re-grading computes one.'
                : undefined}
            />
            {/* NOT a MetricBar. The consistency score is an overlap fraction
                and is meaningless without its chance level -- a bar coloured
                red below 0.6 called a good heatmap on a lightly-diseased eye a
                failure. LesionAttentionMetric shows the comparison instead,
                and takes its pass/fail from the backend's own flag. */}
            <LesionAttentionMetric caseData={c} />
          </div>
        </div>

        {/* RIGHT COLUMN — Grading + Evidence + Context */}
        <div className="case-detail__right">
          {/* Branch Comparison */}
          <BranchComparisonPanel caseData={c} />

          {/* Lesion Evidence */}
          <LesionEvidencePanel caseData={c} />

          {/* Patient / Capture Context */}
          <div className="case-detail__context" style={{ border: 'var(--border)', padding: 'var(--sp-6)' }}>
            <h3 className="t-h3 u-mb-4">{t('central.caseDetail.context.title', 'PATIENT / CAPTURE CONTEXT')}</h3>
            <div className="grid--2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
              {/* The API deliberately carries a display-safe reference, not the
                  patient's name or age (api-contracts.md, patientReference):
                  nothing is invented to fill those tiles. */}
              <div style={{ padding: 'var(--sp-3)', borderRight: 'var(--border)', borderBottom: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>PATIENT REFERENCE</span>
                <p className="t-mono" style={{ fontWeight: 700, color: 'var(--c-crimson)' }}>
                  {c.patientReference || 'N/A'}
                </p>
              </div>
              {/* WHICH EYE, and on whose word. The image file's own DICOM tag
                  wins over the technician's selection when both exist (SS10.4),
                  and a DISAGREEMENT between them is surfaced rather than
                  resolved silently -- filing a grade against the wrong eye is
                  not a cosmetic error. The backend has served the source and
                  the mismatch flag all along; this tile printed the winning
                  value alone, which hid both. */}
              <div style={{ padding: 'var(--sp-3)', borderBottom: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>EYE</span>
                <p className="t-mono" style={{ fontWeight: 700, textTransform: 'uppercase' }}>
                  {c.eyeLaterality || 'N/A'}
                  {c.eyeLateralityMismatch === true && (
                    <span
                      className="badge badge--fail"
                      style={{ marginLeft: 'var(--sp-2)' }}
                      data-testid="eye-laterality-mismatch"
                      title={'The image file reports one eye and the technician selected '
                        + 'the other. The value shown is the file’s, which wins, but the '
                        + 'disagreement is unresolved: confirm which eye this is before '
                        + 'acting on the grade.'}
                    >
                      &#9888; DISPUTED
                    </span>
                  )}
                </p>
                <span className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.55 }}>
                  {c.eyeLateralitySource === 'dicom' ? 'from the image file’s own DICOM tag'
                    : c.eyeLateralitySource === 'technician' ? 'as selected by the technician'
                    : 'not recorded'}
                </span>
              </div>
              <div style={{ padding: 'var(--sp-3)', borderRight: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.diabetesDuration', 'DIABETES DURATION')}</span>
                <p className="t-mono" style={{ fontWeight: 700 }}>
                  {c.questionnaireData?.riskFactors?.yearsSinceDiagnosis
                    ? { lt1: '< 1 year', '1to5': '1–5 years', '5to10': '5–10 years', gt10: '> 10 years' }[c.questionnaireData.riskFactors.yearsSinceDiagnosis]
                    : 'N/A'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.bloodPressure', 'BLOOD PRESSURE')}</span>
                <p className="t-mono" style={{ fontWeight: 700, textTransform: 'uppercase' }}>
                  {c.questionnaireData?.riskFactors?.bloodPressure || 'N/A'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)', borderRight: 'var(--border)', borderTop: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.pupilStatus', 'PUPIL STATUS')}</span>
                <p className="t-mono" style={{ fontWeight: 700, textTransform: 'uppercase' }}>
                  {c.captureMetadata?.pupilStatus || 'N/A'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)', borderTop: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.cameraDevice', 'CAMERA DEVICE')}</span>
                <p className="t-mono" style={{ fontWeight: 700 }}>
                  {c.captureMetadata?.cameraDeviceReported?.replace(/_/g, ' ').toUpperCase() || 'N/A'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)', borderRight: 'var(--border)', borderTop: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.workerRating', 'WORKER RATING')}</span>
                <p className="t-mono" style={{ fontWeight: 700, textTransform: 'uppercase' }}>
                  {c.captureMetadata?.workerUsabilityRating || 'N/A'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)', borderTop: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.symptoms', 'SYMPTOMS')}</span>
                <p className="t-mono" style={{ fontWeight: 700, fontSize: 'var(--fs-tiny)' }}>
                  {c.questionnaireData?.symptoms
                    ? Object.entries(c.questionnaireData.symptoms)
                        .filter(([, v]) => v)
                        .map(([k]) => k.replace(/([A-Z])/g, ' $1').trim().toUpperCase())
                        .join(', ') || 'NONE'
                    : 'N/A'}
                </p>
              </div>
            </div>
          </div>

          {/* WHICH ENGINE produced each output, the classifier build behind the
              grade, and what the image file says about itself. The quality-gate
              engine used to sit as a lone tile in the context grid above; it is
              one of seven engine entries the backend records, so it now lives
              with the other six instead of standing in for them. */}
          <ProvenancePanel caseData={c} />
        </div>
      </div>

      {/* Bottom — Decision Controls + History */}
      <div className="case-detail__bottom">
        <DecisionControls
          caseData={c}
          onSubmit={handleReviewSubmit}
          submitted={reviewSubmitted}
          claimedBy={claimedBy}
          priorReview={priorReview}
          reviewerName={reviewerName}
          outcome={reviewOutcome}
        />

        <div style={{ marginTop: 'var(--sp-4)' }}>
          <button
            className="btn btn--outline u-w-full"
            onClick={() => setShowHistory(!showHistory)}
            style={{ justifyContent: 'center' }}
          >
            <span>{showHistory ? t('central.caseDetail.history.hide', '▼ HIDE HISTORY') : t('central.caseDetail.history.show', '▶ SHOW PATIENT HISTORY')} ({c.priorAssessments?.length || 0} {t('central.caseDetail.history.prior', 'prior')})</span>
          </button>
          {showHistory && <CaseHistoryTimeline priorAssessments={c.priorAssessments || []} />}
        </div>
      </div>

      {/* Success overlay */}
      {reviewSubmitted && (
        <div className="case-detail__success-overlay">
          <div className="case-detail__success-content">
            <span style={{ fontSize: '4rem' }}>✓</span>
            <h2 className="t-h2">{t('central.caseDetail.success.title', 'REVIEW SUBMITTED')}</h2>
            {describeOutcome(reviewOutcome).map((line) => (
              <p key={line} className="t-mono" style={{ maxWidth: 520 }}>{line}</p>
            ))}
            <p className="t-mono" style={{ opacity: 0.6 }}>{t('central.caseDetail.success.subtitle', 'REDIRECTING TO CASES...')}</p>
          </div>
        </div>
      )}
    </div>
  );
};
