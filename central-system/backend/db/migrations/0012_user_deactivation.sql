
ALTER TABLE grading_results DROP CONSTRAINT IF EXISTS grading_results_claimed_by_fkey;
ALTER TABLE grading_results
  ADD CONSTRAINT grading_results_claimed_by_fkey
  FOREIGN KEY (claimed_by) REFERENCES users(user_id) ON DELETE SET NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE users DROP COLUMN IF EXISTS deactivated_at;
ALTER TABLE users DROP COLUMN IF EXISTS is_active;
ALTER TABLE grading_results DROP CONSTRAINT IF EXISTS grading_results_claimed_by_fkey;
ALTER TABLE grading_results
  ADD CONSTRAINT grading_results_claimed_by_fkey
  FOREIGN KEY (claimed_by) REFERENCES users(user_id);
