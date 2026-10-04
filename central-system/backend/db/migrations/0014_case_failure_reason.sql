
ALTER TABLE cases ADD COLUMN IF NOT EXISTS failure_code   TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS failed_at      TIMESTAMPTZ;

-- The dashboard asks for recent failures grouped by cause; a partial index
-- keeps that off a sequential scan without indexing the graded majority.
CREATE INDEX IF NOT EXISTS idx_cases_failed
  ON cases (failed_at DESC) WHERE status = 'error';

-- Down Migration
DROP INDEX IF EXISTS idx_cases_failed;
ALTER TABLE cases DROP COLUMN IF EXISTS failed_at;
ALTER TABLE cases DROP COLUMN IF EXISTS failure_reason;
ALTER TABLE cases DROP COLUMN IF EXISTS failure_code;
