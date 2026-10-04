'use strict';



const fs = require('fs');
const path = require('path');

const DB_DIR = path.resolve(__dirname, '..', 'phc-local-app', 'backend', 'db');
const DB_PATH = path.join(DB_DIR, 'local.sqlite');

const RESET = process.argv.includes('--reset');

if (RESET) {
  console.warn('[setupLocalDb] --reset given: deleting local.sqlite and all its rows.');

  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`[setupLocalDb] removed ${path.basename(p)}`);
    }
  }
}


const db = require(path.join(DB_DIR, 'localDb.js'));

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

console.log(`[setupLocalDb] Database ready at ${DB_PATH}`);
console.log(`[setupLocalDb] ${tables.length} tables present:`);
for (const t of tables) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get();
  console.log(`    - ${t} (${n} rows)`);
}

db.close();
