'use strict';



const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.LOCAL_DB_PATH || path.join(__dirname, 'local.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new Database(DB_PATH);


db.pragma('journal_mode = WAL');


db.pragma('foreign_keys = ON');

db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing('captures', 'quality_scores', 'TEXT');
// Engine provenance: which engine ran the quality gate, as a JSON string.
addColumnIfMissing('captures', 'quality_engine', 'TEXT');
// Design doc §9.7: when the technician confirmed verbal consent (ISO-8601).
addColumnIfMissing('patients', 'consent_given_at', 'TEXT');
// Design doc §10.4: which eye this capture is of ('left' | 'right').
addColumnIfMissing('capture_metadata_responses', 'eye_laterality', 'TEXT');

// ── 2026-09-24: technician auth (design doc §11.1) ──────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS technicians (
    user_id       TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('technician', 'phc_admin')),
    password_hash TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  -- Opaque bearer tokens; only their SHA-256 is stored, so a copied database
  -- file does not hand out live sessions.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES technicians(user_id),
    device_id    TEXT,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS access_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    user_id     TEXT,
    device_id   TEXT,
    action      TEXT NOT NULL,
    entity_type TEXT,
    entity_id   TEXT
  );
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ── 2026-09-24: desktop <-> mobile offline sync (docs/peer-sync-protocol.md) ──
db.exec(`
  -- Phones paired with this PC. key_b64 is the 256-bit AES-GCM key shared at
  -- pairing (QR); every peer request and export bundle is sealed with it.
  CREATE TABLE IF NOT EXISTS peer_devices (
    device_id    TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    key_b64      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at   TEXT
  );
  -- Change feed: one row per insert/update of a synced record, written by the
  -- triggers below. A peer pulls "everything after seq N".
  CREATE TABLE IF NOT EXISTS change_log (
    seq    INTEGER PRIMARY KEY AUTOINCREMENT,
    tbl    TEXT NOT NULL,
    pk     TEXT NOT NULL,
    origin TEXT,
    at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_change_log_tbl_pk ON change_log(tbl, pk);
  -- Which peer's changes are being applied right now (NULL = made here), so the
  -- feed does not echo a phone's own records straight back to it.
  CREATE TABLE IF NOT EXISTS sync_ctx (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    origin TEXT
  );
  INSERT OR IGNORE INTO sync_ctx (id, origin) VALUES (1, NULL);
`);

addColumnIfMissing('patients', 'duplicate_of', 'TEXT');
addColumnIfMissing('patients', 'demographics_json', 'TEXT');
addColumnIfMissing('patients', 'questionnaire_json', 'TEXT');
addColumnIfMissing('patients', 'updated_at', 'TEXT');
addColumnIfMissing('patients', 'origin_device', 'TEXT');
addColumnIfMissing('captures', 'eye', 'TEXT');
addColumnIfMissing('captures', 'source', 'TEXT');
addColumnIfMissing('captures', 'best_effort', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('captures', 'image_bytes', 'INTEGER');
addColumnIfMissing('captures', 'image_sha256', 'TEXT');
addColumnIfMissing('captures', 'origin_device', 'TEXT');
addColumnIfMissing('sync_queue', 'central_case_id', 'TEXT');
addColumnIfMissing('sync_queue', 'central_status', 'TEXT');
addColumnIfMissing('sync_queue', 'owner_device', 'TEXT');
addColumnIfMissing('sync_queue', 'updated_at', 'TEXT');
// 2026-09-26: why a capture is still pending, so a rejection is visible instead of
// an endless silent retry. error_kind is 'network' | 'rejected' (central answered 4xx)
// | 'server' (5xx / unusable answer); next_attempt_at backs off rejected/server rows.
addColumnIfMissing('sync_queue', 'last_error', 'TEXT');
addColumnIfMissing('sync_queue', 'error_kind', 'TEXT');
addColumnIfMissing('sync_queue', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('sync_queue', 'next_attempt_at', 'TEXT');

const SYNCED_TABLES = {
  patients: 'patient_id',
  captures: 'capture_id',
  questionnaire_responses: 'response_id',
  capture_metadata_responses: 'response_id',
  sync_queue: 'capture_id',
};
for (const [tbl, pk] of Object.entries(SYNCED_TABLES)) {
  for (const op of ['INSERT', 'UPDATE']) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${tbl}_${op.toLowerCase()}_log AFTER ${op} ON ${tbl}
      BEGIN
        INSERT INTO change_log (tbl, pk, origin, at)
        VALUES ('${tbl}', NEW.${pk}, (SELECT origin FROM sync_ctx WHERE id = 1),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      END;
    `);
  }
}

function kvGet(key) {
  const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return r ? r.value : null;
}
function kvSet(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// This PC's identity in the peer protocol, minted once.
if (!kvGet('device_id')) kvSet('device_id', `pc-${crypto.randomBytes(6).toString('hex')}`);

// Records that existed before the change feed get one feed entry each, once,
// so a phone pairing for the first time pulls the whole local history.
if (!kvGet('change_log_backfilled')) {
  db.transaction(() => {
    for (const [tbl, pk] of Object.entries(SYNCED_TABLES)) {
      db.prepare(`INSERT INTO change_log (tbl, pk, origin, at) SELECT ?, ${pk}, NULL, ? FROM ${tbl}`)
        .run(tbl, new Date().toISOString());
    }
    kvSet('change_log_backfilled', '1');
  })();
}

db.kvGet = kvGet;
db.kvSet = kvSet;
db.SYNCED_TABLES = SYNCED_TABLES;
db.deviceId = () => kvGet('device_id');

module.exports = db;
