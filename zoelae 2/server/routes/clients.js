'use strict';
// The client list: the people a gallery or an artist sells to. Private to the account.
const express = require('express');
const { db } = require('./../db');
const clientsLib = require('./../lib/clients');
const { clientForOwner } = require('./../lib/serialize');
const { requireCollector } = require('./../middleware/collectorAuth');
const config = require('./../config');
const tokens = require('./../lib/tokens');
const mailer = require('./../lib/mailer');
const emails = require('./../lib/emails');
const { buildSelection, MAX_WORKS } = require('./../lib/pdfSelection');
const { computeStatus, STATUS } = require('./../lib/shareState');

const router = express.Router();
router.use(requireCollector);

const q = {
  list: db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM client_messages m WHERE m.client_id = c.id) AS message_count,
      (SELECT MAX(created_at) FROM client_messages m WHERE m.client_id = c.id) AS last_contacted_at,
      (SELECT COUNT(*) FROM artworks a WHERE a.sold_to_client_id = c.id) AS works_bought
    FROM clients c WHERE c.owner_id = ? ORDER BY lower(c.name)`),
  one: db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM client_messages m WHERE m.client_id = c.id) AS message_count,
      (SELECT MAX(created_at) FROM client_messages m WHERE m.client_id = c.id) AS last_contacted_at,
      (SELECT COUNT(*) FROM artworks a WHERE a.sold_to_client_id = c.id) AS works_bought
    FROM clients c WHERE c.public_id = ? AND c.owner_id = ?`),
  messages: db.prepare(`SELECT m.*, s.title AS share_title, s.slug AS share_slug FROM client_messages m
    LEFT JOIN shared_collections s ON s.id = m.shared_collection_id
    WHERE m.client_id = ? ORDER BY m.created_at DESC LIMIT 100`),
  bought: db.prepare(`SELECT public_id, title, artist, year_created, sold_at, sold_price, currency FROM artworks
    WHERE sold_to_client_id = ? AND owner_id = ? ORDER BY sold_at DESC, id DESC`),
  update: db.prepare(`UPDATE clients SET name=@name, email=@email, phone=@phone, company=@company, city=@city,
    country=@country, interests=@interests, notes=@notes, updated_at=@now WHERE id=@id`),
  remove: db.prepare('DELETE FROM clients WHERE id = ?')
};

const fail = (res, err) => {
  if (err instanceof clientsLib.ClientError) return res.status(422).json({ error: 'invalid', message: err.message });
  throw err;
};

router.get('/', (req, res) => {
  res.json({ clients: q.list.all(req.user.id).map(clientForOwner) });
});

router.post('/', (req, res) => {
  let fields;
  try { fields = clientsLib.clientFields(req.body); } catch (err) { return fail(res, err); }
  if (fields.email && clientsLib.findExisting(fields, req.user.id)) {
    return res.status(409).json({ error: 'duplicate', message: 'A client with that email is already on your list.' });
  }
  const id = clientsLib.insertClient(fields, req.user.id);
  const row = db.prepare('SELECT public_id FROM clients WHERE id = ?').get(id);
  res.status(201).json({ client: clientForOwner(q.one.get(row.public_id, req.user.id)) });
});

router.get('/:id', (req, res) => {
  const row = q.one.get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({
    client: clientForOwner(row),
    messages: q.messages.all(row.id).map(m => ({
      id: m.public_id, kind: m.kind, subject: m.subject, delivery: m.delivery, createdAt: m.created_at,
      artworkCount: m.artwork_count, share: m.share_slug ? { slug: m.share_slug, title: m.share_title } : null
    })),
    bought: q.bought.all(row.id, req.user.id).map(a => ({
      id: a.public_id, title: a.title, artist: a.artist, year: a.year_created,
      soldAt: a.sold_at || '', soldPrice: a.sold_price, currency: a.currency || 'EUR'
    }))
  });
});

router.patch('/:id', (req, res) => {
  const row = q.one.get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  let fields;
  try { fields = clientsLib.clientFields({ ...clientForOwner(row), ...req.body }); } catch (err) { return fail(res, err); }
  if (fields.email && fields.email !== row.email) {
    const other = clientsLib.findExisting(fields, req.user.id);
    if (other && other.id !== row.id) return res.status(409).json({ error: 'duplicate', message: 'Another client already has that email.' });
  }
  q.update.run({ ...fields, id: row.id, now: new Date().toISOString() });
  res.json({ client: clientForOwner(q.one.get(row.public_id, req.user.id)) });
});

router.delete('/:id', (req, res) => {
  const row = q.one.get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  q.remove.run(row.id);            // works they bought keep their sale, without the buyer's name
  res.status(204).end();
});

/* ---------- sending works to clients ---------- */

const artworkRows = db.prepare(`SELECT a.*, (SELECT COALESCE(i.display_path, i.file_path) FROM artwork_images i
  WHERE i.artwork_id = a.id ORDER BY i.sort_order, i.id LIMIT 1) AS image_path FROM artworks a
  WHERE a.owner_id = ? AND a.public_id = ?`);
const shareBySlug = db.prepare('SELECT * FROM shared_collections WHERE slug = ? AND owner_id = ?');
const clientRow = db.prepare('SELECT * FROM clients WHERE public_id = ? AND owner_id = ?');
const sentToday = db.prepare("SELECT COUNT(*) AS c FROM client_messages WHERE owner_id = ? AND created_at >= ?");
const logMessage = db.prepare(`INSERT INTO client_messages
  (public_id, owner_id, client_id, kind, subject, body, shared_collection_id, artwork_count, delivery, created_at)
  VALUES (@public_id, @owner_id, @client_id, @kind, @subject, @body, @share_id, @artwork_count, @delivery, @now)`);

const fileSafe = (s) => String(s || 'works').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'works';

/** The works for a PDF, in the order chosen, all belonging to this account. */
function selectedWorks(user, ids) {
  const list = [...new Set([].concat(ids || []).map(String))].slice(0, MAX_WORKS + 1);
  if (list.length > MAX_WORKS) return { error: `A PDF can hold up to ${MAX_WORKS} works. Send a shared link for more.` };
  const works = list.map(id => artworkRows.get(user.id, id)).filter(Boolean)
    .map(a => ({ artwork: a, imagePath: a.image_path }));
  if (!works.length) return { error: 'Choose at least one work.' };
  return { works };
}

/** A look at the PDF before it goes out. */
router.get('/send/preview.pdf', async (req, res, next) => {
  try {
    const { works, error } = selectedWorks(req.user, String(req.query.works || '').split(',').filter(Boolean));
    if (error) return res.status(422).json({ error: 'invalid', message: error });
    const client = req.query.client ? clientRow.get(String(req.query.client), req.user.id) : null;
    const bytes = await buildSelection({
      owner: req.user, client, works,
      title: String(req.query.title || 'Selected works').slice(0, 120),
      includePrices: req.query.prices === '1', includeStatus: req.query.status !== '0'
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileSafe(req.query.title)}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(bytes);
  } catch (err) { next(err); }
});

/**
 * Sends a shared link or a PDF of chosen works to one or more clients, one email each.
 * Emails go from the site's own address with the sender's name, and replies go to the sender.
 */
router.post('/send', async (req, res, next) => {
  try {
    const user = req.user;
    const kind = req.body.kind === 'pdf' ? 'pdf' : 'link';
    const subject = String(req.body.subject || '').trim().slice(0, 160);
    const message = String(req.body.message || '').trim().slice(0, 5000);
    const recipients = [...new Set([].concat(req.body.clientIds || []).map(String))];
    if (!recipients.length) return res.status(422).json({ error: 'invalid', message: 'Choose who to send it to.' });
    if (recipients.length > config.clientMail.perSend) {
      return res.status(422).json({ error: 'invalid', message: `Send to up to ${config.clientMail.perSend} clients at a time.` });
    }
    if (!subject) return res.status(422).json({ error: 'invalid', message: 'Please add a subject.' });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const used = sentToday.get(user.id, since).c;
    if (used + recipients.length > config.clientMail.perDay) {
      return res.status(429).json({ error: 'rate_limited', message: `That would go over today's limit of ${config.clientMail.perDay} emails. ${Math.max(0, config.clientMail.perDay - used)} left.` });
    }

    let share = null, link = null, attachment = null, works = [];
    if (kind === 'link') {
      share = shareBySlug.get(String(req.body.shareSlug || ''), user.id);
      if (!share) return res.status(422).json({ error: 'invalid', message: 'Choose one of your shared links.' });
      if (computeStatus(share) !== STATUS.ACTIVE) return res.status(422).json({ error: 'invalid', message: 'That link has expired or been switched off. Choose an active one.' });
      link = `${config.origin()}/s/${share.slug}`;
    } else {
      const picked = selectedWorks(user, req.body.artworkIds);
      if (picked.error) return res.status(422).json({ error: 'invalid', message: picked.error });
      works = picked.works;
    }

    const clients = recipients.map(id => clientRow.get(id, user.id));
    if (clients.some(c => !c)) return res.status(404).json({ error: 'not_found', message: 'One of those clients isn’t on your list.' });

    const fromName = String(user.display_name || user.email).replace(/["<>]/g, '');
    const address = (config.mailFrom.match(/<([^>]+)>/) || [null, config.mailFrom])[1];
    const from = `"${fromName} via ${config.siteName}" <${address}>`;
    const passcode = kind === 'link' ? String(req.body.passcode || '').trim().slice(0, 80) : '';
    const title = String(req.body.title || subject).slice(0, 120);

    const results = [];
    for (const client of clients) {
      if (!client.email) { results.push({ id: client.public_id, name: client.name, delivery: 'skipped', reason: 'no email address' }); continue; }
      if (kind === 'pdf') {
        // Built per client so the cover says who it was prepared for.
        const bytes = await buildSelection({
          owner: user, client, works, title,
          includePrices: req.body.includePrices === true, includeStatus: req.body.includeStatus !== false
        });
        attachment = { name: `${fileSafe(title)}.pdf`, type: 'application/pdf', content: bytes };
      }
      const firstName = client.name.split(/\s+/)[0];
      const body = message.replace(/\{name\}/g, firstName);
      const mail = emails.toClient({
        fromName, fromEmail: user.email, clientName: client.name, subject, message: body,
        link, passcode, pdfName: attachment?.name
      });
      const sent = await mailer.send({ to: client.email, from, replyTo: user.email, ...mail, attachments: attachment ? [attachment] : [] });
      const delivery = sent.sent ? 'sent' : sent.outbox ? 'outbox' : 'failed';
      logMessage.run({
        public_id: tokens.publicId('msg'), owner_id: user.id, client_id: client.id, kind, subject, body,
        share_id: share?.id || null, artwork_count: kind === 'pdf' ? works.length : (share ? db.prepare('SELECT COUNT(*) AS c FROM shared_collection_items WHERE shared_collection_id = ?').get(share.id).c : 0),
        delivery, now: new Date().toISOString()
      });
      results.push({ id: client.public_id, name: client.name, delivery });
    }

    const sentCount = results.filter(r => r.delivery === 'sent' || r.delivery === 'outbox').length;
    res.json({
      results,
      sent: sentCount,
      outbox: !mailer.configured() && !config.isProd ? '/dev/outbox' : null,
      message: sentCount
        ? `Sent to ${sentCount} client${sentCount === 1 ? '' : 's'}.${results.some(r => r.delivery === 'skipped') ? ' Clients without an email address were skipped.' : ''}`
        : 'Nothing was sent: none of those clients has an email address.'
    });
  } catch (err) { next(err); }
});

module.exports = { router, q };
