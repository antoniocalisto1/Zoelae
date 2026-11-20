'use strict';
const express = require('express');
const fs = require('fs');
const { db } = require('./../db');
const tokens = require('./../lib/tokens');
const uploads = require('./../lib/uploads');
const images = require('./../lib/images');
const { artworkForOwner, imageForOwner, documentForOwner } = require('./../lib/serialize');
const { requireCollector } = require('./../middleware/collectorAuth');

const router = express.Router();
router.use(requireCollector);

const TYPES = ['Painting', 'Sculpture', 'Work on paper', 'Print', 'Photography', 'Other'];
const STATUSES = ['collection', 'for_sale', 'sold'];
const DOCUMENT_KINDS = ['certificate', 'appraisal', 'invoice', 'condition_report', 'other'];

const q = {
  listByOwner: db.prepare('SELECT * FROM artworks WHERE owner_id = ? ORDER BY created_at DESC'),
  byPublicId: db.prepare('SELECT * FROM artworks WHERE public_id = ? AND owner_id = ?'),
  imagesFor: db.prepare('SELECT * FROM artwork_images WHERE artwork_id = ? ORDER BY sort_order, id'),
  documentsFor: db.prepare('SELECT * FROM artwork_documents WHERE artwork_id = ? ORDER BY id'),
  insertImage: db.prepare(`INSERT INTO artwork_images (public_id, artwork_id, file_path, display_path, thumb_path, width, height, mime_type, byte_size, sort_order, created_at)
    VALUES (@public_id, @artwork_id, @file_path, @display_path, @thumb_path, @width, @height, @mime_type, @byte_size, @sort_order, @created_at)`),
  insertDocument: db.prepare(`INSERT INTO artwork_documents (public_id, artwork_id, kind, label, file_path, mime_type, byte_size, created_at)
    VALUES (@public_id, @artwork_id, @kind, @label, @file_path, @mime_type, @byte_size, @created_at)`),
  maxImageOrder: db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM artwork_images WHERE artwork_id = ?')
};

/** A buyer can only be one of the owner's own clients. Unknown ids are dropped, not trusted. */
const clientByPublicId = db.prepare('SELECT id FROM clients WHERE public_id = ? AND owner_id = ?');
function resolveBuyer(fields, body, ownerId) {
  fields.sold_to_client_id = fields.status === 'sold' && body.soldTo
    ? (clientByPublicId.get(String(body.soldTo), ownerId)?.id ?? null) : null;
  if (fields.status !== 'sold') { fields.sold_price = null; fields.sold_at = null; }
  if (fields.status !== 'for_sale') fields.asking_price = null;
  return fields;
}

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max) || null;

const clientById = db.prepare('SELECT public_id, name FROM clients WHERE id = ? AND owner_id = ?');
function withFiles(row) {
  const sold_to = row.sold_to_client_id ? clientById.get(row.sold_to_client_id, row.owner_id) : null;
  return artworkForOwner({ ...row, sold_to }, q.imagesFor.all(row.id), q.documentsFor.all(row.id));
}

router.get('/', (req, res) => {
  res.json({ artworks: q.listByOwner.all(req.user.id).map(withFiles) });
});

router.get('/:publicId', (req, res) => {
  const row = q.byPublicId.get(req.params.publicId, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ artwork: withFiles(row) });
});

function readFields(body) {
  const year = num(body.year);
  const type = TYPES.includes(body.type) ? body.type : 'Painting';
  const status = STATUSES.includes(body.status) ? body.status : 'collection';
  return {
    status,
    inventory_number: str(body.inventoryNumber, 60),
    asking_price: num(body.askingPrice),
    sold_price: num(body.soldPrice),
    sold_at: str(body.soldAt, 40),
    sold_to_client_id: null,            // resolved from body.soldTo against the owner's clients
    title: str(body.title, 200),
    artist: str(body.artist, 200),
    year_created: year,
    type,
    medium: str(body.medium, 200),
    dimensions: str(body.dimensions, 120),
    purchase_price: num(body.purchasePrice),
    currency: str(body.currency, 8) || 'EUR',
    current_valuation: num(body.currentValuation),
    insured_value: num(body.insuredValue),
    valuation_date: str(body.valuationDate, 40),
    acquired_at: str(body.acquiredAt, 40),
    acquired_from: str(body.acquiredFrom, 300),
    provenance: str(body.provenance, 4000),
    prior_owners: str(body.priorOwners, 2000),
    exhibition_history: str(body.exhibitionHistory, 4000),
    storage_location: str(body.storageLocation, 300),
    notes: str(body.notes, 4000)
  };
}

function validate(fields) {
  if (!fields.title) return 'Please give the work a title.';
  for (const k of ['asking_price', 'sold_price', 'purchase_price', 'current_valuation', 'insured_value']) {
    if (fields[k] !== null && fields[k] < 0) return 'Prices can’t be negative.';
  }
  if (!fields.artist) return 'Please name the artist.';
  // The year is optional — plenty of pieces arrive without one — but if given it must be real.
  const y = fields.year_created;
  if (y !== null && (!Number.isInteger(y) || y < 0 || y > new Date().getFullYear())) {
    return `Please enter a valid year, up to ${new Date().getFullYear()}.`;
  }
  return null;
}

// Files arrive as multipart: `images` (repeatable) and `documents` (repeatable, with documentKinds/documentLabels).
const fileFields = uploads.upload.fields([{ name: 'images', maxCount: 8 }, { name: 'documents', maxCount: 8 }]);

/**
 * Decode, orient, strip and resize every uploaded file before anything is written, so one unreadable
 * file refuses the whole request instead of leaving a half-saved work behind.
 */
async function prepareFiles(files, body) {
  const out = { images: [], documents: [] };
  for (const file of files?.images || []) {
    if (!uploads.IMAGE_TYPES.has(file.mimetype)) {
      throw new images.ImageError(`“${file.originalname || 'That file'}” isn’t a JPEG, PNG, WebP, GIF or SVG image.`);
    }
    out.images.push(await images.processImage(file.buffer, file.mimetype));
  }
  const kinds = [].concat(body.documentKinds || []);
  const labels = [].concat(body.documentLabels || []);
  for (const [i, file] of (files?.documents || []).entries()) {
    if (!uploads.DOCUMENT_TYPES.has(file.mimetype)) {
      throw new images.ImageError(`“${file.originalname || 'That document'}” isn’t a PDF or an image.`);
    }
    const clean = await images.stripDocumentImage(file.buffer, file.mimetype);
    out.documents.push({
      ...clean,
      kind: DOCUMENT_KINDS.includes(kinds[i]) ? kinds[i] : 'other',
      label: str(labels[i], 200) || file.originalname || 'Document'
    });
  }
  return out;
}

function attachFiles(artworkId, prepared) {
  const now = new Date().toISOString();
  let order = q.maxImageOrder.get(artworkId).m + 1;
  for (const p of prepared.images) {
    q.insertImage.run({
      public_id: tokens.publicId('img'), artwork_id: artworkId,
      file_path: uploads.writeFile(p.original.buffer, p.original.mime),
      display_path: uploads.writeFile(p.display.buffer, p.display.mime),
      thumb_path: uploads.writeFile(p.thumb.buffer, p.thumb.mime),
      width: p.width, height: p.height,
      mime_type: p.original.mime, byte_size: p.original.buffer.length, sort_order: order++, created_at: now
    });
  }
  for (const d of prepared.documents) {
    q.insertDocument.run({
      public_id: tokens.publicId('doc'), artwork_id: artworkId, kind: d.kind, label: d.label,
      file_path: uploads.writeFile(d.buffer, d.mime),
      mime_type: d.mime, byte_size: d.buffer.length, created_at: now
    });
  }
}

/** Express 4 doesn't catch rejected promises; this does, and turns unreadable files into a 422. */
const handle = (fn) => (req, res, next) => fn(req, res, next).catch(err => {
  if (err instanceof images.ImageError) return res.status(422).json({ error: 'invalid_file', message: err.message });
  next(err);
});

const insertStmt = db.prepare(`INSERT INTO artworks
    (public_id, owner_id, title, artist, year_created, type, medium, dimensions,
     purchase_price, currency, current_valuation, insured_value, valuation_date,
     acquired_at, acquired_from, provenance, prior_owners, exhibition_history,
     storage_location, notes, status, inventory_number, asking_price, sold_price, sold_at, sold_to_client_id,
     created_at, updated_at)
    VALUES (@public_id, @owner_id, @title, @artist, @year_created, @type, @medium, @dimensions,
     @purchase_price, @currency, @current_valuation, @insured_value, @valuation_date,
     @acquired_at, @acquired_from, @provenance, @prior_owners, @exhibition_history,
     @storage_location, @notes, @status, @inventory_number, @asking_price, @sold_price, @sold_at, @sold_to_client_id,
     @now, @now)`);

/** Inserts a validated work and returns its row id. Shared with the spreadsheet import. */
function insertArtwork(fields, ownerId, now = new Date().toISOString()) {
  return insertStmt.run({ ...fields, public_id: tokens.publicId('art'), owner_id: ownerId, now }).lastInsertRowid;
}

router.post('/', fileFields, handle(async (req, res) => {
  const fields = resolveBuyer(readFields(req.body), req.body, req.user.id);
  const problem = validate(fields);
  if (problem) return res.status(422).json({ error: 'invalid', message: problem });
  if (!(req.files?.images || []).length) {
    return res.status(422).json({ error: 'invalid', message: 'Please add an image of the work.' });
  }
  const prepared = await prepareFiles(req.files, req.body);

  const info = { lastInsertRowid: insertArtwork(fields, req.user.id) };

  attachFiles(info.lastInsertRowid, prepared);
  const row = db.prepare('SELECT * FROM artworks WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ artwork: withFiles(row) });
}));

router.patch('/:publicId', fileFields, handle(async (req, res) => {
  const row = q.byPublicId.get(req.params.publicId, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const merged = { ...artworkBodyFrom(row), ...req.body };
  const fields = resolveBuyer(readFields(merged), merged, req.user.id);
  const problem = validate(fields);
  if (problem) return res.status(422).json({ error: 'invalid', message: problem });
  const prepared = await prepareFiles(req.files, req.body);

  db.prepare(`UPDATE artworks SET title=@title, artist=@artist, year_created=@year_created, type=@type,
    medium=@medium, dimensions=@dimensions, purchase_price=@purchase_price, currency=@currency,
    current_valuation=@current_valuation, insured_value=@insured_value, valuation_date=@valuation_date,
    acquired_at=@acquired_at, acquired_from=@acquired_from, provenance=@provenance, prior_owners=@prior_owners,
    exhibition_history=@exhibition_history, storage_location=@storage_location, notes=@notes,
    status=@status, inventory_number=@inventory_number, asking_price=@asking_price, sold_price=@sold_price,
    sold_at=@sold_at, sold_to_client_id=@sold_to_client_id, needs_details=0, updated_at=@now
    WHERE id=@id`).run({ ...fields, id: row.id, now: new Date().toISOString() });

  attachFiles(row.id, prepared);
  res.json({ artwork: withFiles(db.prepare('SELECT * FROM artworks WHERE id = ?').get(row.id)) });
}));

/* ---------- a folder of photographs ----------
   Each image in the folder is posted on its own, so a large folder never becomes one huge request
   and a single unreadable file doesn't stop the rest. Every image becomes a work that needs its
   details: a provisional title from the file name, no artist yet. Saving the work's details
   (PATCH, which requires a title and an artist) clears the flag. */

const MAX_DRAFTS_PER_ACCOUNT = 2000;
const countDrafts = db.prepare('SELECT COUNT(*) AS n FROM artworks WHERE owner_id = ? AND needs_details = 1');

/** "IMG_2041.JPG" → "IMG 2041"; "Blue Interval - 2019.png" → "Blue Interval – 2019". */
function titleFromFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/\.[a-z0-9]{2,5}$/i, '');
  const clean = base.replace(/_+/g, ' ').replace(/\s+-\s+/g, ' – ').replace(/\s+/g, ' ').trim()
    .replace(/^[-–\s]+|[-–\s]+$/g, '');
  return (clean || 'Untitled').slice(0, 200);
}

const oneImage = uploads.upload.single('image');
router.post('/drafts', oneImage, handle(async (req, res) => {
  const file = req.file;
  if (!file) return res.status(422).json({ error: 'invalid', message: 'Please choose an image.' });
  if (!uploads.IMAGE_TYPES.has(file.mimetype)) {
    return res.status(422).json({ error: 'invalid_file', message: `“${file.originalname || 'That file'}” isn’t a JPEG, PNG, WebP, GIF or SVG image.` });
  }
  if (countDrafts.get(req.user.id).n >= MAX_DRAFTS_PER_ACCOUNT) {
    return res.status(422).json({ error: 'too_many_drafts', message: `There are already ${MAX_DRAFTS_PER_ACCOUNT} works waiting for their details. Describe some of those first.` });
  }
  const prepared = { images: [await images.processImage(file.buffer, file.mimetype)], documents: [] };

  const fields = readFields({ title: titleFromFileName(req.body.name || file.originalname), status: 'collection' });
  fields.artist = '';                                  // stored empty, never shown as a name
  const id = db.transaction(() => {
    const rowId = insertArtwork(fields, req.user.id);
    db.prepare('UPDATE artworks SET needs_details = 1 WHERE id = ?').run(rowId);
    attachFiles(rowId, prepared);
    return rowId;
  })();
  res.status(201).json({ artwork: withFiles(db.prepare('SELECT * FROM artworks WHERE id = ?').get(id)) });
}));

/** PATCH bodies may be partial, so unspecified fields fall back to what is already stored. */
function artworkBodyFrom(row) {
  return {
    title: row.title, artist: row.artist, year: row.year_created, type: row.type, medium: row.medium,
    dimensions: row.dimensions, purchasePrice: row.purchase_price, currency: row.currency,
    currentValuation: row.current_valuation, insuredValue: row.insured_value, valuationDate: row.valuation_date,
    acquiredAt: row.acquired_at, acquiredFrom: row.acquired_from, provenance: row.provenance,
    priorOwners: row.prior_owners, exhibitionHistory: row.exhibition_history,
    storageLocation: row.storage_location, notes: row.notes,
    status: row.status, inventoryNumber: row.inventory_number, askingPrice: row.asking_price,
    soldPrice: row.sold_price, soldAt: row.sold_at,
    soldTo: row.sold_to_client_id ? db.prepare('SELECT public_id FROM clients WHERE id = ?').get(row.sold_to_client_id)?.public_id : null
  };
}

router.delete('/:publicId', (req, res) => {
  const row = q.byPublicId.get(req.params.publicId, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  for (const img of q.imagesFor.all(row.id)) images.filesOf(img).forEach(uploads.removeFile);
  for (const doc of q.documentsFor.all(row.id)) uploads.removeFile(doc.file_path);
  db.prepare('DELETE FROM artworks WHERE id = ?').run(row.id);   // cascades to images, documents, share items
  res.status(204).end();
});

router.delete('/:publicId/images/:imageId', (req, res) => {
  const row = q.byPublicId.get(req.params.publicId, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const img = db.prepare('SELECT * FROM artwork_images WHERE public_id = ? AND artwork_id = ?').get(req.params.imageId, row.id);
  if (!img) return res.status(404).json({ error: 'not_found' });
  if (q.imagesFor.all(row.id).length <= 1) {
    return res.status(422).json({ error: 'invalid', message: 'A work needs at least one image.' });
  }
  images.filesOf(img).forEach(uploads.removeFile);
  db.prepare('DELETE FROM artwork_images WHERE id = ?').run(img.id);
  res.status(204).end();
});

router.delete('/:publicId/documents/:documentId', (req, res) => {
  const row = q.byPublicId.get(req.params.publicId, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const doc = db.prepare('SELECT * FROM artwork_documents WHERE public_id = ? AND artwork_id = ?').get(req.params.documentId, row.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  uploads.removeFile(doc.file_path);
  db.prepare('DELETE FROM artwork_documents WHERE id = ?').run(doc.id);
  res.status(204).end();
});

module.exports = { router, titleFromFileName, TYPES, STATUSES, DOCUMENT_KINDS, withFiles, readFields, validate, resolveBuyer, insertArtwork, attachFiles };
