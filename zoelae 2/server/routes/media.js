'use strict';
// Collector-owned file streaming. Ownership is re-checked on every request; there is no static route.
const express = require('express');
const fs = require('fs');
const { db } = require('./../db');
const uploads = require('./../lib/uploads');
const images = require('./../lib/images');
const { requireCollector } = require('./../middleware/collectorAuth');

// Guarded per route rather than with router.use, so mounting this at /api cannot swallow
// sibling routes (the public /api/s/* endpoints pass through the same prefix).
const router = express.Router();

const imageQuery = db.prepare(`SELECT i.* FROM artwork_images i
  JOIN artworks a ON a.id = i.artwork_id
  WHERE i.public_id = ? AND a.owner_id = ?`);

const documentQuery = db.prepare(`SELECT d.* FROM artwork_documents d
  JOIN artworks a ON a.id = d.artwork_id
  WHERE d.public_id = ? AND a.owner_id = ?`);

function send(res, row, { disposition = 'inline', filename = 'file' } = {}) {
  let abs;
  try { abs = uploads.absolutePath(row.file_path); } catch { return res.status(404).end(); }
  if (!fs.existsSync(abs)) return res.status(404).end();
  uploads.protectiveHeaders(res);
  res.setHeader('Content-Type', row.mime_type);
  // Stored files never change (a new upload gets a new name), so the browser can keep them.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename.replace(/["\\]/g, '')}"`);
  fs.createReadStream(abs).pipe(res);
}

router.get('/images/:publicId', requireCollector, (req, res) => {
  const row = imageQuery.get(req.params.publicId, req.user.id);
  if (!row) return res.status(404).end();
  const size = ['thumb', 'display', 'original'].includes(req.query.size) ? req.query.size : 'display';
  send(res, images.variantOf(row, size), {
    disposition: req.query.download === '1' ? 'attachment' : 'inline',
    filename: row.public_id
  });
});

router.get('/documents/:publicId', requireCollector, (req, res) => {
  const row = documentQuery.get(req.params.publicId, req.user.id);
  if (!row) return res.status(404).end();
  send(res, row, { disposition: req.query.download === '1' ? 'attachment' : 'inline', filename: row.label });
});

module.exports = router;
