'use strict';
// Collector-facing shared-collection management. Everything here requires a collector session,
// and every artwork referenced is validated against the signed-in collector's own rows.
const express = require('express');
const { db } = require('./../db');
const tokens = require('./../lib/tokens');
const passcodes = require('./../lib/passcodes');
const { shareForOwner } = require('./../lib/serialize');
const { computeStatus } = require('./../lib/shareState');
const { requireCollector } = require('./../middleware/collectorAuth');
const config = require('./../config');

const router = express.Router();
router.use(requireCollector);

const q = {
  listByOwner: db.prepare('SELECT * FROM shared_collections WHERE owner_id = ? ORDER BY created_at DESC'),
  bySlugForOwner: db.prepare('SELECT * FROM shared_collections WHERE slug = ? AND owner_id = ?'),
  itemCount: db.prepare('SELECT COUNT(*) AS c FROM shared_collection_items WHERE shared_collection_id = ?'),
  items: db.prepare(`SELECT i.public_id, i.sort_order, a.public_id AS artwork_public_id, a.title, a.artist, a.year_created, a.type
    FROM shared_collection_items i JOIN artworks a ON a.id = i.artwork_id
    WHERE i.shared_collection_id = ? ORDER BY i.sort_order, i.id`),
  firstImage: db.prepare('SELECT public_id FROM artwork_images WHERE artwork_id = (SELECT id FROM artworks WHERE public_id = ?) ORDER BY sort_order, id LIMIT 1'),
  insertItem: db.prepare('INSERT INTO shared_collection_items (public_id, shared_collection_id, artwork_id, sort_order) VALUES (?, ?, ?, ?)'),
  clearItems: db.prepare('DELETE FROM shared_collection_items WHERE shared_collection_id = ?'),
  accessLog: db.prepare(`SELECT accessed_at, ip_hash, user_agent, success FROM shared_collection_access_log
    WHERE shared_collection_id = ? ORDER BY accessed_at DESC LIMIT 200`)
};

const PRESETS = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };

/** Expiry is always computed on the server clock; a client may only propose a custom date. */
function resolveExpiry(body) {
  const preset = String(body.expiresPreset || 'never');
  if (preset === 'never') return null;
  if (PRESETS[preset]) return new Date(Date.now() + PRESETS[preset]).toISOString();
  if (preset === 'custom' && body.expiresAt) {
    const t = Date.parse(body.expiresAt);
    if (!Number.isFinite(t)) throw new HttpError(422, 'Please choose a valid expiry date.');
    if (t <= Date.now()) throw new HttpError(422, 'The expiry date needs to be in the future.');
    return new Date(t).toISOString();
  }
  return null;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Resolves the submitted artwork public ids to internal ids, in the submitted order.
 * A public id that does not belong to this collector is a hard failure — nothing is written.
 */
function resolveOwnedArtworks(ownerId, artworkIds) {
  const ids = [...new Set((artworkIds || []).map(String))];
  if (!ids.length) throw new HttpError(422, 'Choose at least one piece to share.');
  if (ids.length > 250) throw new HttpError(422, 'A shared collection can hold up to 250 pieces.');

  const lookup = db.prepare('SELECT id, public_id FROM artworks WHERE public_id = ? AND owner_id = ?');
  return ids.map(publicId => {
    const row = lookup.get(publicId, ownerId);
    if (!row) throw new HttpError(403, 'One of those pieces is not in your collection.');
    return row.id;
  });
}

function readFlags(body, existing = {}) {
  const bool = (v, fallback) => (v === undefined ? (fallback ? 1 : 0) : (v === true || v === 'true' || v === 1 || v === '1') ? 1 : 0);
  return {
    show_prices: bool(body.showPrices, existing.show_prices),
    show_documents: bool(body.showDocuments, existing.show_documents),
    show_provenance: bool(body.showProvenance, existing.show_provenance),
    show_location: bool(body.showLocation, existing.show_location),
    allow_downloads: bool(body.allowDownloads, existing.allow_downloads)
  };
}

function readMaxViews(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(422, 'A view limit must be a whole number of 1 or more.');
  return n;
}

const shareUrlFor = (req, slug) => `${config.publicOrigin || `${req.protocol}://${req.get('host')}`}/s/${slug}`;

function decorate(share) {
  return shareForOwner(share, {
    itemCount: q.itemCount.get(share.id).c,
    status: computeStatus(share)
  });
}

router.get('/', (req, res) => {
  res.json({ shares: q.listByOwner.all(req.user.id).map(decorate) });
});

router.post('/', (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (!title) throw new HttpError(422, 'Please give the shared collection a title.');

    const passcode = String(req.body.passcode || '');
    if (passcode.length < passcodes.MIN_PASSCODE_LENGTH) {
      throw new HttpError(422, `The passcode needs at least ${passcodes.MIN_PASSCODE_LENGTH} characters.`);
    }

    const artworkIds = resolveOwnedArtworks(req.user.id, req.body.artworkIds);
    const flags = readFlags(req.body);
    const expiresAt = resolveExpiry(req.body);
    const maxViews = readMaxViews(req.body.maxViews);
    const now = new Date().toISOString();

    const slug = tokens.shareSlug();
    const created = db.transaction(() => {
      const info = db.prepare(`INSERT INTO shared_collections
        (owner_id, slug, title, intro_message, passcode_hash, show_prices, show_documents, show_provenance,
         show_location, allow_downloads, expires_at, max_views, view_count, revoked_at, created_at, updated_at)
        VALUES (@owner_id, @slug, @title, @intro_message, @passcode_hash, @show_prices, @show_documents,
         @show_provenance, @show_location, @allow_downloads, @expires_at, @max_views, 0, NULL, @now, @now)`)
        .run({
          owner_id: req.user.id, slug, title,
          intro_message: String(req.body.introMessage || '').trim().slice(0, 1000) || null,
          passcode_hash: passcodes.hash(passcode),
          ...flags, expires_at: expiresAt, max_views: maxViews, now
        });
      artworkIds.forEach((artworkId, i) =>
        q.insertItem.run(tokens.publicId('itm'), info.lastInsertRowid, artworkId, i));
      return db.prepare('SELECT * FROM shared_collections WHERE id = ?').get(info.lastInsertRowid);
    })();

    // The passcode is never echoed back — the collector keeps what they typed.
    res.status(201).json({ share: decorate(created), shareUrl: shareUrlFor(req, created.slug) });
  } catch (err) { next(err); }
});

router.get('/:slug', (req, res) => {
  const share = q.bySlugForOwner.get(req.params.slug, req.user.id);
  if (!share) return res.status(404).json({ error: 'not_found' });
  const items = q.items.all(share.id).map(item => ({
    id: item.public_id,
    artworkId: item.artwork_public_id,
    title: item.title,
    artist: item.artist,
    year: item.year_created,
    type: item.type,
    sortOrder: item.sort_order,
    thumbUrl: (() => {
      const img = q.firstImage.get(item.artwork_public_id);
      return img ? `/api/images/${img.public_id}` : null;
    })()
  }));
  res.json({ share: decorate(share), items, shareUrl: shareUrlFor(req, share.slug) });
});

router.patch('/:slug', (req, res, next) => {
  try {
    const share = q.bySlugForOwner.get(req.params.slug, req.user.id);
    if (!share) return res.status(404).json({ error: 'not_found' });

    const title = req.body.title === undefined ? share.title : String(req.body.title).trim().slice(0, 200);
    if (!title) throw new HttpError(422, 'Please give the shared collection a title.');

    const flags = readFlags(req.body, share);
    const expiresAt = req.body.expiresPreset === undefined ? share.expires_at : resolveExpiry(req.body);
    const maxViews = req.body.maxViews === undefined ? share.max_views : readMaxViews(req.body.maxViews);
    const intro = req.body.introMessage === undefined
      ? share.intro_message
      : String(req.body.introMessage).trim().slice(0, 1000) || null;

    const artworkIds = req.body.artworkIds === undefined ? null : resolveOwnedArtworks(req.user.id, req.body.artworkIds);

    db.transaction(() => {
      db.prepare(`UPDATE shared_collections SET title=@title, intro_message=@intro, show_prices=@show_prices,
        show_documents=@show_documents, show_provenance=@show_provenance, show_location=@show_location,
        allow_downloads=@allow_downloads, expires_at=@expires_at, max_views=@max_views, updated_at=@now
        WHERE id=@id`)
        .run({ ...flags, title, intro, expires_at: expiresAt, max_views: maxViews, id: share.id, now: new Date().toISOString() });

      if (artworkIds) {
        q.clearItems.run(share.id);
        artworkIds.forEach((artworkId, i) => q.insertItem.run(tokens.publicId('itm'), share.id, artworkId, i));
      }
    })();

    res.json({ share: decorate(db.prepare('SELECT * FROM shared_collections WHERE id = ?').get(share.id)) });
  } catch (err) { next(err); }
});

router.post('/:slug/passcode', (req, res, next) => {
  try {
    const share = q.bySlugForOwner.get(req.params.slug, req.user.id);
    if (!share) return res.status(404).json({ error: 'not_found' });
    const passcode = String(req.body.passcode || '');
    if (passcode.length < passcodes.MIN_PASSCODE_LENGTH) {
      throw new HttpError(422, `The passcode needs at least ${passcodes.MIN_PASSCODE_LENGTH} characters.`);
    }
    db.prepare('UPDATE shared_collections SET passcode_hash = ?, updated_at = ? WHERE id = ?')
      .run(passcodes.hash(passcode), new Date().toISOString(), share.id);
    // Existing viewer sessions stay valid until they expire; the new passcode governs new unlocks.
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:slug/revoke', (req, res) => {
  const share = q.bySlugForOwner.get(req.params.slug, req.user.id);
  if (!share) return res.status(404).json({ error: 'not_found' });
  const now = new Date().toISOString();
  db.prepare('UPDATE shared_collections SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?')
    .run(now, now, share.id);
  res.json({ share: decorate(db.prepare('SELECT * FROM shared_collections WHERE id = ?').get(share.id)) });
});

router.delete('/:slug', (req, res) => {
  const share = q.bySlugForOwner.get(req.params.slug, req.user.id);
  if (!share) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM shared_collections WHERE id = ?').run(share.id);  // cascades items + access log
  res.status(204).end();
});

router.get('/:slug/access-log', (req, res) => {
  const share = q.bySlugForOwner.get(req.params.slug, req.user.id);
  if (!share) return res.status(404).json({ error: 'not_found' });
  res.json({
    entries: q.accessLog.all(share.id).map(row => ({
      accessedAt: row.accessed_at,
      // A short prefix is enough to recognise a repeat visitor without storing or showing an address.
      visitor: row.ip_hash ? row.ip_hash.slice(0, 8) : '—',
      userAgent: row.user_agent || '',
      success: !!row.success
    }))
  });
});

router.use((err, _req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: 'invalid', message: err.message });
  next(err);
});

module.exports = router;
