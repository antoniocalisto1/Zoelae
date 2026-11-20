'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** Applies any migration file in migrations/ that has not run yet, in filename order. */
function migrate({ log = console.log } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(db.prepare('SELECT filename FROM schema_migrations').all().map(r => r.filename));
  const files = fs.readdirSync(config.migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const record = db.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)');
  let count = 0;

  // Foreign keys are disabled for the duration of a migration so that the table-rebuild
  // pattern SQLite requires for a schema change does not cascade-delete child rows.
  // PRAGMA foreign_keys is a no-op inside a transaction, so it has to be set out here.
  const pending = files.filter(f => !applied.has(f));
  if (!pending.length) return 0;

  db.pragma('foreign_keys = OFF');
  try {
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(config.migrationsDir, file), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        record.run(file, new Date().toISOString());
      })();

      const violations = db.pragma('foreign_key_check');
      if (violations.length) {
        throw new Error(`${file} left ${violations.length} foreign key violation(s); database not modified further.`);
      }
      log(`  applied ${file}`);
      count++;
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return count;
}

module.exports = { db, migrate };
