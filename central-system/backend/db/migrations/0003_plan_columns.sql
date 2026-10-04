
ALTER TABLE phc_sites ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMPTZ;

-- §M: when the patient gave consent, as captured by the PHC app.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS consent_given_at TIMESTAMPTZ;


ALTER TABLE grading_results
  ADD COLUMN IF NOT EXISTS claimed_by UUID REFERENCES users(user_id);
ALTER TABLE grading_results ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE segmentation_outputs ADD COLUMN IF NOT EXISTS fovea_unreliable BOOLEAN;

-- §O: path of the generated PDF clinical-rationale report.
ALTER TABLE explainability_outputs ADD COLUMN IF NOT EXISTS rationale_report_path TEXT;

-- Down Migration
ALTER TABLE explainability_outputs DROP COLUMN IF EXISTS rationale_report_path;
ALTER TABLE segmentation_outputs   DROP COLUMN IF EXISTS fovea_unreliable;
ALTER TABLE grading_results        DROP COLUMN IF EXISTS claimed_at;
ALTER TABLE grading_results        DROP COLUMN IF EXISTS claimed_by;
ALTER TABLE patients               DROP COLUMN IF EXISTS consent_given_at;
ALTER TABLE phc_sites              DROP COLUMN IF EXISTS last_contact_at;
