'use strict';
const crypto = require('crypto');
const config = require('./../config');

/** Client IP, honouring X-Forwarded-For only when the app is started behind a trusted proxy. */
function clientIp(req) {
  return req.ip || req.connection?.remoteAddress || '0.0.0.0';
}

/** Salted SHA-256 — the access log records who came back, never a reversible address. */
function ipHash(req) {
  return crypto.createHash('sha256').update(config.ipHashSalt + '|' + clientIp(req)).digest('hex');
}

const userAgent = (req) => String(req.get('user-agent') || '').slice(0, 300);

module.exports = { clientIp, ipHash, userAgent };
