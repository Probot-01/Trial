
ALTER TABLE cases ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
UPDATE cases SET processing_started_at = received_at WHERE processing_started_at IS NULL;

-- Down Migration
ALTER TABLE cases DROP COLUMN IF EXISTS processing_started_at;
