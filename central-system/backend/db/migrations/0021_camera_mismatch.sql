

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS camera_mismatch BOOLEAN;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS camera_expected_family TEXT;

COMMENT ON COLUMN cases.camera_mismatch IS
  'Reported device vs detected camera family: true = disagreed, false = agreed, '
  'NULL = the cross-check could not run (device not reported, or not in '
  'deviceAssociations). NULL is never "agreed".';

COMMENT ON COLUMN cases.camera_expected_family IS
  'The camera family the worker-reported device implies, i.e. the other side of '
  'the camera_mismatch comparison. NULL whenever camera_mismatch is NULL.';

-- Down Migration
ALTER TABLE cases DROP COLUMN IF EXISTS camera_expected_family;
ALTER TABLE cases DROP COLUMN IF EXISTS camera_mismatch;
