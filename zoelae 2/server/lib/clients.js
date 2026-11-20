'use strict';
// A gallery's (or an artist's) client list. Owned by one account, never shown to viewers.
const { db } = require('./../db');
const tokens = require('./tokens');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const str = (v, max) => String(v ?? '').trim().slice(0, max);

class ClientError extends Error {}

/** Validates and normalises a client from a form or a sheet row. Throws ClientError. */
function clientFields(body) {
  const f = {
    name: str(body.name, 200),
    email: str(body.email, 200).toLowerCase(),
    phone: str(body.phone, 60),
    company: str(body.company, 200),
    city: str(body.city, 120),
    country: str(body.country, 120),
    interests: str(body.interests, 1000),
    notes: str(body.notes, 4000)
  };
  if (!f.name) throw new ClientError('Please give the client a name.');
  if (f.email && !EMAIL_RE.test(f.email)) throw new ClientError('That email address doesn’t look right.');
  for (const k of Object.keys(f)) if (f[k] === '') f[k] = null;
  return f;
}

const insertStmt = db.prepare(`INSERT INTO clients
  (public_id, owner_id, name, email, phone, company, city, country, interests, notes, created_at, updated_at)
  VALUES (@public_id, @owner_id, @name, @email, @phone, @company, @city, @country, @interests, @notes, @now, @now)`);

function insertClient(fields, ownerId) {
  const now = new Date().toISOString();
  return insertStmt.run({ ...fields, public_id: tokens.publicId('cli'), owner_id: ownerId, now }).lastInsertRowid;
}

const byEmail = db.prepare('SELECT id FROM clients WHERE owner_id = ? AND email = ?');
const byName = db.prepare('SELECT id FROM clients WHERE owner_id = ? AND lower(name) = lower(?)');
/** The same person already on the list: same email, or same name when there's no email. */
function findExisting(fields, ownerId) {
  if (fields.email) return byEmail.get(ownerId, fields.email) || null;
  return byName.get(ownerId, fields.name) || null;
}

module.exports = { clientFields, insertClient, findExisting, ClientError, EMAIL_RE };
