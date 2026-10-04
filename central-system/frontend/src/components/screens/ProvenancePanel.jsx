import React from 'react';

const GRADING_ROWS = [
  ['classifier', 'CLASSIFIER (BRANCH A)'],
  ['ruleEngine', 'RULE ENGINE (BRANCH B)'],
];

const SEGMENTATION_ROWS = [
  ['vessel', 'VESSEL'],
  ['localization', 'LOCALIZATION'],
  ['hardExudate', 'HARD EXUDATE'],
  ['redLesion', 'RED LESION'],
];

const CAMERA_FAMILY_LABELS = {
  desktop_tabletop: 'DESKTOP / TABLETOP',
  portable_handheld: 'PORTABLE HANDHELD',
  smartphone_adapter: 'SMARTPHONE ADAPTER',
  // classifyCameraFamily.m's defaultFamily: nothing scored well enough.
  unknown: 'UNKNOWN - NOT MATCHED',
  // preprocessForBranchA.m when camera calibration is switched off for the run.
  disabled: 'CALIBRATION DISABLED',
};

/** A camera family as it reads mid-sentence, e.g. "a portable handheld". */
const familyPhrase = (family) => {
  if (!family) return 'a family that was not recorded';
  if (family === 'unknown') return 'no family this system recognises';
  if (family === 'disabled') return 'nothing (camera calibration was switched off)';
  return `a ${String(family).replace(/_/g, ' ')}`;
};

/** One { engine, fallback, detail } entry, or the reason it is not there. */
const EngineRow = ({ label, entry, whenNull, indent = false }) => {
  const missing = !entry;
  return (
    <div
      style={{
        padding: 'var(--sp-3)',
        paddingLeft: indent ? 'var(--sp-6)' : 'var(--sp-3)',
        borderTop: 'var(--border)',
      }}
    >
      <div className="u-flex u-justify-between u-items-center u-gap-4">
        {/* The label can wrap on a narrow column; the engine must not be
            pushed off the row, so it keeps its own line box. */}
        <span className="t-label" style={{ opacity: 0.5, minWidth: 0 }}>{label}</span>
        <span
          className="u-flex u-items-center u-gap-4"
          style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
        >
          {missing ? (
            <span className="t-mono" style={{ fontWeight: 700, opacity: 0.4, fontSize: 'var(--fs-small)' }}>
              NOT RECORDED
            </span>
          ) : (
            <>
              <span className="t-mono" style={{ fontWeight: 700, fontSize: 'var(--fs-small)' }}>
                {String(entry.engine).toUpperCase()}
              </span>
              {entry.fallback === true && (
                <span
                  className="badge badge--fail"
                  title={'This output did NOT come from the primary engine. An explicit '
                    + 'environment flag (MATLAB_ALLOW_FALLBACK, SEG_ALLOW_PYTHON_FALLBACK '
                    + 'or QUALITY_GATE_ALLOW_FALLBACK) allowed a non-primary engine to '
                    + 'answer. Without such a flag the case would have failed or been '
                    + 'retried instead.'}
                >
                  &#9888; FALLBACK
                </span>
              )}
            </>
          )}
        </span>
      </div>
      {/* detail is printed verbatim: free text for a human, never parsed. */}
      <p
        className="t-mono"
        style={{ fontSize: 'var(--fs-tiny)', opacity: 0.55, marginTop: 'var(--sp-1)' }}
      >
        {missing ? whenNull : (entry.detail || 'No detail recorded.')}
      </p>
    </div>
  );
};

/** One "what the file says" / "what the worker said" tile. */
const FactTile = ({ label, value, hint, borderRight = false }) => (
  <div
    style={{
      padding: 'var(--sp-3)',
      borderTop: 'var(--border)',
      borderRight: borderRight ? 'var(--border)' : undefined,
    }}
  >
    <span className="t-label" style={{ opacity: 0.5 }}>{label}</span>
    <p className="t-mono" style={{ fontWeight: 700 }} title={hint || undefined}>
      {value || <span style={{ opacity: 0.4, fontWeight: 700 }}>NOT RECORDED</span>}
    </p>
  </div>
);

export const ProvenancePanel = ({ caseData }) => {
  const c = caseData;
  const p = c.engineProvenance || {};
  const seg = p.segmentation;

  // Why an entry might legitimately be null, spelled out per output rather
  // than as one vague line. A case that failed says so, because "not graded
  // yet" and "grading gave up" otherwise read identically -- as a blank.
  const notGradedWhy = c.status === 'error'
    ? `Grading gave up on this case${c.failureCode ? ` (${c.failureCode})` : ''}, so no engine produced this output.`
    : c.status === 'graded'
      ? 'This case was graded before the engine was stored (migration 0019).'
      : 'This case has not finished grading.';

  // A fallback anywhere is worth one line at the top -- a reviewer should not
  // have to scan seven rows to find out the primary engine did not answer.
  const fallbackOutputs = [
    ['classifier', p.classifier],
    ['rule engine', p.ruleEngine],
    ['quality gate', p.qualityGate],
    ...SEGMENTATION_ROWS.map(([k, label]) => [`segmentation (${label.toLowerCase()})`, seg ? seg[k] : null]),
  ].filter(([, e]) => e && e.fallback === true).map(([name]) => name);

  return (
    <div className="case-detail__provenance" style={{ border: 'var(--border)', marginTop: 'var(--sp-4)' }}>
      <div style={{ padding: 'var(--sp-4) var(--sp-6)', borderBottom: 'var(--border)' }}>
        <h3 className="t-h3">PROVENANCE</h3>
        <p className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.5, marginTop: 'var(--sp-1)' }}>
          WHICH ENGINE PRODUCED EACH OUTPUT, AND WHAT THE IMAGE FILE REPORTS ABOUT ITSELF
        </p>
      </div>

      {fallbackOutputs.length > 0 && (
        <div
          style={{
            padding: 'var(--sp-3) var(--sp-6)',
            borderBottom: 'var(--border)',
            background: 'var(--c-crimson)',
          }}
          data-testid="provenance-fallback-warning"
        >
          <span className="t-mono" style={{ color: 'white', fontWeight: 700, fontSize: 'var(--fs-small)' }}>
            &#9888; NON-PRIMARY ENGINE ANSWERED FOR: {fallbackOutputs.join(', ').toUpperCase()}
          </span>
        </div>
      )}

      {/* The classifier build this grade came from. Null is not a version. */}
      <div style={{ padding: 'var(--sp-3)' }}>
        <div className="u-flex u-justify-between u-items-center u-gap-4">
          <span className="t-label" style={{ opacity: 0.5 }}>MODEL VERSION</span>
          <span className="t-mono" style={{ fontWeight: 700, fontSize: 'var(--fs-small)' }}>
            {c.modelVersion
              ? String(c.modelVersion).toUpperCase()
              : <span style={{ opacity: 0.4 }}>NOT RECORDED</span>}
          </span>
        </div>
        <p className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.55, marginTop: 'var(--sp-1)' }}>
          {c.modelVersion
            ? 'The registered classifier build that produced the Branch A grade.'
            : 'No classifier build is recorded against this case.'}
        </p>
      </div>

      {GRADING_ROWS.map(([key, label]) => (
        <EngineRow key={key} label={label} entry={p[key]} whenNull={notGradedWhy} />
      ))}

      {/* Segmentation: the object itself is null when segmentation did not run
          for this case -- the same fact `lesionCounts: null` states. A single
          model inside it is null when segmentation did not report that one. */}
      <div
        style={{
          // A group header when the models follow, a full row when they do not.
          padding: seg ? 'var(--sp-2) var(--sp-3)' : 'var(--sp-3)',
          borderTop: 'var(--border)',
        }}
      >
        <span className="t-label" style={{ opacity: 0.5 }}>SEGMENTATION</span>
        {!seg && (
          <p className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.55, marginTop: 'var(--sp-1)' }}>
            NOT RECORDED &mdash; segmentation did not run for this case. That is the same
            fact the empty lesion counts state.
          </p>
        )}
      </div>
      {seg && SEGMENTATION_ROWS.map(([key, label]) => (
        <EngineRow
          key={key}
          label={label}
          entry={seg[key]}
          whenNull="Segmentation ran but did not report this model."
          indent
        />
      ))}

      <EngineRow
        label="QUALITY GATE (AT THE PHC)"
        entry={p.qualityGate}
        whenNull={'The capturing client did not report it: an older PHC build, the '
          + 'mobile app, or a capture replicated between peer devices.'}
      />

      {/* What the FILE says, kept apart from what the worker selected. A
          disagreement is surfaced by the tier reason, not resolved here. */}
      <div className="grid--2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
        <FactTile
          label="SOURCE FORMAT"
          value={c.sourceFormat ? String(c.sourceFormat).toUpperCase() : null}
          hint="What the uploaded file actually was: a DICOM object, or a plain image."
          borderRight
        />
        <FactTile
          label="DICOM DEVICE MODEL"
          value={c.dicomDeviceModel || null}
          hint={c.sourceFormat === 'image'
            ? 'A plain image carries no device tags, so there is nothing to read.'
            : 'Manufacturer and model as written in the file’s own DICOM tags.'}
        />
        <FactTile
          label="CAMERA FAMILY - DETECTED"
          value={c.cameraFamilyDetected
            ? (CAMERA_FAMILY_LABELS[c.cameraFamilyDetected] || String(c.cameraFamilyDetected).toUpperCase())
            : null}
          hint="Inferred from the image itself, independently of what the worker selected."
          borderRight
        />
        <FactTile
          label="CAMERA DEVICE - REPORTED"
          value={c.captureMetadata?.cameraDeviceReported?.replace(/_/g, ' ').toUpperCase() || null}
          hint="The device the technician selected at capture time."
        />
      </div>
      { }
      <div style={{ padding: 'var(--sp-3)', borderTop: 'var(--border)' }} data-testid="camera-cross-check">
        <div className="u-flex u-justify-between u-items-center u-gap-4">
          <span className="t-label" style={{ opacity: 0.5 }}>CAMERA CROSS-CHECK</span>
          {c.cameraMismatch === true ? (
            <span
              className="badge badge--fail"
              title={'The camera family detected in this image is not the family the '
                + 'reported device implies. The image may not have come from the device '
                + 'recorded against it, or that device is mis-profiled here.'}
            >
              &#9888; DISAGREES
            </span>
          ) : c.cameraMismatch === false ? (
            <span className="t-mono" style={{ fontWeight: 700, fontSize: 'var(--fs-small)', color: 'var(--c-success)' }}>
              AGREES
            </span>
          ) : (
            <span className="t-mono" style={{ fontWeight: 700, fontSize: 'var(--fs-small)', opacity: 0.4 }}>
              NOT CHECKED
            </span>
          )}
        </div>
        <p className="t-mono" style={{ fontSize: 'var(--fs-tiny)', opacity: 0.55, marginTop: 'var(--sp-1)' }}>
          {c.cameraMismatch === null || c.cameraMismatch === undefined
            ? 'No expected family is known for the reported device, so there was nothing '
            + 'to compare the image against. This is not a statement that the two agree.'
            : `The reported device implies ${familyPhrase(c.cameraExpectedFamily)}; `
            + `the image was read as ${familyPhrase(c.cameraFamilyDetected)}.`}
        </p>
      </div>
    </div>
  );
};
