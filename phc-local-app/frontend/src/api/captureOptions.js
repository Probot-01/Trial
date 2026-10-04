
export const CAMERA_DEVICES = [
  { id: 'forus_3nethra_v2', label: 'Forus 3Nethra v2' },
  { id: 'remidio_fop', label: 'Remidio FOP' },
  { id: 'generic_fundus', label: 'Generic Fundus Camera' },

  { id: 'mobile_lens', label: 'Fundus Lens (Phone Attachment)' },
  { id: 'unknown', label: 'Unknown / Other' },
];

export const EYES = [
  { id: 'left', label: 'LEFT (OS)' },
  { id: 'right', label: 'RIGHT (OD)' },
];

// POST /captures/:captureId/capture-metadata
export const PUPIL_STATUS = [
  { id: 'dilated', label: 'DILATED' },
  { id: 'non_dilated', label: 'NOT DILATED' },
  { id: 'unknown', label: 'UNKNOWN' },
];

export const LIGHTING_ENVIRONMENT = [
  { id: 'indoor_clinic', label: 'INDOOR CLINIC' },
  { id: 'outdoor_mobile', label: 'OUTDOOR / MOBILE' },
  { id: 'low_light', label: 'LOW LIGHT' },
];

export const OBSERVED_ISSUES = [
  { id: 'glare', label: 'GLARE' },
  { id: 'blink_or_moved', label: 'PATIENT BLINKED / MOVED' },
  { id: 'out_of_focus', label: 'OUT OF FOCUS' },
  { id: 'media_opacity', label: 'MEDIA OPACITY (E.G. CATARACT)' },
  { id: 'eyelash_obstruction', label: 'EYELASH OBSTRUCTION' },
];
export const NONE_NOTICED = 'none_noticed';

export const USABILITY_RATING = [
  { id: 'clear', label: 'CLEAR' },
  { id: 'not_sure', label: 'NOT SURE' },
  { id: 'clearly_unusable', label: 'CLEARLY UNUSABLE' },
];

// POST /captures/:captureId/questionnaire
export const YEARS_SINCE_DIAGNOSIS = [
  { id: 'lt1', label: '< 1 YR' },
  { id: '1to5', label: '1–5 YRS' },
  { id: '5to10', label: '5–10 YRS' },
  { id: 'gt10', label: '> 10 YRS' },
];
export const GLYCEMIC_CONTROL = [
  { id: 'good', label: 'GOOD' },
  { id: 'moderate', label: 'MODERATE' },
  { id: 'poor', label: 'POOR' },
];
export const BLOOD_PRESSURE = [
  { id: 'normal', label: 'Normal' },
  { id: 'high', label: 'High (Hypertension)' },
  { id: 'unknown', label: 'Unknown / Not Measured' },
];
export const SYMPTOMS = [
  { id: 'blurredVision', label: 'BLURRED VISION' },
  { id: 'floaters', label: 'FLOATERS' },
  { id: 'suddenVisionChange', label: 'SUDDEN VISION CHANGE' },
  { id: 'eyePain', label: 'EYE PAIN' },
];

/** "MATLAB", "JS FALLBACK"... for the qualityGateEngine a capture reports (null when not recorded). */
export const engineLabel = (engine) => {
  if (!engine) return null;
  const names = {
    matlab: 'MATLAB',
    python: 'PYTHON',
    'js-fallback': 'JS FALLBACK',
    'js-device': 'ON-DEVICE JS',
  };
  return names[engine.engine] || String(engine.engine).toUpperCase();
};
