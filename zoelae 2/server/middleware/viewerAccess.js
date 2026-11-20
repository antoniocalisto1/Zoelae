'use strict';
// The single gate in front of every endpoint that serves shared data.
// It re-verifies, on each request: the slug exists, is not revoked, is not expired, has not hit its
// view limit, and that the caller holds a session issued for this exact slug and this exact share row.
const { db } = require('./../db');
const config = require('./../config');
const sessions = require('./../lib/sessions');
const { computeStatus, STATUS, UNAVAILABLE_BODY } = require('./../lib/shareState');

const findBySlug = db.prepare('SELECT * FROM shared_collections WHERE slug = ?');

const viewerCookieName = (slug) => config.viewerCookiePrefix + slug;

function issueViewerSession(res, share, viewNumber) {
  const token = sessions.sign(
    { slug: share.slug, sid: share.id, view: viewNumber, iat: Date.now() },
    config.viewerSessionTtlMs
  );
  res.cookie(viewerCookieName(share.slug), token, sessions.cookieOptions(config.viewerSessionTtlMs));
  return token;
}

function clearViewerSession(res, slug) {
  res.clearCookie(viewerCookieName(slug), { path: '/' });
}

/**
 * Resolves req.params.slug to req.share, or answers with the generic unavailable body.
 * A slug that does not exist and a slug that was revoked are indistinguishable from outside.
 */
function loadShare(req, res, next) {
  const slug = String(req.params.slug || '');
  const share = slug.length >= 22 ? findBySlug.get(slug) : null;
  const status = computeStatus(share);

  // A link that has hit its view limit is closed to new unlocks, but a viewer who already spent a
  // view keeps their session (see requireViewerSession); every other terminal state is refused here.
  const closed = !share || (status !== STATUS.ACTIVE && status !== STATUS.LIMIT_REACHED);
  if (closed) return res.status(share ? 410 : 404).json(UNAVAILABLE_BODY);

  req.share = share;
  req.shareStatus = status;
  next();
}

/** Refuses anything but a fully active share. Used by the unlock endpoint. */
function requireActiveShare(req, res, next) {
  if (req.shareStatus !== STATUS.ACTIVE) return res.status(410).json(UNAVAILABLE_BODY);
  next();
}

/**
 * Requires a viewer session bound to this share. Must always run after loadShare.
 * The token carries the view number it was issued against, so lowering (or reaching) the view
 * limit invalidates sessions beyond the allowance without evicting viewers already counted.
 */
function requireViewerSession(req, res, next) {
  const token = req.cookies?.[viewerCookieName(req.share.slug)] ||
    (req.get('x-zoelae-view-token') || '');
  const payload = sessions.verify(token);

  // Bound to one slug and one share row: a session for another collection is worthless here.
  if (!payload || payload.slug !== req.share.slug || payload.sid !== req.share.id) {
    return res.status(401).json({ error: 'passcode_required', message: 'Passcode required.' });
  }
  const max = req.share.max_views;
  if (max !== null && max !== undefined && (!payload.view || payload.view > max)) {
    return res.status(410).json(UNAVAILABLE_BODY);
  }
  req.viewerSession = payload;
  next();
}

module.exports = {
  loadShare, requireActiveShare, requireViewerSession,
  issueViewerSession, clearViewerSession, viewerCookieName, findBySlug
};
