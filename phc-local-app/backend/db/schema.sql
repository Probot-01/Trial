

CREATE TABLE IF NOT EXISTS patients (
  patient_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  age            INTEGER NOT NULL,
  contact_number TEXT NOT NULL,   -- required: the only channel for delayed results
  registered_at  TEXT NOT NULL,
  consent_given_at TEXT            -- §9.7 verbal consent, ISO-8601; see localDb.js
);

CREATE TABLE IF NOT EXISTS captures (
  capture_id       TEXT PRIMARY KEY,
  patient_id       TEXT NOT NULL REFERENCES patients(patient_id),
  camera_device_id TEXT,
  image_path       TEXT NOT NULL,
  -- 'pending' while the quality gate runs, then one of pass/retake/borderline.
  quality_status   TEXT NOT NULL,
  quality_reason   TEXT,          -- NULL on pass; else one of the six enum strings
  retake_count     INTEGER NOT NULL DEFAULT 0,
  captured_at      TEXT NOT NULL,

  quality_scores   TEXT,

  quality_engine   TEXT
);

-- Patient symptom + risk answers (design doc §9.1) -- about the PATIENT.
CREATE TABLE IF NOT EXISTS questionnaire_responses (
  response_id        TEXT PRIMARY KEY,
  capture_id         TEXT NOT NULL REFERENCES captures(capture_id),
  risk_factor_fields TEXT NOT NULL,  -- JSON string
  symptom_fields     TEXT NOT NULL,  -- JSON string
  language           TEXT,
  recorded_at        TEXT NOT NULL
);

-- Capture-context answers (design doc §9.6) -- about the PHOTO, not the patient.
-- Deliberately a separate table from questionnaire_responses (design doc §1.10).
CREATE TABLE IF NOT EXISTS capture_metadata_responses (
  response_id             TEXT PRIMARY KEY,
  capture_id              TEXT NOT NULL REFERENCES captures(capture_id),
  camera_device_reported  TEXT,
  pupil_status            TEXT,
  lighting_environment    TEXT,
  observed_issues         TEXT NOT NULL,  -- JSON array string
  worker_usability_rating TEXT,
  recorded_at             TEXT NOT NULL,
  eye_laterality          TEXT            -- 'left' | 'right' (§10.4); see localDb.js
);

CREATE TABLE IF NOT EXISTS sync_queue (
  queue_id        TEXT PRIMARY KEY,
  capture_id      TEXT NOT NULL REFERENCES captures(capture_id),
  status          TEXT NOT NULL DEFAULT 'pending',
  -- 'high' = referable/uncertain (full data first), 'low' = confident-negative
  -- (summary only). Provisional until a first central pass classifies it (§9.2).
  priority        TEXT NOT NULL DEFAULT 'low',
  chunks_sent     INTEGER NOT NULL DEFAULT 0,
  chunks_total    INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TEXT
);

-- Indexes for the Local Queue table and the sync poll loop.
CREATE INDEX IF NOT EXISTS idx_captures_patient    ON captures(patient_id);
CREATE INDEX IF NOT EXISTS idx_captures_status     ON captures(quality_status);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status   ON sync_queue(status);
