'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';

// Development fallbacks keep `npm start` zero-config. They are refused in production.
const DEV_SESSION_SECRET = 'zoelae-development-session-secret-do-not-use-in-production';
const DEV_IP_HASH_SALT = 'zoelae-development-ip-salt';

const config = {
  isProd,
  // The name and home shown across the site and in emails. Renaming is this one setting.
  siteName: process.env.SITE_NAME || 'Zoelae',
  sitePlace: process.env.SITE_PLACE || 'Lisbon',
  // At launch every account has everything, documents included, and nothing is charged.
  // The billing code stays dormant; BILLING=on would switch it on once payments exist.
  freeBeta: process.env.BILLING !== 'on',
  port: Number(process.env.PORT || 3000),
  root: ROOT,
  // Builds before the rename kept the database in data/artcave.db; a copy on this machine keeps working.
  dbFile: process.env.DATABASE_FILE || (() => {
    const fresh = path.join(ROOT, 'data', 'zoelae.db');
    const older = path.join(ROOT, 'data', 'artcave.db');
    return !fs.existsSync(fresh) && fs.existsSync(older) ? older : fresh;
  })(),
  migrationsDir: path.join(ROOT, 'migrations'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(ROOT, 'data', 'uploads'),
  publicDir: path.join(ROOT, 'public'),
  sessionSecret: process.env.SESSION_SECRET || DEV_SESSION_SECRET,
  ipHashSalt: process.env.IP_HASH_SALT || DEV_IP_HASH_SALT,
  publicOrigin: process.env.PUBLIC_ORIGIN || null,

  // collector session
  collectorCookie: 'zoelae_session',
  collectorSessionTtlMs: 7 * 24 * 60 * 60 * 1000,

  // viewer session — scoped to exactly one slug, short-lived by design
  viewerCookiePrefix: 'zoelae_view_',
  viewerSessionTtlMs: 2 * 60 * 60 * 1000,

  // passcode gate rate limiting
  rateLimit: { maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000 },

  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  maxUploadBytes: 25 * 1024 * 1024,

  // account endpoints: sign-in, sign-up and password reset
  accountLimits: {
    loginPerAccount: { limit: 5, windowMs: 15 * 60 * 1000 },     // wrong passwords for one email, from anywhere
    loginPerAddress: { limit: 20, windowMs: 15 * 60 * 1000 },    // wrong passwords from one address, any email
    signupPerAddress: { limit: 10, windowMs: 60 * 60 * 1000 },
    resetPerAccount: { limit: 3, windowMs: 60 * 60 * 1000 },
    resetPerAddress: { limit: 10, windowMs: 60 * 60 * 1000 }
  },
  passwordResetTtlMs: 60 * 60 * 1000,
  // emails to clients: keeps one account from turning the site into a mailing list
  clientMail: { perDay: Number(process.env.CLIENT_MAIL_PER_DAY || 100), perSend: 25 },

  // email: sent through Postmark when a server token is set, otherwise written to the outbox
  postmarkToken: process.env.POSTMARK_SERVER_TOKEN || null,
  mailFrom: process.env.MAIL_FROM || `${process.env.SITE_NAME || 'Zoelae'} <hello@zoelae.local>`,
  outboxDir: process.env.OUTBOX_DIR || path.join(ROOT, 'data', 'outbox'),

  // spreadsheet imports wait here for up to a day while columns are matched
  importDir: process.env.IMPORT_DIR || path.join(ROOT, 'data', 'imports'),
  importZipMaxBytes: Number(process.env.IMPORT_ZIP_MAX_MB || 300) * 1024 * 1024,

  backupDir: process.env.BACKUP_DIR || path.join(ROOT, 'data', 'backups'),
  backupKeep: Number(process.env.BACKUP_KEEP || 14)
};

/** The site's own address. Reset links are built from this, never from a request's Host header. */
config.origin = () => config.publicOrigin || `http://localhost:${config.port}`;

if (isProd) {
  if (config.sessionSecret === DEV_SESSION_SECRET) throw new Error('SESSION_SECRET must be set in production.');
  if (config.ipHashSalt === DEV_IP_HASH_SALT) throw new Error('IP_HASH_SALT must be set in production.');
  if (!config.publicOrigin) throw new Error('PUBLIC_ORIGIN must be set in production, e.g. https://zoelae.com.');
}

module.exports = config;
