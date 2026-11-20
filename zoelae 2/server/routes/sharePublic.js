'use strict';
// The public side of a shared collection. Nothing in here trusts the client:
// the share row is re-read and re-checked on every request, and every field that reaches the
// response has been explicitly permitted by the collector's visibility toggles.
const express = require('express');
const fs = require('fs');
const { db } = require('./../db');
const passcodes = require('./../lib/passcodes');
const uploads = require('./../lib/uploads');
const images = require('./../lib/images');
const rateLimit = require('./../middleware/rateLimit');
const { ipHash, userAgent } = require('./../lib/requestInfo');
const { artworkForViewer } = require('./../lib/serialize');
const { UNAVAILABLE_BODY } = require('./../lib/shareState');
const {
  loadShare, requireActiveShare, requireViewerSession, issueViewerSession
} = require('./../middleware/viewerAccess');

const router = express.Router();

const q = {
  owner: db.prepare('SELECT display_name FROM users WHERE id = ?'),
  items: db.prepare(`SELECT i.public_id, i.sort_order, i.artwork_id FROM shared_collection_items i
    WHERE i.shared_collection_id = ? ORDER BY i.sort_order, i.id`),
  itemByPublicId: db.prepare('SELECT * FROM shared_collection_items WHERE public_id = ? AND shared_collection_id = ?'),
  artwork: db.prepare('SELECT * FROM artworks WHERE id = ?'),
  images: db.prepare('SELECT * FROM artwork_images WHERE artwork_id = ? ORDER BY sort_order, id'),
  documents: db.prepare('SELECT * FROM artwork_documents WHERE artwork_id = ? ORDER BY id'),
  logAccess: db.prepare(`INSERT INTO shared_collection_access_log (shared_collection_id, accessed_at, ip_hash, user_agent, success)
    VALUES (?, ?, ?, ?, ?)`),
  bumpViews: db.prepare('UPDATE shared_collections SET view_count = view_count + 1, updated_at = ? WHERE id = ?'),
  reread: db.prepare('SELECT * FROM shared_collections WHERE id = ?'),
  imageInShare: db.prepare(`SELECT img.* FROM artwork_images img
    JOIN shared_collection_items it ON it.artwork_id = img.artwork_id
    WHERE img.public_id = ? AND it.shared_collection_id = ?`),
  documentInShare: db.prepare(`SELECT doc.* FROM artwork_documents doc
    JOIN shared_collection_items it ON it.artwork_id = doc.artwork_id
    WHERE doc.public_id = ? AND it.shared_collection_id = ?`)
};

const ownerName = (share) => (q.owner.get(share.owner_id)?.display_name || 'A collector');

router.use((_req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/**
 * Gate metadata. Deliberately the only thing an un-authenticated caller can read, and it carries
 * no artwork data, no thumbnails, not even how many pieces are in the collection.
 */
router.get('/:slug/meta', loadShare, requireActiveShare, (req, res) => {
  res.json({ title: req.share.title, ownerName: ownerName(req.share) });
});

router.post('/:slug/unlock', loadShare, requireActiveShare, (req, res) => {
  const share = req.share;
  const hash = ipHash(req);
  const now = new Date().toISOString();
  const limit = rateLimit.check(hash, share.slug);

  if (limit.limited) {
    q.logAccess.run(share.id, now, hash, userAgent(req), 0);
    const minutes = Math.ceil(limit.retryAfterMs / 60000);
    res.setHeader('Retry-After', Math.ceil(limit.retryAfterMs / 1000));
    return res.status(429).json({
      error: 'rate_limited',
      message: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
    });
  }

  const ok = passcodes.verify(String(req.body.passcode || ''), share.passcode_hash);
  q.logAccess.run(share.id, now, hash, userAgent(req), ok ? 1 : 0);

  if (!ok) {
    rateLimit.recordFailure(hash, share.slug);
    // Identical response whether the passcode is wrong, the slug is unknown, or the link is dead.
    return res.status(401).json({ error: 'invalid_passcode', message: 'That passcode isn’t right.' });
  }

  rateLimit.clearFailures(hash, share.slug);
  // One increment per successful passcode entry — page renders never touch this counter.
  q.bumpViews.run(now, share.id);
  const viewNumber = q.reread.get(share.id).view_count;
  issueViewerSession(res, share, viewNumber);
  res.json({ ok: true });
});

/** Everything below requires a session issued for this exact slug. */
const gated = [loadShare, requireViewerSession];

/**
 * The viewer client is told one thing only: whether downloads are allowed. It infers everything
 * else from which fields are present, so no response carries so much as the *name* of a gated
 * field when that field is switched off.
 */
function permissions(share) {
  return { downloads: !!share.allow_downloads };
}

function projectItem(share, item) {
  const artwork = q.artwork.get(item.artwork_id);
  if (!artwork) return null;
  return artworkForViewer({
    item, artwork, share,
    images: q.images.all(artwork.id),
    documents: share.show_documents ? q.documents.all(artwork.id) : []
  });
}

router.get('/:slug/collection', gated, (req, res) => {
  const share = req.share;
  const items = q.items.all(share.id).map(item => projectItem(share, item)).filter(Boolean);
  res.json({
    title: share.title,
    introMessage: share.intro_message || '',
    ownerName: ownerName(share),
    permissions: permissions(share),
    items
  });
});

router.get('/:slug/items/:itemId', gated, (req, res) => {
  const item = q.itemByPublicId.get(req.params.itemId, req.share.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const projected = projectItem(req.share, item);
  if (!projected) return res.status(404).json({ error: 'not_found' });
  res.json({ item: projected, permissions: permissions(req.share) });
});

function streamFile(res, row, { attachment = false, filename = 'file' } = {}) {
  let abs;
  try { abs = uploads.absolutePath(row.file_path); } catch { return res.status(404).end(); }
  if (!fs.existsSync(abs)) return res.status(404).end();
  uploads.protectiveHeaders(res);
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `${attachment ? 'attachment' : 'inline'}; filename="${filename.replace(/["\\]/g, '')}"`);
  fs.createReadStream(abs).pipe(res);
}

// Images are only ever reachable through this route, which re-checks the share and the session.
// Uploaded files have no static URL, so turning downloads off cannot be bypassed by guessing a path.
router.get('/:slug/images/:imageId', gated, (req, res) => {
  const row = q.imageInShare.get(req.params.imageId, req.share.id);
  if (!row) return res.status(404).end();
  const wantsDownload = req.query.download === '1';
  if (wantsDownload && !req.share.allow_downloads) return res.status(403).json(UNAVAILABLE_BODY);
  // Viewers see the display copy. The full-resolution original only leaves on a permitted download.
  const size = wantsDownload ? 'original' : (req.query.size === 'thumb' ? 'thumb' : 'display');
  streamFile(res, images.variantOf(row, size), { attachment: wantsDownload, filename: row.public_id });
});

router.get('/:slug/documents/:documentId', gated, (req, res) => {
  if (!req.share.show_documents) return res.status(403).json({ error: 'not_permitted' });
  const row = q.documentInShare.get(req.params.documentId, req.share.id);
  if (!row) return res.status(404).end();
  const wantsDownload = req.query.download === '1';
  if (wantsDownload && !req.share.allow_downloads) return res.status(403).json(UNAVAILABLE_BODY);
  streamFile(res, row, { attachment: wantsDownload, filename: row.label });
});

module.exports = router;
