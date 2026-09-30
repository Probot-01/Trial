import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { localApi } from '../../api/localApiClient';
import { mockAiPredictions } from '../../api/mockData';
import { USE_MOCK_DATA } from '../../config';
import { LoadError } from '../shared/LoadError';
import { DiagnosticResultModal } from './DiagnosticResultModal';
import { InfoModalButton } from '../shared/InfoModalButton';

const QUEUE_INFO_ROWS = [
  { term: 'THE 5 STAGES', text: 'Every capture moves through: 1 Captured, 2 Quality check passed, 3 Sent to central, 4 Central is grading it, 5 Result ready. The five dots on each row show which stage that capture has reached.' },
  { term: 'RETAKE REQUIRED', text: 'The image failed the on-the-spot quality check and was not uploaded. Retake it from the capture screen.' },
  { term: 'QUALITY CHECK NOT RUN', text: 'The photo saved, but the quality check itself could not run just now. Re-check it from the capture screen — nothing is lost.' },
  { term: 'QUESTIONNAIRE MISSING', text: 'The image passed quality, but it will not upload until both patient questionnaires are filled in.' },
  { term: 'UPLOAD FAILED / INTERRUPTED', text: 'Either central refused the upload (rare — shown with the reason), or the connection dropped mid-transfer. The app keeps retrying on its own; no action needed unless it stays stuck a long time.' },
  { term: 'SYNCED, AWAITING AI', text: 'Central has the case and is grading it now. This normally takes under a minute.' },
  { term: 'SYNCED — GRADING FAILED AT CENTRAL', text: 'Central received the image but could not produce a result. This needs attention at central, not another retake here.' },
  { term: 'RESULT READY / RESULT AT CENTRAL', text: 'Grading finished. This station may or may not show the grade itself, depending on setup — either way, the ophthalmologist’s queue at central always has it.' },
];

// The five stages of design doc §4.1, in order. A capture is at exactly one.
//   1 Captured  2 Quality-passed  3 Synced  4 Result-pending  5 Result-delivered
// "Synced" means central ACCEPTED the case; "result pending/delivered" come from
// what central reports about it (never from elapsed time).
const STAGE = { captured: 1, quality_passed: 2, synced: 3, result_pending: 4, result_delivered: 5 };

const REASON_TEXT = {
  blur: 'blurred', low_illumination: 'too dark', insufficient_fov: 'field of view too small',
  glare: 'glare', motion_artifact: 'motion artefact', eyelash_occlusion: 'eyelash occlusion',
};

/**
 * describe(item) -> what the row says, and why.
 *
 * Problems are named, not hidden behind a stage label: a retake, a capture
 * still waiting for its questionnaire, an upload central refused (with central's
 * own words), a case central failed to grade. Mock items carry none of the
 * extra fields, so they fall through to the plain stage labels.
 */
function describe(item) {
  const status = STAGE[item.status] ? item.status : 'captured';
  const base = { stage: STAGE[status], detail: null, isError: false, badgeClass: 'stage-badge--pending', actionText: 'WAITING', actionDisabled: true, label: '' };

  if (status === 'captured') {
    if (item.qualityStatus === 'retake') {
      return { ...base, label: 'RETAKE REQUIRED', badgeClass: 'stage-badge--error', isError: true,
        detail: `The image failed the quality check${item.qualityReason ? ` (${REASON_TEXT[item.qualityReason] || item.qualityReason})` : ''}. It is not uploaded.`,
        actionText: 'RETAKE' };
    }
    if (item.qualityStatus === null) {
      return { ...base, label: 'QUALITY CHECK NOT RUN', badgeClass: 'stage-badge--blocked', isError: true,
        detail: 'The image is saved, but the quality check could not run just now. Re-check it from the capture screen.',
        actionText: 'WAITING (QA)' };
    }
    return { ...base, label: 'CAPTURED', badgeClass: 'stage-badge--captured', actionText: 'WAITING (QA)' };
  }

  if (status === 'quality_passed') {
    if (item.syncError) {
      const e = item.syncError;
      const refused = e.kind === 'rejected' || e.kind === 'server';
      return { ...base, label: refused ? 'UPLOAD FAILED — CENTRAL DID NOT ACCEPT IT' : 'UPLOAD INTERRUPTED',
        badgeClass: 'stage-badge--error', isError: true, detail: e.message,
        actionText: e.nextAttemptAt ? 'WILL RETRY' : 'RETRYING' };
    }
    if (item.formsComplete === false) {
      return { ...base, label: 'QUESTIONNAIRE MISSING', badgeClass: 'stage-badge--blocked', isError: true,
        detail: 'Passed the quality check, but it will not upload until both questionnaires are recorded.',
        actionText: 'WAITING (FORMS)' };
    }
    if (item.uploadProgress) {
      return { ...base, label: `UPLOADING ${item.uploadProgress.sent}/${item.uploadProgress.total}`, actionText: 'UPLOADING…' };
    }
    // §10.2: this capture failed the gate (qualityStatus stays 'retake') but the
    // technician marked it best effort, so it is queued like a real pass. Say
    // so plainly -- "QUALITY PASS" would be a fabricated result for an image
    // that did not pass.
    if (item.bestEffort) {
      return { ...base, label: 'BEST EFFORT — UNGRADABLE, QUEUED', badgeClass: 'stage-badge--pass', actionText: 'WAITING (SYNC)',
        detail: 'This image failed the quality check but was sent anyway for mandatory ophthalmologist review.' };
    }
    return { ...base, label: item.formsComplete === true ? 'QUEUED — PENDING UPLOAD' : 'QUALITY PASS',
      badgeClass: 'stage-badge--pass', actionText: 'WAITING (SYNC)' };
  }

  if (status === 'synced') {
    if (item.centralStatus === 'error') {
      return { ...base, label: 'SYNCED — GRADING FAILED AT CENTRAL', badgeClass: 'stage-badge--error', isError: true,
        detail: 'Central accepted the case but could not grade it, so there is no result. It needs attention at central.',
        actionText: 'NO RESULT' };
    }
    return { ...base, label: 'SYNCED, AWAITING AI', badgeClass: 'stage-badge--synced', actionText: 'WAITING FOR AI' };
  }

  if (status === 'result_pending') {
    return { ...base, label: 'AI PENDING', badgeClass: 'stage-badge--pending', actionText: 'AI PROCESSING...' };
  }

  // result_delivered: central reports the case graded. Live rows carry no grade
  // (the Local API never holds one), so there is nothing to open: say where the
  // result is instead of showing a button that does nothing.
  if (!USE_MOCK_DATA && !item.prediction) {
    return { ...base, label: 'RESULT READY', badgeClass: 'stage-badge--ready', actionText: 'RESULT AT CENTRAL',
      detail: 'Central has graded this case. This station does not display the grade yet.' };
  }
  return { ...base, label: 'RESULT READY', badgeClass: 'stage-badge--ready', actionText: 'VIEW RESULT →', actionDisabled: false };
}

export const LocalQueueTable = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchQueue = async () => {
      try {
        const data = await localApi.getQueue();
        if (cancelled) return;
        setQueue(data);
        setLoadError(null);
      } catch (err) {
        // The last good list stays visible, marked stale by the error above it.
        console.error(err);
        if (!cancelled) setLoadError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    // A capture's pipeline stage (captured -> quality_passed -> synced) changes
    // in the background (sync manager, central grading) while a technician may
    // just be sitting on this screen — a one-shot fetch on mount never reflects
    // that, and looks exactly like "nothing is happening" even once it has.
    fetchQueue();
    const interval = setInterval(fetchQueue, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Handle ESC key for modal
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isModalOpen) {
        setIsModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen]);

  const handleOpenResult = (item, e) => {
    e?.stopPropagation();
    setSelectedItem(item);
    setIsModalOpen(true);
  };

  // Design doc §10.4: DR is graded per eye, so one visit is up to two
  // independent captures for the same patient. Skips registration entirely --
  // the patient already exists -- and reuses whatever questionnaire this
  // station cached for them at registration, exactly as a normal capture does.
  const handleCaptureOtherEye = (item, e) => {
    e?.stopPropagation();
    const query = new URLSearchParams({ patientId: item.patientId, name: item.patientName || '' }).toString();
    navigate(`/capture?${query}`);
  };

  const renderStageIndicator = (item) => {
    const config = describe(item);
    const stageNum = config.stage;

    return (
      <div className="stage-indicator">
        <div className="stage-dots" aria-label={`Stage ${stageNum} of 5: ${config.label}`}>
          {[1, 2, 3, 4, 5].map((dot) => {
            let dotType = 'empty';
            if (dot < stageNum) {
              dotType = 'completed'; // Solid green
            } else if (dot === stageNum) {
              // Current stage: green if delivered/pass, amber if awaiting sync/AI
              dotType = (stageNum === 5 || stageNum === 1 || stageNum === 2) && !config.isError ? 'completed' : 'active';
            }
            return (
              <span
                key={dot}
                className={`stage-dot stage-dot--${dotType}`}
                title={`Stage ${dot} / 5`}
              />
            );
          })}
        </div>
        <div className={`stage-label ${config.badgeClass}`}>
          {config.label}
        </div>
        {config.detail && (
          <div className={`stage-detail${config.isError ? ' stage-detail--error' : ''}`}>{config.detail}</div>
        )}
      </div>
    );
  };

  return (
    <div className="section queue-section">
      <div className="u-flex u-justify-between u-items-center u-mb-3">
        <div className="u-flex u-items-center">
          <h1 className="t-h1 queue-title">{t('queue.title')}</h1>
          <InfoModalButton title="CAPTURE QUEUE" rows={QUEUE_INFO_ROWS} />
        </div>
        <div className="t-mono" style={{ opacity: 0.6, fontSize: '0.85rem' }}>
          {queue.length} {t('queue.items')}
        </div>
      </div>

      {loadError && (
        <LoadError error={loadError} compact
          title={queue.length ? 'QUEUE NOT REFRESHED — SHOWING THE LAST GOOD LIST' : 'COULD NOT LOAD THE CAPTURE QUEUE'} />
      )}

      <div className="panel queue-panel">
        <div className="queue-table-wrapper">
          <table className="table queue-table">
            <thead>
              <tr>
                <th>{t('queue.colId')}</th>
                <th>{t('queue.colPatient')}</th>
                <th>{t('queue.colCaptured')}</th>
                <th>PIPELINE STAGE</th>
                <th>{t('queue.colAction')}</th>
              </tr>
            </thead>
          <tbody>
            {loading ? (
              [1, 2, 3, 4].map((i) => (
                <tr key={i}>
                  <td colSpan="5">
                    <div className="skeleton" style={{ height: '28px', width: '100%' }}></div>
                  </td>
                </tr>
              ))
            ) : queue.length === 0 && loadError ? (
              <tr>
                <td colSpan="5" className="u-text-center u-p-6">
                  <span className="t-mono" style={{ opacity: 0.5 }}>—</span>
                </td>
              </tr>
            ) : queue.length === 0 ? (
              <tr>
                <td colSpan="5" className="u-text-center u-p-6">
                  <span className="t-mono" style={{ opacity: 0.5 }}>{t('queue.empty')}</span>
                </td>
              </tr>
            ) : (
              queue.map((item) => {
                const config = describe(item);
                // Live rows carry no prediction (the PHC never holds a grade), so
                // there is nothing real to open; the modal must never fall back
                // to a fixture result for them.
                const isReady = item.status === 'result_delivered' && (USE_MOCK_DATA || !!item.prediction);

                return (
                  <tr 
                    key={item.captureId} 
                    className={isReady ? "clickable queue-row--ready" : ""}
                    onClick={isReady ? (e) => handleOpenResult(item, e) : undefined}
                  >
                    <td>
                      <span className="t-mono" style={{ opacity: 0.8, fontWeight: 600 }}>
                        {item.captureId.split('-')[1] || item.captureId}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 700, fontSize: '14px' }}>{item.patientName}</div>
                      <div className="t-mono" style={{ fontSize: '11px', opacity: 0.5 }}>{item.patientId}</div>
                    </td>
                    <td>
                      <span className="t-mono" style={{ fontSize: '13px' }}>
                        {new Date(item.capturedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </td>
                    <td>
                      {renderStageIndicator(item)}
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                        {config.actionDisabled || !isReady ? (
                          <button
                            type="button"
                            disabled
                            className="btn-action-col btn-action-col--disabled"
                            title={config.detail || `Pipeline stage: ${config.label}`}
                          >
                            {config.actionText}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn-action-col btn-action-col--active"
                            onClick={(e) => handleOpenResult(item, e)}
                          >
                            {config.actionText}
                          </button>
                        )}
                        {/* Design doc §10.4: DR is graded per eye. This capture's own
                            stage never blocks starting the other eye -- it is an
                            independent capture for the same patient, so this is
                            always available, not gated behind config.actionDisabled. */}
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          style={{ fontSize: '10px', padding: '3px 8px' }}
                          onClick={(e) => handleCaptureOtherEye(item, e)}
                          data-testid="capture-other-eye"
                        >
                          CAPTURE OTHER EYE →
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Interactive Screening Result Modal */}
      <DiagnosticResultModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        item={selectedItem}
        prediction={selectedItem?.prediction || (USE_MOCK_DATA ? mockAiPredictions.pass : null)}
        imageUrl={selectedItem?.imagePreviewUrl || selectedItem?.imageUrl}
      />
    </div>
  );
};

