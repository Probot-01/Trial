import React from 'react';


const FAILURE_TEXT = {
  matlab_unavailable:
    'The grading engine could not be reached.',
  matlab_session_unavailable:
    'The grading engine was not running when this case was picked up.',
  matlab_segmentation_failed:
    'Lesion segmentation failed, and the system did not substitute a different engine for it.',
  python_unavailable:
    'The segmentation worker could not be reached.',
  image_not_found:
    'The uploaded image could not be read back for grading.',

  unknown:
    'Grading stopped, and the engine did not report a specific reason.',
};

const PROCESSING_TEXT = {
  processing:
    'This case is being graded now. The fields below stay empty until it finishes — '
    + 'they are not results of zero. Grading normally takes under a minute; longer is '
    + 'not abnormal if a worker is busy.',
  awaiting_image:
    'The case record arrived but its image has not finished uploading, so grading has '
    + 'not started. The fields below are empty for that reason.',
};

const fmt = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
};

export const CaseStatusBanner = ({ caseData }) => {
  const c = caseData || {};
  const status = c.status;


  if (status !== 'error' && status !== 'processing' && status !== 'awaiting_image') return null;

  const failed = status === 'error';
  const colour = failed ? 'var(--c-crimson, #cc0000)' : 'var(--c-warning, #8a6d00)';

  return (
    <div
      role="alert"
      className="u-mb-6"
      data-testid={failed ? 'case-failed-banner' : 'case-pending-banner'}
      style={{ border: `2px solid ${colour}`, boxShadow: '4px 4px 0px rgba(0,0,0,0.05)' }}
    >
      <div
        style={{
          background: colour, color: '#fff', padding: 'var(--sp-2) var(--sp-4)',
          display: 'flex', alignItems: 'center', gap: '8px',
        }}
      >
        <span className="t-mono" style={{ fontSize: 'var(--fs-small)', fontWeight: 700, letterSpacing: '1px' }}>
          {failed ? '⚠ GRADING FAILED — THIS CASE HAS NO AI GRADE'
            : '○ NOT GRADED YET — THIS CASE IS STILL BEING PROCESSED'}
        </span>
      </div>
      <div style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
        <p className="t-mono" style={{ fontSize: 'var(--fs-small)', lineHeight: 1.6, margin: 0 }}>
          {failed
            ? (FAILURE_TEXT[c.failureCode]
              || 'Grading stopped before producing a result.')
            : (PROCESSING_TEXT[status] || 'This case has not been graded yet.')}
        </p>

        {failed && (
          <>
            <p className="t-mono" style={{ fontSize: 'var(--fs-small)', lineHeight: 1.6, marginTop: 'var(--sp-2)' }}>
              The empty grade, confidence and lesion fields below are <strong>missing
                results, not findings</strong>. Nothing here says this eye is healthy.
              Grade this case from the image yourself, or ask an administrator to
              re-run it.
            </p>
            <p className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.7, marginTop: 'var(--sp-2)' }}>
              {c.failureCode ? `code: ${c.failureCode}` : 'reason not recorded'}
              {fmt(c.failedAt) ? ` · gave up ${fmt(c.failedAt)}` : ''}
            </p>
          </>
        )}
      </div>
    </div>
  );
};
