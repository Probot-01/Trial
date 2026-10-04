

ALTER TABLE phc_sites
  ADD COLUMN IF NOT EXISTS phc_code TEXT,
  ADD COLUMN IF NOT EXISTS district TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_phc_sites_phc_code
  ON phc_sites (phc_code) WHERE phc_code IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS uq_phc_sites_phc_code;
ALTER TABLE phc_sites DROP COLUMN IF EXISTS district;
ALTER TABLE phc_sites DROP COLUMN IF EXISTS phc_code;
