'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { db, migrate } = require('./db');

// Bring the database up to date before any route prepares its queries, so `npm start` on an
// empty volume is enough to launch the site.
const applied = migrate({ log: () => {} });
if (applied && require.main === module) console.log(`Applied ${applied} migration(s).`);

const mailer = require('./lib/mailer');
const { loadCollector } = require('./middleware/collectorAuth');

const app = express();

// Trust the first proxy hop so req.ip is the real client when deployed behind one.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(loadCollector);

// --- health ----------------------------------------------------------------
// For the host's health check and uptime monitors. Touches the database so a broken volume shows.
app.get('/healthz', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.set('Cache-Control', 'no-store').json({ ok: true, version: require('../package.json').version, uptimeSeconds: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'database_unavailable' });
  }
});

// --- API -------------------------------------------------------------------
app.use('/api/auth', require('./routes/auth'));
app.use('/api/artworks', require('./routes/artworks').router);
app.use('/api/summary', require('./routes/summary'));
app.use('/api/shares', require('./routes/shares'));
app.use('/api/exports', require('./routes/exports'));
app.use('/api/account', require('./routes/account'));
app.use('/api/imports', require('./routes/imports'));
app.use('/api/clients', require('./routes/clients').router);
app.use('/api/s', require('./routes/sharePublic'));  // public, passcode-gated
app.use('/api', require('./routes/media'));          // /api/images/:id, /api/documents/:id

// --- pages -----------------------------------------------------------------
// Pages carry {{SITE}} and {{PLACE}} where the name appears, filled in here from config so the
// name lives in one setting. Read once and kept in production; re-read on every request locally.
const fs = require('fs');
const pageCache = new Map();
function render(file) {
  if (config.isProd && pageCache.has(file)) return pageCache.get(file);
  const esc = (v) => String(v).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const html = fs.readFileSync(path.join(config.publicDir, file), 'utf8')
    .replaceAll('{{SITE}}', esc(config.siteName)).replaceAll('{{PLACE}}', esc(config.sitePlace));
  pageCache.set(file, html);
  return html;
}
const page = (file, status = 200) => (_req, res) => res.status(status).type('html').send(render(file));

// Public front door. Nothing here touches the database or a collector's files.
app.get('/', page('landing.html'));
// There are no plans while the site is free; old links to /plans land on the three account types.
app.get('/plans', (_req, res) => res.redirect(301, '/#accounts'));
app.get('/privacy', page('privacy.html'));
app.get('/terms', page('terms.html'));

// The signed-in application. The sign-in screen lives inside it.
app.get(['/app', '/shared-links', '/reset'], page('index.html'));

// Without an email provider, messages land in data/outbox. On a development machine they can be
// read here, so sign-up and password reset can be tried end to end. Never mounted in production.
if (!config.isProd) {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  app.get('/dev/outbox', (_req, res) => {
    const rows = mailer.listOutbox().map(m => `<li><a href="/dev/outbox/${esc(m.id)}">${esc(m.subject)}</a><span>${esc(m.to)} · ${esc(new Date(m.createdAt).toLocaleString('en-GB'))}</span></li>`).join('');
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Outbox</title>
<style>body{margin:0;background:#faf9f7;color:#141311;font:15px/1.5 -apple-system,'Segoe UI',sans-serif;padding:40px 20px}main{max-width:640px;margin:auto}
h1{font:300 36px 'Cormorant Garamond',Georgia,serif;margin:0 0 4px}p{color:#6f6557;margin:0 0 24px}ul{list-style:none;padding:0;margin:0;background:#fff;border:1px solid #e6e2dc}
li{padding:14px 18px;border-top:1px solid #ebe4d6;display:flex;flex-direction:column}li:first-child{border:0}a{color:#1b1814;font-weight:600;text-decoration:none}a:hover{color:#3457d5}span{color:#7b7062;font-size:13px}
.empty{padding:28px 18px;color:#7b7062}</style>
<main><h1>Outbox</h1><p>Emails Zoelae would have sent. Only on this machine; with POSTMARK_SERVER_TOKEN set they go out for real.</p>
<ul>${rows || '<li class="empty">Nothing yet. Ask for a password reset to see one.</li>'}</ul></main>`);
  });
  app.get('/dev/outbox/:id', (req, res) => {
    const m = mailer.readOutbox(req.params.id);
    if (!m) return res.status(404).send('Not found');
    const head = `<div style="font:13px -apple-system,sans-serif;background:#1b1814;color:#f3efe7;padding:10px 16px">
      <b>To</b> ${esc(m.to)} · <b>From</b> ${esc(m.from)}${m.replyTo ? ` · <b>Reply-To</b> ${esc(m.replyTo)}` : ''}
      ${(m.attachments || []).map(a => ` · <a style="color:#f3efe7" href="/dev/outbox/file/${esc(a.file)}" target="_blank">📎 ${esc(a.name)}</a>`).join('')}</div>`;
    res.send(head + (m.html || `<pre>${esc(m.text)}</pre>`));
  });
  app.get('/dev/outbox/file/:file', (req, res) => {
    const full = mailer.outboxFile(req.params.file);
    if (!full) return res.status(404).send('Not found');
    res.sendFile(full);
  });
}

// The viewer page ships no artwork data; it fetches everything after the passcode is accepted.
app.get('/s/:slug', page('share.html'));

// public/ holds only page shells, styles and scripts. Uploaded files are never served from here,
// and `index: false` keeps the app shell from taking over "/" ahead of the landing page.
// Page shells are only served through the routes above, already filled in.
app.use((req, res, next) => (req.path.endsWith('.html') ? res.status(404).type('html').send(render('404.html')) : next()));
app.use(express.static(config.publicDir, { index: false }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.status(404).type('html').send(render('404.html'));
});

app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'too_large', message: 'That file is larger than 25 MB.' });
  }
  console.error(err);
  res.status(500).json({ error: 'server_error', message: 'Something went wrong.' });
});

if (require.main === module) {
  if (!mailer.configured()) {
    console.log(config.isProd
      ? 'WARNING: POSTMARK_SERVER_TOKEN is not set. Password reset emails are written to the outbox folder and nobody receives them.'
      : `Emails go to the local outbox: ${config.origin()}/dev/outbox`);
  }
  app.listen(config.port, () => {
    console.log(`Zoelae running at ${config.origin()}`);
    // Older images get their smaller copies in the background, after the server is answering.
    require('./lib/images').backfillVariants().catch(err => console.error('Image backfill stopped:', err.message));
  });
}

module.exports = app;
