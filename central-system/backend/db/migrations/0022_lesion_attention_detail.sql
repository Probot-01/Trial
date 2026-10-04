



ALTER TABLE explainability_outputs
  ADD COLUMN IF NOT EXISTS lesion_attention_chance_level DOUBLE PRECISION;

ALTER TABLE explainability_outputs
  ADD COLUMN IF NOT EXISTS lesion_attention_enrichment DOUBLE PRECISION;

ALTER TABLE explainability_outputs
  ADD COLUMN IF NOT EXISTS lesion_attention_flagged BOOLEAN;

COMMENT ON COLUMN explainability_outputs.lesion_attention_chance_level IS
  'Lesion area / ROI area: what a random heatmap would score on this eye. The '
  'consistency score must be read against this, never alone.';

COMMENT ON COLUMN explainability_outputs.lesion_attention_enrichment IS
  'consistency score / chance level. 1.0 = chance, >1 = real attention.';

COMMENT ON COLUMN explainability_outputs.lesion_attention_flagged IS
  'enrichment not strictly greater than 1.0, i.e. the heatmap told us no more '
  'than a uniform one would. Also true when the heatmap had no energy at all.';

-- Down Migration
ALTER TABLE explainability_outputs DROP COLUMN IF EXISTS lesion_attention_flagged;
ALTER TABLE explainability_outputs DROP COLUMN IF EXISTS lesion_attention_enrichment;
ALTER TABLE explainability_outputs DROP COLUMN IF EXISTS lesion_attention_chance_level;
