'use strict';
// Fixed-window counters for the account endpoints: sign-in, sign-up, password reset.
// In memory, like the passcode limiter: right for one process. If Zoelae ever runs as several
// processes, these counters move to the database or a shared store.

const windows = new Map();   // key -> { count, start }

function sweep(now) {
  for (const [k, w] of windows) if (now - w.start > w.windowMs) windows.delete(k);
}

/** Current state of a key without counting anything. */
function peek(key, limit, windowMs, now = Date.now()) {
  const w = windows.get(key);
  if (!w || now - w.start > windowMs) return { limited: false, retryAfterMs: 0 };
  return { limited: w.count >= limit, retryAfterMs: w.count >= limit ? w.start + windowMs - now : 0 };
}

/** Count one event against a key. */
function hit(key, windowMs, now = Date.now()) {
  if (windows.size > 20000) sweep(now);
  const w = windows.get(key);
  if (!w || now - w.start > windowMs) windows.set(key, { count: 1, start: now, windowMs });
  else w.count += 1;
}

const clear = (key) => windows.delete(key);
const reset = () => windows.clear();

/** "about 12 minutes", for messages. */
function humanWait(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return m === 1 ? 'a minute' : `${m} minutes`;
}

module.exports = { peek, hit, clear, reset, humanWait };
