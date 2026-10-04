

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. phc_sites -- one row per Primary Health Centre
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS phc_sites (
  phc_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,

  
  last_sync_at  TIMESTAMPTZ,
  pending_count INTEGER NOT NULL DEFAULT 0
);


CREATE TABLE IF NOT EXISTS model_versions (
  version_id              TEXT PRIMARY KEY,   -- e.g. 'branchA_v1'
  trained_at              TIMESTAMPTZ,
  validation_sensitivity  REAL,
  validation_specificity  REAL,
  validation_kappa        REAL,
  promoted                BOOLEAN NOT NULL DEFAULT false,
  promoted_at             TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS patients (
  patient_id        TEXT PRIMARY KEY,   -- PHC-generated, e.g. 'PHC001-lz3k9f-a2x9'
  name              TEXT NOT NULL,
  age               INTEGER NOT NULL,
  contact_number    TEXT NOT NULL,      -- required: only channel for delayed results
  registered_at     TIMESTAMPTZ NOT NULL,

  patient_reference TEXT UNIQUE
);


CREATE TABLE IF NOT EXISTS cases (
  case_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id             TEXT NOT NULL REFERENCES patients(patient_id),
  phc_id                 UUID REFERENCES phc_sites(phc_id),
  capture_id_ref         TEXT,          -- traceability to the local capture_id
  camera_device_id       TEXT,          -- worker-reported (capture-metadata form)
  camera_family_detected TEXT,          -- image-derived (Task 6.3); NULL until then
  image_path             TEXT NOT NULL,
  questionnaire_data     JSONB,         -- patient symptom/risk answers
  capture_metadata       JSONB,         -- capture-context answers
  received_at            TIMESTAMPTZ NOT NULL DEFAULT now(),


  captured_at            TIMESTAMPTZ,

  
  status                 TEXT NOT NULL DEFAULT 'processing'
                         CHECK (status IN ('processing','graded','error'))
);


CREATE TABLE IF NOT EXISTS grading_results (
  result_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               UUID NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,

  -- Phase 2 (Task 2.7) -- populated now
  dr_grade_cnn          INTEGER CHECK (dr_grade_cnn BETWEEN 0 AND 4),
  referable             BOOLEAN,        -- dr_grade_cnn >= 2
  confidence_score      REAL,           -- POST-calibration: max(applyTemperature(...))
  conformal_tier        TEXT CHECK (conformal_tier IN ('A','B','C')),
  model_version         TEXT REFERENCES model_versions(version_id),
  graded_at             TIMESTAMPTZ,

  -- Phase 5 (Tasks 5.1/5.2) -- NULL until the rule engine ships
  dr_grade_rule_engine  INTEGER CHECK (dr_grade_rule_engine BETWEEN 0 AND 4),
  branch_agreement      BOOLEAN,

  -- Phase 6 (Task 6.1) -- NULL until MC-Dropout ships
  uncertainty_score     REAL,

  -- One grading result per case. gradingOrchestrator.js depends on this
  -- constraint for its INSERT ... ON CONFLICT (case_id) DO UPDATE re-grade path.
  UNIQUE (case_id)
);

CREATE TABLE IF NOT EXISTS segmentation_outputs (
  case_id            UUID PRIMARY KEY REFERENCES cases(case_id) ON DELETE CASCADE,
  lesion_masks_path  TEXT,
  lesion_counts      JSONB,  -- {"microaneurysms":6,...}, quadrant-mapped; feeds Branch B
  nv_suspicion_score REAL,   -- suspicion signal, NOT a validated detector (design §1.12)
  vessel_map_path    TEXT,
  optic_disc_x       REAL,
  optic_disc_y       REAL,
  fovea_x            REAL,
  fovea_y            REAL
);


CREATE TABLE IF NOT EXISTS explainability_outputs (
  case_id                            UUID PRIMARY KEY REFERENCES cases(case_id) ON DELETE CASCADE,

  -- Phase 2 (Task 2.7) -- populated now
  gradcam_path                       TEXT,

  -- Phase 7 (Task 7.1) -- NULL until the safeguards ship
  lesion_attention_consistency_score REAL,
  evidence_summary_text              TEXT
);


CREATE TABLE IF NOT EXISTS ophthalmologist_reviews (
  review_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                  UUID NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  ophthalmologist_id       TEXT,
  decision                 TEXT NOT NULL CHECK (decision IN ('confirm','override')),
  override_reason_category TEXT CHECK (override_reason_category IN
                             ('artifact_misread','lesion_missed',
                              'wrong_severity','image_quality_issue')),
  override_reason_text     TEXT,
  review_duration_seconds  INTEGER,
  reviewed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),


  CONSTRAINT override_requires_category CHECK (
    (decision = 'confirm'  AND override_reason_category IS NULL) OR
    (decision = 'override' AND override_reason_category IS NOT NULL)
  )
);

-- -----------------------------------------------------------------------------
-- 9. referrals -- loss-to-follow-up tracking
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referrals (
  referral_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         UUID NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  -- CONTRACT: status enum is referred -> contacted -> attended | lost.
  status          TEXT NOT NULL DEFAULT 'referred'
                  CHECK (status IN ('referred','contacted','attended','lost')),
  assigned_worker TEXT,                 -- ASHA / community health worker
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 10. notifications -- outbound SMS log
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      TEXT REFERENCES patients(patient_id),
  case_id         UUID REFERENCES cases(case_id) ON DELETE CASCADE,
  channel         TEXT,   -- 'sms'
  message_type    TEXT,   -- 'positive' | 'negative'
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 11. corrections -- links an override to the retraining run that consumed it
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corrections (
  correction_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               UUID REFERENCES cases(case_id) ON DELETE CASCADE,
  review_id             UUID REFERENCES ophthalmologist_reviews(review_id) ON DELETE CASCADE,
  used_in_model_version TEXT REFERENCES model_versions(version_id)
);

-- -----------------------------------------------------------------------------
-- 12. users -- role-based access for the central website (design doc §5.1)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('ophthalmologist','district_admin')),
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cases     ADD COLUMN IF NOT EXISTS captured_at   TIMESTAMPTZ;

ALTER TABLE cases     ADD COLUMN IF NOT EXISTS quality_scores JSONB;
ALTER TABLE phc_sites ADD COLUMN IF NOT EXISTS pending_count INTEGER NOT NULL DEFAULT 0;


ALTER TABLE notifications ADD COLUMN IF NOT EXISTS status              TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS error_detail        TEXT;


CREATE UNIQUE INDEX IF NOT EXISTS uq_referrals_case ON referrals(case_id);


CREATE INDEX IF NOT EXISTS idx_cases_patient     ON cases(patient_id);
CREATE INDEX IF NOT EXISTS idx_cases_status      ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_phc         ON cases(phc_id);
CREATE INDEX IF NOT EXISTS idx_cases_received_at ON cases(received_at);  -- casesToday
CREATE INDEX IF NOT EXISTS idx_grading_case      ON grading_results(case_id);
CREATE INDEX IF NOT EXISTS idx_grading_tier      ON grading_results(conformal_tier);
CREATE INDEX IF NOT EXISTS idx_reviews_case      ON ophthalmologist_reviews(case_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status  ON referrals(status);

