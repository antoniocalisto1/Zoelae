'use strict';
const express = require('express');
const { db } = require('./../db');
const config = require('./../config');
const sessions = require('./../lib/sessions');
const passcodes = require('./../lib/passcodes');
const tokens = require('./../lib/tokens');
const { userForClient } = require('./../lib/serialize');
const { requireCollector } = require('./../middleware/collectorAuth');
const throttle = require('./../lib/throttle');
const { ipHash } = require('./../lib/requestInfo');
const mailer = require('./../lib/mailer');
const emails = require('./../lib/emails');
const crypto = require('crypto');

const router = express.Router();

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const insertUser = db.prepare(`INSERT INTO users (public_id, email, password_hash, display_name, timezone, account_type, plan_tier, created_at, updated_at)
  VALUES (@public_id, @email, @password_hash, @display_name, @timezone, @account_type, @plan_tier, @now, @now)`);

const ACCOUNT_TYPES = ['artist', 'collector', 'gallery'];
const oneOf = (value, allowed) => (allowed.includes(String(value || '')) ? String(value) : null);
const touchLogin = db.prepare('UPDATE users SET login_count = login_count + 1, last_login_at = ?, timezone = COALESCE(?, timezone), updated_at = ? WHERE id = ?');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function startSession(res, user) {
  res.cookie(
    config.collectorCookie,
    sessions.sign({ uid: user.id, sv: user.session_version || 0 }, config.collectorSessionTtlMs),
    sessions.cookieOptions(config.collectorSessionTtlMs)
  );
}

const L = config.accountLimits;

/** Refuses with 429 when any of the given counters is full. Returns true when it answered. */
function tooMany(res, checks, what) {
  for (const [key, rule] of checks) {
    const state = throttle.peek(key, rule.limit, rule.windowMs);
    if (state.limited) {
      res.set('Retry-After', String(Math.ceil(state.retryAfterMs / 1000)));
      res.status(429).json({ error: 'rate_limited', message: `Too many ${what}. Please try again in ${throttle.humanWait(state.retryAfterMs)}.` });
      return true;
    }
  }
  return false;
}

router.post('/signup', (req, res) => {
  const signupKey = ['signup:ip:' + ipHash(req), L.signupPerAddress];
  if (tooMany(res, [signupKey], 'new accounts from this connection')) return;
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || '').trim();
  const timezone = String(req.body.timezone || '').slice(0, 64) || null;

  if (!EMAIL_RE.test(email)) return res.status(422).json({ error: 'invalid_email', message: 'Please enter a valid email address.' });
  if (displayName.length < 2) return res.status(422).json({ error: 'invalid_name', message: 'Please enter your name.' });
  if (password.length < passcodes.MIN_PASSWORD_LENGTH) {
    return res.status(422).json({ error: 'weak_password', message: `Password needs at least ${passcodes.MIN_PASSWORD_LENGTH} characters.` });
  }
  // Every account is one of three kinds. It shapes the app (galleries and artists get a client
  // list) and can be changed later in settings. There are no plans or tiers: everything is free.
  const accountType = oneOf(req.body.accountType, ACCOUNT_TYPES);
  if (!accountType) {
    return res.status(422).json({ error: 'invalid_account_type', message: 'Please choose an account type: collector, artist or gallery.' });
  }
  if (findByEmail.get(email)) return res.status(409).json({ error: 'email_taken', message: 'An account already exists for that email.' });

  throttle.hit(signupKey[0], L.signupPerAddress.windowMs);
  const now = new Date().toISOString();
  const info = insertUser.run({
    public_id: tokens.publicId('usr'), email, password_hash: passcodes.hash(password),
    display_name: displayName, timezone,
    account_type: accountType,
    plan_tier: null,
    now
  });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  touchLogin.run(now, timezone, now, user.id);
  startSession(res, user);
  res.status(201).json({ user: userForClient({ ...user, login_count: 1, last_login_at: now }), firstSignIn: true });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const timezone = String(req.body.timezone || '').slice(0, 64) || null;

  // Two counters: one per account, so nobody can guess a collector's password from many
  // addresses, and one per address, so one machine can't sweep through many accounts.
  const accountKey = ['login:acct:' + email, L.loginPerAccount];
  const addressKey = ['login:ip:' + ipHash(req), L.loginPerAddress];
  if (tooMany(res, [accountKey, addressKey], 'sign-in attempts')) return;

  const user = findByEmail.get(email);
  // Same generic answer whether the account is unknown or the password is wrong.
  if (!user || !passcodes.verify(password, user.password_hash)) {
    throttle.hit(accountKey[0], L.loginPerAccount.windowMs);
    throttle.hit(addressKey[0], L.loginPerAddress.windowMs);
    return res.status(401).json({ error: 'invalid_credentials', message: 'We don’t recognise that email and password.' });
  }
  throttle.clear(accountKey[0]);
  const firstSignIn = user.login_count === 0;
  const now = new Date().toISOString();
  touchLogin.run(now, timezone, now, user.id);
  startSession(res, user);
  res.json({
    user: userForClient({ ...user, login_count: user.login_count + 1, last_login_at: now, timezone: timezone || user.timezone }),
    firstSignIn
  });
});

router.post('/logout', (req, res) => {
  res.clearCookie(config.collectorCookie, { path: '/' });
  res.status(204).end();
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  res.json({ user: userForClient(req.user) });
});

router.patch('/me', requireCollector, (req, res) => {
  const displayName = String(req.body.displayName ?? req.user.display_name ?? '').trim();
  const timezone = String(req.body.timezone ?? req.user.timezone ?? '').slice(0, 64) || null;
  const accountType = req.body.accountType === undefined ? req.user.account_type : oneOf(req.body.accountType, ACCOUNT_TYPES);
  db.prepare('UPDATE users SET display_name = ?, timezone = ?, account_type = ?, updated_at = ? WHERE id = ?')
    .run(displayName || null, timezone, accountType, new Date().toISOString(), req.user.id);
  res.json({ user: userForClient(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// ---- Passwords ---------------------------------------------------------------------------------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const insertReset = db.prepare('INSERT INTO password_resets (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)');
const findReset = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?');
const useReset = db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?');
const retireResets = db.prepare('UPDATE password_resets SET used_at = COALESCE(used_at, ?) WHERE user_id = ?');
const setPassword = db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?');

const whenText = (d = new Date(), tz) => {
  try { return d.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: tz || 'UTC' }) + (tz ? '' : ' UTC'); }
  catch { return d.toISOString(); }
};

/**
 * Always answers the same way, so this can't be used to find out who has an account.
 * On a development machine the answer also points at the local outbox, where the email lands.
 */
router.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(422).json({ error: 'invalid_email', message: 'Please enter a valid email address.' });

  const accountKey = ['reset:acct:' + email, L.resetPerAccount];
  const addressKey = ['reset:ip:' + ipHash(req), L.resetPerAddress];
  if (tooMany(res, [addressKey], 'reset requests from this connection')) return;
  throttle.hit(addressKey[0], L.resetPerAddress.windowMs);

  const user = findByEmail.get(email);
  const accountFull = throttle.peek(accountKey[0], accountKey[1].limit, accountKey[1].windowMs).limited;
  if (user && !accountFull) {
    throttle.hit(accountKey[0], L.resetPerAccount.windowMs);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    insertReset.run(user.id, sha256(token), now.toISOString(), new Date(now.getTime() + config.passwordResetTtlMs).toISOString());
    const link = `${config.origin()}/reset?token=${token}`;
    await mailer.send({ to: user.email, ...emails.passwordReset({ name: user.display_name, link, minutes: Math.round(config.passwordResetTtlMs / 60000) }) });
  }
  res.json({
    ok: true,
    message: 'If there’s an account for that address, a reset link is on its way. It works for an hour.',
    ...(config.isProd || mailer.configured() ? {} : { outbox: '/dev/outbox' })
  });
});

/** Checks a link without using it, so the page can say early that it has expired. */
router.get('/reset/:token', (req, res) => {
  const row = findReset.get(sha256(String(req.params.token)));
  if (!row || row.used_at || row.expires_at < new Date().toISOString()) {
    return res.status(410).json({ error: 'reset_expired', message: 'This reset link has expired or has already been used. Ask for a new one.' });
  }
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(row.user_id);
  res.json({ ok: true, email: user?.email || null });
});

router.post('/reset', async (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (password.length < passcodes.MIN_PASSWORD_LENGTH) {
    return res.status(422).json({ error: 'weak_password', message: `Password needs at least ${passcodes.MIN_PASSWORD_LENGTH} characters.` });
  }
  const row = token && findReset.get(sha256(token));
  const nowIso = new Date().toISOString();
  if (!row || row.used_at || row.expires_at < nowIso) {
    return res.status(410).json({ error: 'reset_expired', message: 'This reset link has expired or has already been used. Ask for a new one.' });
  }
  db.transaction(() => {
    useReset.run(nowIso, row.id);
    retireResets.run(nowIso, row.user_id);          // any other outstanding links stop working too
    setPassword.run(passcodes.hash(password), nowIso, row.user_id);
  })();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  throttle.clear('login:acct:' + user.email);
  await mailer.send({ to: user.email, ...emails.passwordChanged({ name: user.display_name, when: whenText(new Date(), user.timezone) }) });

  touchLogin.run(nowIso, null, nowIso, user.id);
  startSession(res, user);
  res.json({ user: userForClient({ ...user, login_count: user.login_count + 1, last_login_at: nowIso }) });
});

/** Change password while signed in. Signs out every other device; this one stays signed in. */
router.post('/password', requireCollector, async (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  const key = ['pwchange:' + req.user.id, L.loginPerAccount];
  if (tooMany(res, [key], 'attempts')) return;
  if (!passcodes.verify(current, req.user.password_hash)) {
    throttle.hit(key[0], L.loginPerAccount.windowMs);
    return res.status(401).json({ error: 'invalid_credentials', message: 'Your current password isn’t right.' });
  }
  if (next.length < passcodes.MIN_PASSWORD_LENGTH) {
    return res.status(422).json({ error: 'weak_password', message: `Password needs at least ${passcodes.MIN_PASSWORD_LENGTH} characters.` });
  }
  const nowIso = new Date().toISOString();
  db.transaction(() => {
    setPassword.run(passcodes.hash(next), nowIso, req.user.id);
    retireResets.run(nowIso, req.user.id);
  })();
  throttle.clear(key[0]);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  await mailer.send({ to: user.email, ...emails.passwordChanged({ name: user.display_name, when: whenText(new Date(), user.timezone) }) });
  startSession(res, user);
  res.json({ ok: true, message: 'Password changed. Other devices have been signed out.' });
});

module.exports = router;
