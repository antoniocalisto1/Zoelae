'use strict';
// npm run backup — a consistent copy of the database plus every uploaded file, in one dated folder.
//
// The database copy uses SQLite's online backup, so it is safe while the server is running.
// Uploaded files never change once written, so a plain copy is consistent too. The newest
// BACKUP_KEEP backups are kept (14 by default); older ones are removed.
//
// A backup on the same disk protects against mistakes, not against losing the disk. On a host,
// point BACKUP_DIR at a separate volume, or copy the newest folder somewhere else afterwards.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { db, migrate } = require('./db');

async function main() {
  migrate({ log: () => {} });
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
  const dir = path.join(config.backupDir, `zoelae-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const started = Date.now();
  await db.backup(path.join(dir, 'zoelae.db'));
  let files = 0;
  if (fs.existsSync(config.uploadsDir)) {
    fs.cpSync(config.uploadsDir, path.join(dir, 'uploads'), { recursive: true });
    const count = (d) => fs.readdirSync(d, { withFileTypes: true })
      .reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
    files = count(path.join(dir, 'uploads'));
  }
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const works = db.prepare('SELECT COUNT(*) AS c FROM artworks').get().c;
  fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify({
    createdAt: new Date().toISOString(), accounts: users, works, files,
    restore: 'Stop the server, copy zoelae.db over DATABASE_FILE and uploads/ over UPLOADS_DIR, start again.'
  }, null, 2));

  // Keep the newest N.
  const all = fs.readdirSync(config.backupDir).filter(n => n.startsWith('zoelae-')).sort();
  const old = all.slice(0, Math.max(0, all.length - config.backupKeep));
  for (const name of old) fs.rmSync(path.join(config.backupDir, name), { recursive: true, force: true });

  console.log(`Backed up ${users} account(s), ${works} work(s) and ${files} file(s) to ${dir} in ${Date.now() - started} ms.`);
  if (old.length) console.log(`Removed ${old.length} older backup(s); keeping ${config.backupKeep}.`);
}

main().catch(err => { console.error(`Backup failed: ${err.message}`); process.exit(1); });
