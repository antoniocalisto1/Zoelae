'use strict';
// Random identifiers and passcodes. Everything here uses crypto.randomBytes — never Math.random.
const crypto = require('crypto');

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes

/** Uniform random string over ALPHABET, rejection-sampled so every character is equally likely. */
function randomString(length) {
  const out = [];
  const max = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte >= max) continue;               // reject, to avoid modulo bias
      out.push(ALPHABET[byte % ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/** Unguessable share slug. 28 chars over a 56-char alphabet ≈ 162 bits of entropy. */
const shareSlug = () => randomString(28);

/** Opaque public identifier for a row, so internal integer ids never reach a client. */
const publicId = (prefix) => `${prefix}_${randomString(16)}`;

const PASSCODE_WORDS = [
  'amber', 'atlas', 'basalt', 'cedar', 'cobalt', 'copper', 'crimson', 'delta', 'ember', 'fresco',
  'gallery', 'granite', 'harbour', 'indigo', 'ivory', 'lantern', 'linen', 'marble', 'meadow', 'mosaic',
  'onyx', 'opal', 'pigment', 'quartz', 'russet', 'sable', 'saffron', 'sienna', 'slate', 'studio',
  'terra', 'umber', 'vault', 'velvet', 'walnut', 'willow'
];

/** Readable passcode a collector can say out loud, e.g. "amber-vault-7412". */
function readablePasscode() {
  const pick = () => PASSCODE_WORDS[crypto.randomInt(PASSCODE_WORDS.length)];
  let a = pick(), b = pick();
  while (b === a) b = pick();
  return `${a}-${b}-${crypto.randomInt(1000, 10000)}`;
}

module.exports = { randomString, shareSlug, publicId, readablePasscode };
