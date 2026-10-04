
ALTER TABLE cases ADD COLUMN IF NOT EXISTS eye_laterality_reported TEXT
  CHECK (eye_laterality_reported IN ('left', 'right'));
ALTER TABLE cases ADD COLUMN IF NOT EXISTS eye_laterality_detected TEXT
  CHECK (eye_laterality_detected IN ('left', 'right'));

-- Down Migration
ALTER TABLE cases DROP COLUMN IF EXISTS eye_laterality_detected;
ALTER TABLE cases DROP COLUMN IF EXISTS eye_laterality_reported;
