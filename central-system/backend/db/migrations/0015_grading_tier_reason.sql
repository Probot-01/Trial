

ALTER TABLE grading_results
  ADD COLUMN IF NOT EXISTS tier_reason TEXT;

COMMENT ON COLUMN grading_results.tier_reason IS
  'Why this case got its conformal_tier: the escalation that fired, or the floor that raised it from A. NULL for rows graded before migration 0015, which means "not recorded", not "no reason".';

-- Down Migration
ALTER TABLE grading_results
  DROP COLUMN IF EXISTS tier_reason;
