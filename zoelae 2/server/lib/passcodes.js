'use strict';
// Passcode and password hashing. bcrypt only — plain text is never stored, logged or returned.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./../config');

const MIN_PASSCODE_LENGTH = 6;
const MIN_PASSWORD_LENGTH = 8;

const hash = (plain) => bcrypt.hashSync(String(plain), config.bcryptRounds);

/**
 * bcrypt.compareSync already compares the derived hashes byte-by-byte, but it short-circuits on
 * a malformed hash, so we additionally run a constant-time comparison over the two digests.
 */
function verify(plain, storedHash) {
  if (typeof plain !== 'string' || typeof storedHash !== 'string' || storedHash.length === 0) {
    bcrypt.compareSync('timing-equaliser', '$2b$12$' + 'x'.repeat(53)); // keep the failure path costly
    return false;
  }
  let candidate;
  try {
    candidate = bcrypt.hashSync(plain, storedHash); // re-hash with the stored salt and cost
  } catch {
    return false;
  }
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { hash, verify, MIN_PASSCODE_LENGTH, MIN_PASSWORD_LENGTH };
