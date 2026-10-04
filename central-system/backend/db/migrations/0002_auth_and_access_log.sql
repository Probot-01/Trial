
ALTER TABLE phc_sites ADD COLUMN IF NOT EXISTS api_key_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_phc_sites_api_key_hash
  ON phc_sites(api_key_hash) WHERE api_key_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS access_log (
  log_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(user_id),
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  "timestamp"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_access_log_user     ON access_log(user_id, "timestamp");
CREATE INDEX IF NOT EXISTS idx_access_log_resource ON access_log(resource_type, resource_id);

-- Down Migration
DROP TABLE IF EXISTS access_log;
DROP INDEX IF EXISTS uq_phc_sites_api_key_hash;
ALTER TABLE phc_sites DROP COLUMN IF EXISTS api_key_hash;
