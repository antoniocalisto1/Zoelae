'use strict';
const { db } = require('./../db');
const config = require('./../config');
const sessions = require('./../lib/sessions');

const findById = db.prepare('SELECT * FROM users WHERE id = ?');

/** Attaches req.user when a valid collector session cookie is present. Never throws. */
function loadCollector(req, _res, next) {
  req.user = null;
  const payload = sessions.verify(req.cookies?.[config.collectorCookie]);
  if (payload && payload.uid) {
    const user = findById.get(payload.uid);
    // A token minted before the last password change carries an older version and stops working.
    if (user && (payload.sv || 0) === (user.session_version || 0)) req.user = user;
  }
  next();
}

/** Guards every collector endpoint. Authorization is decided here, never in the browser. */
function requireCollector(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated', message: 'Please sign in.' });
  next();
}

module.exports = { loadCollector, requireCollector };
