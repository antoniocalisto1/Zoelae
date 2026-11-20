'use strict';
// Paid one-off documents. The whole point of this route is the split between what a plan covers
// and what someone buys once, at the moment an insurer or a solicitor asks for it.
//
// NOTE ON PAYMENT: this build takes no payment and asks for no payment details. A purchase is
// confirmed in-app and recorded with status 'simulated_paid'. Putting a real provider behind it
// means replacing confirmPurchase() with a redirect to their checkout and marking the order paid
// from their webhook — no other part of this file changes.
const express = require('express');
const fs = require('fs');
const { db } = require('./../db');
const tokens = require('./../lib/tokens');
const uploads = require('./../lib/uploads');
const { buildDocument } = require('./../lib/pdfDocuments');
const { DOCUMENT_KINDS, entitlementFor, formatMoney } = require('./../lib/entitlements');
const { requireCollector } = require('./../middleware/collectorAuth');

const router = express.Router();
router.use(requireCollector);

const q = {
  artworks: db.prepare('SELECT * FROM artworks WHERE owner_id = ? ORDER BY artist, year_created, title'),
  firstImage: db.prepare('SELECT file_path FROM artwork_images WHERE artwork_id = ? ORDER BY sort_order, id LIMIT 1'),
  insertOrder: db.prepare(`INSERT INTO export_orders
    (public_id, owner_id, kind, title, status, amount_cents, currency, piece_count, total_value, file_path, byte_size, created_at)
    VALUES (@public_id, @owner_id, @kind, @title, @status, @amount_cents, @currency, @piece_count, @total_value, @file_path, @byte_size, @created_at)`),
  listOrders: db.prepare('SELECT * FROM export_orders WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50'),
  orderByPublicId: db.prepare('SELECT * FROM export_orders WHERE public_id = ? AND owner_id = ?')
};

const serializeOrder = (row) => ({
  id: row.public_id,
  kind: row.kind,
  title: row.title,
  status: row.status,
  amount: row.amount_cents ? formatMoney(row.amount_cents, row.currency) : 'Included',
  pieceCount: row.piece_count,
  totalValue: row.total_value,
  sizeBytes: row.byte_size,
  createdAt: row.created_at,
  url: `/api/exports/${row.public_id}/file`
});

/** What this collector can generate, what it costs them, and what they already have. */
router.get('/', (req, res) => {
  const pieceCount = db.prepare('SELECT COUNT(*) AS c FROM artworks WHERE owner_id = ?').get(req.user.id).c;

  res.json({
    pieceCount,
    plan: { accountType: req.user.account_type, planTier: req.user.plan_tier },
    documents: Object.values(DOCUMENT_KINDS).map(doc => {
      const ent = entitlementFor(req.user, doc.key);
      return {
        kind: doc.key,
        name: doc.name,
        summary: doc.summary,
        included: ent.included,
        reason: ent.reason,
        price: ent.included ? 'Included' : formatMoney(doc.amountCents, ent.currency)
      };
    }),
    orders: q.listOrders.all(req.user.id).map(serializeOrder)
  });
});

/**
 * Generates a document. If the plan doesn't include it, the request must carry
 * confirmPurchase — which is the in-app confirmation, not a payment.
 */
router.post('/', async (req, res, next) => {
  try {
    const kind = String(req.body.kind || '');
    const doc = DOCUMENT_KINDS[kind];
    if (!doc) return res.status(422).json({ error: 'unknown_document', message: 'That document type does not exist.' });

    const rows = q.artworks.all(req.user.id);
    if (!rows.length) {
      return res.status(422).json({ error: 'empty_collection', message: 'There is nothing in your collection to put in a document yet.' });
    }

    const ent = entitlementFor(req.user, kind);
    if (!ent.included && req.body.confirmPurchase !== true) {
      return res.status(402).json({
        error: 'purchase_required',
        message: `${doc.name} is ${formatMoney(doc.amountCents)} on your plan.`,
        price: formatMoney(doc.amountCents),
        amountCents: doc.amountCents,
        currency: ent.currency,
        simulated: true
      });
    }

    const pieces = rows.map(artwork => ({
      artwork,
      imagePath: q.firstImage.get(artwork.id)?.file_path || null
    }));

    const built = await buildDocument({ kind, owner: req.user, pieces });
    const filePath = uploads.writeFile(built.bytes, 'application/pdf');
    const now = new Date().toISOString();

    const info = q.insertOrder.run({
      public_id: tokens.publicId('exp'),
      owner_id: req.user.id,
      kind,
      title: built.title,
      status: ent.included ? 'included' : 'simulated_paid',
      amount_cents: ent.included ? 0 : doc.amountCents,
      currency: ent.currency,
      piece_count: built.pieceCount,
      total_value: built.totalValue,
      file_path: filePath,
      byte_size: built.bytes.length,
      created_at: now
    });

    const row = db.prepare('SELECT * FROM export_orders WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ order: serializeOrder(row) });
  } catch (err) { next(err); }
});

/** Owner-only download. Like every other file in Zoelae, it has no static URL. */
router.get('/:publicId/file', (req, res) => {
  const row = q.orderByPublicId.get(req.params.publicId, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  let abs;
  try { abs = uploads.absolutePath(row.file_path); } catch { return res.status(404).end(); }
  if (!fs.existsSync(abs)) return res.status(404).end();

  const stamp = row.created_at.slice(0, 10);
  const name = `${row.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase()}-${stamp}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"`);
  fs.createReadStream(abs).pipe(res);
});

module.exports = router;
