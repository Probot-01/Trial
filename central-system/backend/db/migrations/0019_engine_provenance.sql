

ALTER TABLE grading_results
  ADD COLUMN IF NOT EXISTS engine_provenance JSONB;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS quality_gate_engine JSONB;

-- Down Migration
ALTER TABLE cases DROP COLUMN IF EXISTS quality_gate_engine;
ALTER TABLE grading_results DROP COLUMN IF EXISTS engine_provenance;
