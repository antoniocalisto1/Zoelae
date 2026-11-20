'use strict';
// One place decides whether a share is still usable. Every public endpoint calls it again,
// on every request, using the server clock and the current row — never a cached or client value.

const STATUS = { ACTIVE: 'active', EXPIRED: 'expired', REVOKED: 'revoked', LIMIT_REACHED: 'limit_reached' };

function computeStatus(share, now = Date.now()) {
  if (!share) return STATUS.REVOKED;
  if (share.revoked_at) return STATUS.REVOKED;
  if (share.expires_at && Date.parse(share.expires_at) <= now) return STATUS.EXPIRED;
  if (share.max_views !== null && share.max_views !== undefined && share.view_count >= share.max_views) {
    return STATUS.LIMIT_REACHED;
  }
  return STATUS.ACTIVE;
}

const isAvailable = (share, now) => computeStatus(share, now) === STATUS.ACTIVE;

/**
 * A viewer already past the gate must not learn why a link stopped working, and an attacker
 * must not learn whether a slug exists at all, so both cases return the same shape.
 */
const UNAVAILABLE_BODY = {
  error: 'unavailable',
  message: 'This collection is no longer available. Please contact the owner for access.'
};

module.exports = { STATUS, computeStatus, isAvailable, UNAVAILABLE_BODY };
