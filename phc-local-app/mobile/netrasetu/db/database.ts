
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'netrasetu.db';

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS patients (
    patient_id        TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    age               INTEGER NOT NULL,
    contact_number    TEXT NOT NULL,
    consent_given_at  TEXT,
    duplicate_of      TEXT REFERENCES patients(patient_id),
    registered_at     TEXT NOT NULL,
    demographics_json TEXT,
    questionnaire_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_patients_registered ON patients(registered_at DESC);

  CREATE TABLE IF NOT EXISTS captures (
    capture_id          TEXT PRIMARY KEY,
    patient_id          TEXT NOT NULL REFERENCES patients(patient_id),
    eye                 TEXT,
    camera_device_id    TEXT NOT NULL,
    source              TEXT NOT NULL,
    image_path          TEXT NOT NULL,
    image_bytes         INTEGER,
    quality_status      TEXT NOT NULL,
    quality_reason      TEXT,
    quality_scores_json TEXT,
    retake_count        INTEGER NOT NULL DEFAULT 0,
    best_effort         INTEGER NOT NULL DEFAULT 0,
    captured_at         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_captures_patient ON captures(patient_id, captured_at);
  CREATE INDEX IF NOT EXISTS idx_captures_time ON captures(captured_at DESC);

  CREATE TABLE IF NOT EXISTS questionnaire_responses (
    response_id        TEXT PRIMARY KEY,
    capture_id         TEXT NOT NULL REFERENCES captures(capture_id),
    risk_factor_fields TEXT NOT NULL,
    symptom_fields     TEXT NOT NULL,
    language           TEXT,
    recorded_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS capture_metadata_responses (
    response_id             TEXT PRIMARY KEY,
    capture_id              TEXT NOT NULL REFERENCES captures(capture_id),
    camera_device_reported  TEXT,
    pupil_status            TEXT NOT NULL,
    lighting_environment    TEXT NOT NULL,
    observed_issues         TEXT NOT NULL,
    worker_usability_rating TEXT NOT NULL,
    eye_laterality          TEXT,
    recorded_at             TEXT NOT NULL
  );

  -- One row per capture that is going to central. 'state' is this device's
  -- side of the handshake; 'central_status' is the last status central
  -- reported for the case. "Synced" means central ACCEPTED the image
  -- (state = 'synced'), never merely that a request returned (§4.4).
  CREATE TABLE IF NOT EXISTS sync_queue (
    capture_id       TEXT PRIMARY KEY REFERENCES captures(capture_id),
    priority_tier    INTEGER NOT NULL,
    state            TEXT NOT NULL,
    central_case_id  TEXT,
    central_status   TEXT,
    summary_sent_at  TEXT,
    uploaded_at      TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TEXT,
    last_attempt_at  TEXT,
    last_error_code  TEXT,
    last_error       TEXT,
    enqueued_at      TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sync_order ON sync_queue(state, priority_tier, enqueued_at);
  `,

  `
  ALTER TABLE patients ADD COLUMN updated_at TEXT;
  ALTER TABLE patients ADD COLUMN origin_device TEXT;
  ALTER TABLE captures ADD COLUMN origin_device TEXT;
  ALTER TABLE captures ADD COLUMN image_sha256 TEXT;
  ALTER TABLE sync_queue ADD COLUMN owner_device TEXT;
  UPDATE patients SET updated_at = registered_at WHERE updated_at IS NULL;

  CREATE TABLE IF NOT EXISTS change_log (
    seq    INTEGER PRIMARY KEY AUTOINCREMENT,
    tbl    TEXT NOT NULL,
    pk     TEXT NOT NULL,
    origin TEXT,
    at     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_ctx (id INTEGER PRIMARY KEY CHECK (id = 1), origin TEXT);
  INSERT OR IGNORE INTO sync_ctx (id, origin) VALUES (1, NULL);
  CREATE TABLE IF NOT EXISTS peer_images_sent (capture_id TEXT PRIMARY KEY, sent_at TEXT NOT NULL);

  ${['patients:patient_id', 'captures:capture_id', 'questionnaire_responses:response_id',
    'capture_metadata_responses:response_id', 'sync_queue:capture_id'].map((spec) => {
      const [tbl, pk] = spec.split(':');
      return ['INSERT', 'UPDATE'].map((op) => `
  CREATE TRIGGER IF NOT EXISTS trg_${tbl}_${op.toLowerCase()}_log AFTER ${op} ON ${tbl}
  BEGIN
    INSERT INTO change_log (tbl, pk, origin, at)
    VALUES ('${tbl}', NEW.${pk}, (SELECT origin FROM sync_ctx WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;`).join('\n');
    }).join('\n')}

  INSERT INTO change_log (tbl, pk, origin, at) SELECT 'patients', patient_id, NULL, registered_at FROM patients;
  INSERT INTO change_log (tbl, pk, origin, at) SELECT 'captures', capture_id, NULL, captured_at FROM captures;
  INSERT INTO change_log (tbl, pk, origin, at) SELECT 'questionnaire_responses', response_id, NULL, recorded_at FROM questionnaire_responses;
  INSERT INTO change_log (tbl, pk, origin, at) SELECT 'capture_metadata_responses', response_id, NULL, recorded_at FROM capture_metadata_responses;
  INSERT INTO change_log (tbl, pk, origin, at) SELECT 'sync_queue', capture_id, NULL, enqueued_at FROM sync_queue;
  `,

  `
  ALTER TABLE captures ADD COLUMN quality_engine TEXT;
  UPDATE captures SET quality_engine = '{"engine":"js-device","fallback":false,"detail":"qualityGate.ts, the TypeScript port of qualityGateMain.m, run on the phone"}'
    WHERE origin_device IS NULL AND quality_engine IS NULL;
  `,
];

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      let version = row?.user_version ?? 0;
      while (version < MIGRATIONS.length) {
        await db.withTransactionAsync(async () => {
          await db.execAsync(MIGRATIONS[version]);
        });
        version += 1;
        await db.execAsync(`PRAGMA user_version = ${version}`);
      }
      return db;
    })();
  }
  return dbPromise;
}

export async function kvGet(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function kvSet(key: string, value: string | null): Promise<void> {
  const db = await getDb();
  if (value === null) {
    await db.runAsync('DELETE FROM kv WHERE key = ?', [key]);
  } else {
    await db.runAsync(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value]);
  }
}

export const nowIso = () => new Date().toISOString();
