'use strict';
// Stateless HMAC-signed session tokens. Nothing in a token is trusted until the signature verifies,
// and every route re-checks the current database state on top of whatever the token claims.
const crypto = require('crypto');
const config = require('./../config');

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function signature(body) {
  return crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
}

/** @returns {string} `<payload>.<hmac>` */
function sign(payload, ttlMs) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  return `${body}.${signature(body)}`;
}

/** @returns {object|null} the payload, or null if the token is missing, tampered with, or expired. */
function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const body = token.slice(0, idx);
  const provided = token.slice(idx + 1);

  const expected = signature(body);
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  // Server clock only — a wrong client clock cannot extend a session.
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

const cookieOptions = (maxAgeMs) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
  path: '/',
  maxAge: maxAgeMs
});

module.exports = { sign, verify, cookieOptions };
