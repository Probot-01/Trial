

ALTER TABLE grading_results
  ADD COLUMN IF NOT EXISTS urgency_score  INTEGER
    CONSTRAINT grading_results_urgency_score_range
    CHECK (urgency_score IS NULL OR (urgency_score BETWEEN 1 AND 100)),
  ADD COLUMN IF NOT EXISTS urgency_factor TEXT,
  ADD COLUMN IF NOT EXISTS urgency_inputs JSONB;

COMMENT ON COLUMN grading_results.urgency_score IS
  'Triage urgency 1-100 from calculateUrgencyScore.m. QUEUE ORDERING ONLY -- the model is trained on SYNTHETIC data and has never been validated against an outcome. NULL means not computed (missing clinical inputs), never low urgency.';

COMMENT ON COLUMN grading_results.urgency_factor IS
  'Which input contributed most for this patient, by exact Shapley attribution over the four inputs.';

COMMENT ON COLUMN grading_results.urgency_inputs IS
  'Exactly what went into the score, each value tagged measured or assumed, so the number can be explained and reproduced later.';

-- Down Migration
ALTER TABLE grading_results
  DROP CONSTRAINT IF EXISTS grading_results_urgency_score_range,
  DROP COLUMN IF EXISTS urgency_score,
  DROP COLUMN IF EXISTS urgency_factor,
  DROP COLUMN IF EXISTS urgency_inputs;
