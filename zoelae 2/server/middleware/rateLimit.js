'use strict';
// Passcode-gate rate limiting, keyed by hashed IP + share slug.
// In-memory on purpose: one process, no extra dependency. See README for the multi-process note.
const config = require('./../config');

const buckets = new Map(); // key -> { attempts: number, first: ms, lockedUntil: ms|null }

function key(ipHash, slug) { return `${ipHash}:${slug}`; }

function sweep(now) {
  for (const [k, b] of buckets) {
    const dead = (b.lockedUntil || 0) < now && now - b.first > config.rateLimit.windowMs;
    if (dead) buckets.delete(k);
  }
}

/** @returns {{limited:boolean, retryAfterMs:number, remaining:number}} */
function check(ipHash, slug, now = Date.now()) {
  if (buckets.size > 5000) sweep(now);
  const b = buckets.get(key(ipHash, slug));
  if (!b) return { limited: false, retryAfterMs: 0, remaining: config.rateLimit.maxAttempts };
  if (b.lockedUntil && b.lockedUntil > now) {
    return { limited: true, retryAfterMs: b.lockedUntil - now, remaining: 0 };
  }
  if (now - b.first > config.rateLimit.windowMs) {
    buckets.delete(key(ipHash, slug));
    return { limited: false, retryAfterMs: 0, remaining: config.rateLimit.maxAttempts };
  }
  return {
    limited: false,
    retryAfterMs: 0,
    remaining: Math.max(0, config.rateLimit.maxAttempts - b.attempts)
  };
}

/** Records one failed attempt and locks the bucket once the allowance is spent. */
function recordFailure(ipHash, slug, now = Date.now()) {
  const k = key(ipHash, slug);
  const b = buckets.get(k) || { attempts: 0, first: now, lockedUntil: null };
  if (now - b.first > config.rateLimit.windowMs) { b.attempts = 0; b.first = now; b.lockedUntil = null; }
  b.attempts += 1;
  if (b.attempts >= config.rateLimit.maxAttempts) b.lockedUntil = now + config.rateLimit.lockoutMs;
  buckets.set(k, b);
  return b;
}

const clearFailures = (ipHash, slug) => buckets.delete(key(ipHash, slug));
const reset = () => buckets.clear();

module.exports = { check, recordFailure, clearFailures, reset };
