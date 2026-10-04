
CREATE TABLE IF NOT EXISTS system_alerts (
  alert_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL,             -- e.g. 'matlab_session_down'
  subject       TEXT NOT NULL DEFAULT '',  -- what it is about, '' when global
  message       TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrences   INTEGER NOT NULL DEFAULT 1,
  resolved_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_system_alerts_open
  ON system_alerts(kind, subject) WHERE resolved_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS system_alerts;
