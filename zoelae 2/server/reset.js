'use strict';
// Destroys the local database and every uploaded file. Development only.
//
// Refuses outright when NODE_ENV is production. Anywhere else it shows what would be lost and
// needs `--yes` before it deletes accounts that exist.
const fs = require('fs');
const path = require('path');
const config = require('./config');

if (config.isProd) {
  console.error('Refusing to reset: NODE_ENV is production. This command deletes every account and file.');
  process.exit(1);
}

let accounts = 0;
let works = 0;
if (fs.existsSync(config.dbFile)) {
  try {
    const db = require('better-sqlite3')(config.dbFile, { readonly: true });
    accounts = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    works = db.prepare('SELECT COUNT(*) AS c FROM artworks').get().c;
    db.close();
  } catch { /* an empty or half-made database */ }
}

if (accounts && !process.argv.includes('--yes')) {
  console.error(`This would delete ${accounts} account(s) and ${works} work(s) in ${config.dbFile}, and every uploaded file.`);
  console.error('Run `npm run reset -- --yes` if that is what you want. Consider `npm run backup` first.');
  process.exit(1);
}

for (const f of [config.dbFile, config.dbFile + '-wal', config.dbFile + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f);
}
if (fs.existsSync(config.uploadsDir)) fs.rmSync(config.uploadsDir, { recursive: true, force: true });
if (fs.existsSync(config.outboxDir)) fs.rmSync(config.outboxDir, { recursive: true, force: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });
fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
console.log('Database, uploads and outbox removed. The next `npm start` begins with an empty site.');
