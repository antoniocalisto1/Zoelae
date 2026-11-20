'use strict';
// The collector's own account: take everything away, or delete everything.
//
// These two routes are what make the landing page's trust promises true, so they are deliberately
// plain. The export contains every record and every file the account owns. Deletion removes the
// user row (everything else cascades from it) and then the files on disk.
const fs = require('fs');
const express = require('express');
const { db } = require('./../db');
const config = require('./../config');
const passcodes = require('./../lib/passcodes');
const { absolutePath, removeFile } = require('./../lib/uploads');
const { buildZip } = require('./../lib/zip');
const { requireCollector } = require('./../middleware/collectorAuth');

const router = express.Router();
router.use(requireCollector);

const throttle = require('./../lib/throttle');

const q = {
  artworks: db.prepare('SELECT * FROM artworks WHERE owner_id = ? ORDER BY id'),
  images: db.prepare('SELECT * FROM artwork_images WHERE artwork_id = ? ORDER BY id'),
  documents: db.prepare('SELECT * FROM artwork_documents WHERE artwork_id = ? ORDER BY id'),
  shares: db.prepare('SELECT * FROM shared_collections WHERE owner_id = ? ORDER BY id'),
  shareItems: db.prepare(`SELECT a.public_id AS artwork, i.* FROM shared_collection_items i
    JOIN artworks a ON a.id = i.artwork_id WHERE i.shared_collection_id = ? ORDER BY i.sort_order, i.id`),
  accessLog: db.prepare('SELECT * FROM shared_collection_access_log WHERE shared_collection_id = ? ORDER BY id'),
  orders: db.prepare('SELECT * FROM export_orders WHERE owner_id = ? ORDER BY id'),
  clients: db.prepare('SELECT * FROM clients WHERE owner_id = ? ORDER BY lower(name)'),
  clientMessages: db.prepare(`SELECT m.kind, m.subject, m.body, m.artwork_count, m.delivery, m.created_at, s.slug AS shared_link
    FROM client_messages m LEFT JOIN shared_collections s ON s.id = m.shared_collection_id WHERE m.client_id = ? ORDER BY m.created_at`),
  allFiles: db.prepare(`
    SELECT i.file_path FROM artwork_images i JOIN artworks a ON a.id = i.artwork_id WHERE a.owner_id = @uid
    UNION ALL
    SELECT i.display_path FROM artwork_images i JOIN artworks a ON a.id = i.artwork_id WHERE a.owner_id = @uid AND i.display_path IS NOT NULL
    UNION ALL
    SELECT i.thumb_path FROM artwork_images i JOIN artworks a ON a.id = i.artwork_id WHERE a.owner_id = @uid AND i.thumb_path IS NOT NULL
    UNION ALL
    SELECT d.file_path FROM artwork_documents d JOIN artworks a ON a.id = d.artwork_id WHERE a.owner_id = @uid
    UNION ALL
    SELECT o.file_path FROM export_orders o WHERE o.owner_id = @uid`),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?')
};

/** Strip internal keys: numeric ids, foreign keys, stored paths and any hash. */
function clean(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id' || k.endsWith('_path') || k.endsWith('_id') || k.endsWith('_hash') || k === 'session_version') continue;
    out[k] = v;
  }
  return out;
}

const slug = (s) => String(s || 'untitled').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'untitled';

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/svg+xml': '.svg', 'application/pdf': '.pdf' };

function readStored(rel) {
  try { return fs.readFileSync(absolutePath(rel)); } catch { return null; }
}

router.get('/export', (req, res) => {
  const user = req.user;
  const files = [];
  const missing = [];

  const addFile = (zipPath, rel) => {
    const data = readStored(rel);
    if (data) { files.push({ name: zipPath, data }); return zipPath; }
    missing.push(zipPath);
    return null;
  };

  const artworks = q.artworks.all(user.id).map(a => {
    const folder = `${slug(a.title)}-${a.public_id}`;
    const images = q.images.all(a.id).map((img, i) => ({
      ...clean(img),
      file: addFile(`images/${folder}/${String(i + 1).padStart(2, '0')}${EXT[img.mime_type] || ''}`, img.file_path)
    }));
    const documents = q.documents.all(a.id).map((doc, i) => ({
      ...clean(doc),
      file: addFile(`documents/${folder}/${String(i + 1).padStart(2, '0')}-${slug(doc.label || doc.kind)}${EXT[doc.mime_type] || ''}`, doc.file_path)
    }));
    return { ...clean(a), images, documents };
  });

  const sharedLinks = q.shares.all(user.id).map(s => ({
    ...clean(s),
    url: `${config.origin()}/s/${s.slug}`,
    works: q.shareItems.all(s.id).map(i => i.artwork),
    accessLog: q.accessLog.all(s.id).map(clean)
  }));

  const documentsGenerated = q.orders.all(user.id).map(o => ({
    ...clean(o),
    file: addFile(`generated-documents/${slug(o.title)}-${String(o.created_at).slice(0, 10)}-${o.public_id}.pdf`, o.file_path)
  }));

  const clientList = q.clients.all(user.id).map(c => ({ ...clean(c), messages: q.clientMessages.all(c.id) }));

  const exportedAt = new Date().toISOString();
  const manifest = {
    exportedAt,
    format: 'zoelae-export/1',
    note: 'Every record and file in this Zoelae account. Paths under "file" point into this archive.',
    account: { email: user.email, displayName: user.display_name, accountType: user.account_type,
      planTier: user.plan_tier, createdAt: user.created_at, timezone: user.timezone },
    artworks, sharedLinks, documentsGenerated, clients: clientList,
    ...(missing.length ? { filesNotFound: missing } : {})
  };

  const readme = [
    'Your Zoelae export',
    '',
    `Exported ${exportedAt} for ${user.email}.`,
    '',
    'catalogue.csv           one row per work, for opening in a spreadsheet',
    'clients.csv             your client list, if you keep one',
    'zoelae.json             every record: works, shared links and their access logs, generated documents',
    'images/                 the photographs of each work, one folder per work',
    'documents/              certificates, invoices and other files you attached',
    'generated-documents/    insurance schedules and estate inventories you generated',
    '',
    'Passcodes and your password are stored as one-way hashes, so they are not included.',
    ''
  ].join('\n');

  const COLUMNS = [
    ['Inventory no.', 'inventory_number'], ['Title', 'title'], ['Artist', 'artist'], ['Year', 'year_created'], ['Type', 'type'], ['Medium', 'medium'],
    ['Dimensions', 'dimensions'], ['Currency', 'currency'], ['Purchase price', 'purchase_price'],
    ['Current valuation', 'current_valuation'], ['Insured value', 'insured_value'], ['Valuation date', 'valuation_date'],
    ['Acquired', 'acquired_at'], ['Acquired from', 'acquired_from'], ['Provenance', 'provenance'],
    ['Prior owners', 'prior_owners'], ['Exhibition history', 'exhibition_history'], ['Location', 'storage_location'],
    ['Notes', 'notes'], ['Status', 'status'], ['Asking price', 'asking_price'], ['Sold price', 'sold_price'],
    ['Sold on', 'sold_at'], ['Images', null], ['Documents', null], ['Added', 'created_at']
  ];
  // Quote every cell; a leading = + - @ is defused so a spreadsheet never runs it as a formula.
  const cell = (v) => {
    let t = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  };
  const csv = '\ufeff' + [COLUMNS.map(c => cell(c[0])).join(','),
    ...artworks.map(a => COLUMNS.map(([label, key]) =>
      cell(label === 'Images' ? a.images.map(i => i.file).filter(Boolean).join(' ')
        : label === 'Documents' ? a.documents.map(d => d.file).filter(Boolean).join(' ')
          : a[key])).join(','))].join('\r\n');

  const zip = buildZip([
    { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
    { name: 'catalogue.csv', data: Buffer.from(csv, 'utf8') },
    ...(clientList.length ? [{ name: 'clients.csv', data: Buffer.from('\ufeff' + [
      ['Name', 'Email', 'Phone', 'Company', 'City', 'Country', 'Interests', 'Notes', 'Added'].map(cell).join(','),
      ...clientList.map(c => [c.name, c.email, c.phone, c.company, c.city, c.country, c.interests, c.notes, c.created_at].map(cell).join(','))
    ].join('\r\n'), 'utf8') }] : []),
    { name: 'zoelae.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    ...files
  ]);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="zoelae-export-${exportedAt.slice(0, 10)}.zip"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(zip);
});

router.post('/delete', (req, res) => {
  const user = req.user;
  const { limit, windowMs } = config.accountLimits.loginPerAccount;
  const key = 'delete:' + user.id;
  const state = throttle.peek(key, limit, windowMs);
  if (state.limited) {
    return res.status(429).json({ error: 'rate_limited', message: `Too many attempts. Please try again in ${throttle.humanWait(state.retryAfterMs)}.` });
  }
  if (!passcodes.verify(String(req.body.password || ''), user.password_hash)) {
    throttle.hit(key, windowMs);
    return res.status(401).json({ error: 'wrong_password',
      message: 'That password isn’t right. Enter the password you sign in with.' });
  }

  // Collect the files first: once the user row goes, the rows that point at them go with it.
  const files = q.allFiles.all({ uid: user.id }).map(r => r.file_path);
  db.transaction(() => q.deleteUser.run(user.id))();
  files.forEach(removeFile);

  res.clearCookie(config.collectorCookie, { path: '/' });
  res.status(204).end();
});

module.exports = router;
