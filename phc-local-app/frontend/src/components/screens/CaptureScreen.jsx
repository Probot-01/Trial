import React, { useState, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { QualityResultPanel } from './QualityResultPanel';
import { CaptureMetadataForm, initialMetadata } from './CaptureMetadataForm';
// PatientQuestionnaireForm removed — the patient questionnaire is collected at registration
import { RetinalImageViewer } from './RetinalImageViewer';
import { localApi } from '../../api/localApiClient';
import { USE_MOCK_DATA } from '../../config';
import { mockAiPredictions } from '../../api/mockData';
import { LoadError } from '../shared/LoadError';
import { CAMERA_DEVICES, EYES } from '../../api/captureOptions';
import { buildQuestionnairePayload, buildMetadataPayload, IncompleteAnswers } from '../../api/payloads';
import { loadQuestionnaire } from '../../api/patientSession';
import demoFundusImg from '../../assets/fundus_eye.jpg';

/** The latest registered patient, but only if it is the one this screen is for. */
function latestPatientFor(patientId) {
  try {
    const p = JSON.parse(localStorage.getItem('netra_latest_patient'));
    return p && p.patientId === patientId ? p : null;
  } catch { return null; }
}

export const CaptureScreen = () => {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const patientId = searchParams.get('patientId') || 'UNKNOWN_PATIENT';
  // The fictional 'Krrish, 20' stand-in is mock-mode only; live mode shows what
  // it actually knows about the patient, even if that is nothing.
  const patientName = searchParams.get('name') || latestPatientFor(patientId)?.name
    || (USE_MOCK_DATA ? 'Krrish' : '');
  const patientAge = searchParams.get('age') || latestPatientFor(patientId)?.age
    || (USE_MOCK_DATA ? '20' : '');

  const [activeStep, setActiveStep] = useState(1);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState(null);
  const [qualityResult, setQualityResult] = useState(null);

  // Design doc §4.1/§10.4: every capture is tagged left or right eye, and the
  // camera is recorded, BEFORE the photograph is taken. Live mode starts with
  // neither chosen -- the technician has to say, not accept a default.
  const [eye, setEye] = useState(USE_MOCK_DATA ? 'right' : null);
  const [cameraDeviceId, setCameraDeviceId] = useState(USE_MOCK_DATA ? CAMERA_DEVICES[0].id : null);
  const [metadata, setMetadata] = useState(initialMetadata);

  // The patient questionnaire is answered once, at registration, and stored per
  // patient. Mock mode tolerates a missing one; live mode does not invent one.
  const [questionnaire] = useState(() => loadQuestionnaire(patientId) || (USE_MOCK_DATA ? {} : null));

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // { title, err, captureId? } for whichever live request last failed; shown in
  // place of a result, never replaced by one.
  const [stepError, setStepError] = useState(null);
  const [mockScenario] = useState('pass');

  // What has already been accepted by the local backend for this capture, so a
  // second press of SAVE after a failure does not post the same answers twice.
  const savedRef = useRef({ captureId: null, questionnaire: false, metadata: false });

  const fileInputRef = useRef(null);
  const setupReady = !!eye && !!cameraDeviceId;

  const handleCaptureClick = () => {
    if (fileInputRef.current && !imageFile) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setImageFile(file);
      setImagePreviewUrl(URL.createObjectURL(file));
      setStepError(null);
    }
  };

  // Mock mode only: a stock image stands in for the camera. In live mode this
  // would attach a picture that is not the patient's to a real patient record.
  const handleLoadDemoImage = async (e) => {
    e?.stopPropagation();
    try {
      const response = await fetch(demoFundusImg);
      const blob = await response.blob();
      const file = new File([blob], 'demo_fundus_retina.png', { type: 'image/png' });
      setImageFile(file);
      setImagePreviewUrl(demoFundusImg);
    } catch (err) {
      console.warn("Could not load demo fundus image:", err);
    }
  };

  /** A gate verdict from the local backend -> what step 2 shows. */
  const showVerdict = (capture) => {
    setQualityResult({
      captureId: capture.captureId,
      isRealCapture: true,
      retakeCount: capture.retakeCount,
      qualityStatus: capture.qualityStatus,
      issues: capture.qualityReason ? [capture.qualityReason] : [],
      // 2026-09-30: the API now also returns a derived qualityScore (0-1) and
      // three of the seven sub-scores as metrics (api-contracts.md) -- both
      // null on a capture gated before this was added, or gated by an engine
      // that doesn't record sub-scores.
      qualityScore: capture.qualityScore ?? null,
      metrics: capture.metrics ?? null,
      qualityGateEngine: capture.qualityGateEngine ?? null,
    });
    setStepError(null);
    setActiveStep(2);
  };

  const gateError = (err) => ({
    title: err.code === 'quality_gate_failed'
      ? 'QUALITY CHECK COULD NOT RUN — THE IMAGE WAS SAVED'
      : 'QUALITY CHECK FAILED — NO RESULT',
    err,
    // api-contracts.md: a 503 quality_gate_failed carries the id of the saved
    // capture, which can be re-checked without taking the photograph again.
    captureId: err.details?.captureId ?? null,
  });

  const runQualityCheck = async () => {
    if (!imageFile || !setupReady) return;

    setIsAnalyzing(true);
    setStepError(null);
    try {
      // ── Real local quality gate (phc-local-app/backend POST /captures) ──
      // MATLAB (compiled exe, or matlab -batch). DR grading happens centrally,
      // not here (system-design-v4.md §1.2 & §1.3).
      // Mock mode: returns null. Live mode: a verdict, or it throws.
      const capture = await localApi.submitCapture(patientId, imageFile, cameraDeviceId);

      if (capture) {
        showVerdict(capture);
        return;
      }

      // MOCK MODE ONLY: scenario fixtures (submitCapture returns null only in mock mode).
      await new Promise(r => setTimeout(r, 600));
      const scenario = mockAiPredictions[mockScenario] || mockAiPredictions.pass;
      const apiStatus = scenario.imageQuality?.status || 'good';
      const uiStatus = apiStatus === 'good' ? 'pass' : (apiStatus === 'borderline' ? 'borderline' : 'retake');
      const issues = scenario.imageQuality?.issues || [];
      setQualityResult({
        captureId: `CAPT-${Date.now()}`,
        isRealCapture: false,
        retakeCount: undefined,
        qualityStatus: uiStatus,
        issues,
        qualityScore: scenario.imageQuality?.qualityScore ?? null,
        metrics: scenario.imageQuality?.metrics ?? null,
        imageQuality: {
          status: uiStatus === 'pass' ? 'good' : (uiStatus === 'borderline' ? 'borderline' : 'poor'),
          qualityScore: scenario.imageQuality?.qualityScore ?? null,
          metrics: scenario.imageQuality?.metrics ?? null,
          issues,
        },
      });
      setActiveStep(2);
    } catch (err) {
      console.error("Quality Check Error:", err);
      setStepError(gateError(err));
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Re-run the gate on the image the backend already holds.
  const retryQualityCheck = async () => {
    if (!stepError?.captureId) return;
    setIsAnalyzing(true);
    try {
      showVerdict(await localApi.recheckQuality(stepError.captureId));
    } catch (err) {
      setStepError(gateError({ ...err, details: err.details ?? { captureId: stepError.captureId } }));
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Retake: back to step 1 with the same eye and camera, ready for a new photograph.
  const handleRetake = () => {
    setStepError(null);
    setImageFile(null);
    setImagePreviewUrl(null);
    setQualityResult(null);
    setActiveStep(1);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleAcceptQuality = () => setActiveStep(3);

  // §10.2: technician marks a repeatedly-failed capture "best effort -- proceed
  // as ungradable" rather than retaking forever. The backend call is what
  // actually queues it (a plain 'retake' never queues itself); this screen then
  // moves on to step 3 exactly as a real pass would, so metadata is still
  // collected for the case that is now, genuinely, on its way to central.
  const [bestEffortError, setBestEffortError] = useState(null);
  const handleBestEffort = async () => {
    if (!qualityResult?.captureId) return;
    setBestEffortError(null);
    setIsAnalyzing(true);
    try {
      const updated = await localApi.markBestEffort(qualityResult.captureId);
      setQualityResult((prev) => ({ ...prev, bestEffort: updated?.bestEffort ?? true }));
      setActiveStep(3);
    } catch (err) {
      console.error('Failed to mark capture as best effort:', err);
      setBestEffortError(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const missingForSave = () => {
    if (USE_MOCK_DATA) return [];
    try {
      buildMetadataPayload(metadata, { eye, cameraDeviceId });
      return [];
    } catch (e) { return e instanceof IncompleteAnswers ? e.missing : [String(e.message)]; }
  };

  const handleSubmit = async () => {
    setStepError(null);
    setIsSaving(true);
    try {
      if (!USE_MOCK_DATA) {
        // Live: both answer sets must be ACCEPTED by the local backend. The
        // capture cannot sync until they are (the sync manager waits for both),
        // so a failure stays on this step with the reason, and SAVE can be
        // pressed again. Nothing is invented: a missing answer throws.
        if (!questionnaire) {
          throw new IncompleteAnswers('The patient questionnaire', ['not found for this patient on this station']);
        }
        const questionnaireBody = buildQuestionnairePayload(questionnaire, i18n.language);
        const metadataBody = buildMetadataPayload(metadata, { eye, cameraDeviceId });

        const id = qualityResult.captureId;
        if (savedRef.current.captureId !== id) savedRef.current = { captureId: id, questionnaire: false, metadata: false };
        if (!savedRef.current.questionnaire) {
          await localApi.submitQuestionnaire(id, questionnaireBody);
          savedRef.current.questionnaire = true;
        }
        if (!savedRef.current.metadata) {
          await localApi.submitCaptureMetadata(id, metadataBody);
          savedRef.current.metadata = true;
        }
      } else {
        // Mock: the client-side demo queue entry the Local Queue Table and
        // result modal are built around.
        await localApi.saveCaptureMetadata(qualityResult?.captureId || `CAPT-${Date.now()}`, {
          patientId,
          patientName,
          patientAge,
          metadata,
          questionnaire: questionnaire || {},
          aiPrediction: qualityResult?.aiPrediction,
          imagePreviewUrl: imagePreviewUrl || demoFundusImg
        });
      }
      navigate('/queue');
    } catch (err) {
      console.error('Failed to save capture data:', err);
      setStepError({
        title: err instanceof IncompleteAnswers ? 'ANSWERS INCOMPLETE — NOT SAVED' : 'QUESTIONNAIRE / CAPTURE DETAILS NOT SAVED',
        err,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const eyeLabel = eye === 'left' ? 'LEFT EYE (OS)' : eye === 'right' ? 'RIGHT EYE (OD)' : 'EYE NOT CHOSEN';
  const missing = activeStep === 3 ? missingForSave() : [];
  const canSave = !isSaving && missing.length === 0 && (USE_MOCK_DATA || !!questionnaire);

  return (
    <div className="capture-screen-root">
      {/* ── Title Bar ── */}
      <div className="cs-titlebar">
        <h1 className="t-h1 cs-title">{t('capture.title', 'IMAGE CAPTURE')}</h1>
        <span className="cs-patient-id">
          {t('capture.patient', 'PATIENT:')} <strong style={{ color: 'var(--c-crimson, #CC0000)' }}>{(patientName || '—').toUpperCase()}</strong> ({patientId}) {patientAge ? `• ${patientAge}Y` : ''}
        </span>
      </div>

      {/* ── Stepper ── */}
      <div className="cs-stepper">
        {[
          { n: 1, label: t('capture.steps.capture', '1. CAPTURE') },
          { n: 2, label: t('capture.steps.quality', '2. QUALITY GATE') },
          { n: 3, label: t('capture.steps.metadata', '3. METADATA & SYNC') },
        ].map(({ n, label }) => (
          <div
            key={n}
            className={`cs-step ${activeStep === n ? 'cs-step--active' : ''} ${activeStep > n ? 'cs-step--done' : ''}`}
          >
            {label}{activeStep > n ? ' ✓' : ''}
          </div>
        ))}
      </div>

      {/* ── Main Two-Column Body ── */}
      <div className="cs-body">

        {/* ═══ LEFT: Image Panel ═══ */}
        <div className="cs-image-col">
          {/* Header strip according to active step */}
          {activeStep === 1 && (
            <div className="cs-img-strip">
              <span className="cs-img-strip__label cs-img-strip__label--active">
                {t('capture.liveFeed', 'LIVE FEED')}
              </span>
              <span className="cs-img-strip__label">
                {t('capture.statusCaptured', 'CAPTURED')}
              </span>
            </div>
          )}

          {activeStep === 2 && (
            <div className="cs-img-strip">
              <span className="cs-img-strip__label">
                LIVE FEED
              </span>
              <span className="cs-img-strip__label cs-img-strip__label--active">
                CAPTURED — {eyeLabel}
              </span>
            </div>
          )}

          {activeStep === 3 && (
            <div className="cs-img-strip cs-img-strip--center">
              <span className="cs-img-strip__label cs-img-strip__label--active">
                CAPTURED — {eyeLabel}
              </span>
            </div>
          )}

          <input
            type="file"
            accept="image/png, image/jpeg, image/jpg"
            style={{ display: 'none' }}
            ref={fileInputRef}
            onChange={handleFileChange}
            data-testid="fundus-file-input"
          />

          {/* Image area — fully scaled, object-fit: contain, no cropping, zoomable */}
          <div className={`cs-img-frame ${imageFile ? 'cs-img-frame--has-image' : ''}`} onClick={handleCaptureClick}>
            {imagePreviewUrl ? (
              <RetinalImageViewer src={imagePreviewUrl} alt="Fundus Capture" />
            ) : (
              <div className="cs-img-placeholder">
                <div className="cs-img-placeholder__icon">◎</div>
                <div className="t-mono cs-img-placeholder__text">{t('capture.clickToInitiate', 'CLICK TO INITIATE CAPTURE SEQUENCE')}</div>
                {USE_MOCK_DATA && (
                  <button
                    type="button"
                    className="btn btn--outline"
                    style={{ fontSize: '0.72rem', padding: '6px 14px', zIndex: 10 }}
                    onClick={handleLoadDemoImage}
                  >
                    {t('capture.loadSample', '✦ LOAD SAMPLE RETINAL SCAN')}
                  </button>
                )}
              </div>
            )}
            {/* Crosshair when empty */}
            {!imageFile && <div className="capture-zone__crosshair" />}
          </div>

          {/* Bottom controls — step 1 only */}
          {imageFile && activeStep === 1 && (
            <div className="cs-bottom-bar">
              {!setupReady && (
                <div className="t-mono" style={{ fontSize: 12, color: 'var(--c-crimson, #C42B2B)', marginBottom: 8 }}>
                  Choose the eye and the camera (right panel) before running the quality check.
                </div>
              )}
              <div className="cs-bottom-bar__actions">
                <button className="btn btn--outline cs-retake-btn" onClick={handleRetake} disabled={isAnalyzing}>
                  {t('capture.btnRetake', 'RETAKE')}
                </button>
                <button className="btn cs-run-check-btn" onClick={runQualityCheck} disabled={isAnalyzing || !setupReady}>
                  {isAnalyzing ? t('capture.btnAnalyzing', 'ANALYZING... ✦') : 'RUN QUALITY CHECK →'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ═══ RIGHT: Context Panel ═══ */}
        <div className="cs-right-col">
          {stepError && (
            <>
              <LoadError error={stepError.err} title={stepError.title} compact />
              {stepError.captureId && activeStep === 1 && (
                <button
                  type="button"
                  className="btn btn--lg"
                  onClick={retryQualityCheck}
                  disabled={isAnalyzing}
                  style={{ margin: '8px 0 16px', width: '100%', justifyContent: 'center' }}
                >
                  {isAnalyzing ? 'CHECKING…' : '↻ RETRY QUALITY CHECK ON THE SAVED IMAGE'}
                </button>
              )}
            </>
          )}

          {/* ─── STEP 1: eye + camera, then instructions ─── */}
          {activeStep === 1 && (
            <>
              <div className="meta-card" style={{ marginBottom: 16 }}>
                <div className="meta-card__header">
                  <h3 className="meta-card__title">BEFORE YOU CAPTURE</h3>
                </div>
                <div className="meta-card__body">
                  <div className="meta-field">
                    <label className="meta-label">
                      EYE BEING PHOTOGRAPHED <span style={{ color: 'var(--c-crimson, #C42B2B)' }}>*</span>
                    </label>
                    <div className="meta-eye-toggle" data-testid="eye-choice">
                      {EYES.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          className={`meta-eye-btn ${eye === o.id ? 'meta-eye-btn--active' : ''}`}
                          onClick={() => setEye(o.id)}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="meta-field">
                    <label className="meta-label">
                      CAMERA <span style={{ color: 'var(--c-crimson, #C42B2B)' }}>*</span>
                    </label>
                    <div className="select-wrap">
                      <select
                        className="select meta-select"
                        value={cameraDeviceId || ''}
                        onChange={(e) => setCameraDeviceId(e.target.value || null)}
                        data-testid="camera-choice"
                      >
                        <option value="" disabled>SELECT CAMERA…</option>
                        {CAMERA_DEVICES.map((cam) => (
                          <option key={cam.id} value={cam.id}>{cam.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              <div className="cs-instructions">
                <h2 className="t-h3 cs-instr-title">
                  {t('capture.instructionsTitle', 'INSTRUCTIONS')}
                </h2>
                <div className="cs-instr-divider" />
                <ul className="cs-instr-list">
                  {t(cameraDeviceId === 'mobile_lens' ? 'capture.instructionsLens' : 'capture.instructions',
                    { returnObjects: true }).map((instruction, idx) => (
                    <li key={idx} className="cs-instr-item">
                      <span className="cs-instr-num">0{idx + 1}</span>
                      <span>{instruction}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          {/* ─── STEP 2: Quality Gate ─── */}
          {activeStep === 2 && qualityResult && (
            <div className="cs-quality-panel">
              {qualityResult.retakeCount > 0 && (
                <div className="t-mono" style={{ fontSize: 12, marginBottom: 8, opacity: 0.8 }}>
                  RETAKE ATTEMPT {qualityResult.retakeCount + 1} FOR THIS PATIENT TODAY
                </div>
              )}
              {bestEffortError && (
                <LoadError error={bestEffortError} title="COULD NOT MARK AS BEST EFFORT" compact />
              )}
              <QualityResultPanel
                result={qualityResult}
                onRetake={handleRetake}
                onAccept={handleAcceptQuality}
                onBestEffort={handleBestEffort}
              />
            </div>
          )}

          {/* ─── STEP 3: Metadata & Sync ─── */}
          {activeStep === 3 && (
            <div className="cs-meta-panel">
              {qualityResult?.bestEffort && (
                <div style={{
                  padding: '10px 12px', marginBottom: 12,
                  background: 'rgba(230, 20, 20, 0.08)', border: '2px solid var(--c-crimson)',
                }}>
                  <div style={{ color: 'var(--c-crimson)', fontWeight: 800, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                    ⚠ BEST EFFORT — UNGRADABLE
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.4 }}>
                    This image failed the quality gate. It will still be sent, flagged for mandatory ophthalmologist review.
                  </div>
                </div>
              )}
              {!USE_MOCK_DATA && !questionnaire && (
                <LoadError
                  compact
                  title="PATIENT QUESTIONNAIRE NOT FOUND"
                  error={{ message: 'This station has no questionnaire answers for this patient, and none are invented. '
                    + 'Register the patient again to record them.' }}
                />
              )}
              <div className="t-mono" style={{ fontSize: 12, margin: '0 0 8px', opacity: 0.85 }}>
                {eyeLabel} · CAMERA: {CAMERA_DEVICES.find((c) => c.id === cameraDeviceId)?.label || '—'}
              </div>
              <CaptureMetadataForm value={metadata} onChange={setMetadata} />
              <div className="cs-meta-footer">
                {missing.length > 0 && (
                  <div className="t-mono" style={{ fontSize: 12, color: 'var(--c-crimson, #C42B2B)', marginBottom: 8 }}>
                    Still to answer: {missing.join(' · ')}
                  </div>
                )}
                <button className="btn cs-sync-btn" onClick={handleSubmit} disabled={!canSave}>
                  {isSaving ? 'SAVING…' : 'SAVE & SYNC TO SERVER →'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
