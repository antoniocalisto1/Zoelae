'use strict';
// Importing works (or clients) from a spreadsheet, in three steps:
//
//   POST /api/imports              the sheet → headings, a guessed column match, a sample
//   POST /api/imports/:id/check    a column match → which rows are ready, which aren't and why
//   POST /api/imports/:id/run      the match, plus photographs or a zip of them → starts the import
//   GET  /api/imports/:id          progress, then the result
//
// The parsed sheet waits on disk under IMPORT_DIR for a day, so the person can take their time
// matching columns. Photographs go through the same pipeline as a single upload (upright, location
// data removed, thumbnail and display sizes made).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { unzipSync } = require('fflate');
const { db } = require('./../db');
const config = require('./../config');
const tokens = require('./../lib/tokens');
const images = require('./../lib/images');
const sheet = require('./../lib/sheetImport');
const clientsLib = require('./../lib/clients');
const artworks = require('./artworks');
const { requireCollector } = require('./../middleware/collectorAuth');

const router = express.Router();
router.use(requireCollector);

const ROOT = config.importDir;
const DAY = 24 * 60 * 60 * 1000;
const IMAGE_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.svg': 'image/svg+xml' };

const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

/* ---------- where an import lives while it's being matched ---------- */

const dirOf = (id) => {
  if (!/^imp_[A-Za-z0-9]+$/.test(id)) return null;
  return path.join(ROOT, id);
};
function load(id, user) {
  const dir = dirOf(id);
  if (!dir || !fs.existsSync(path.join(dir, 'sheet.json'))) return null;
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'sheet.json'), 'utf8'));
  return data.ownerId === user.id ? { ...data, dir } : null;
}
function sweep() {
  if (!fs.existsSync(ROOT)) return;
  for (const name of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, name);
    try { if (Date.now() - fs.statSync(full).mtimeMs > DAY && !jobs.has(name)) fs.rmSync(full, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

/* ---------- a template to start from ---------- */

router.get('/template.xlsx', async (req, res) => {
  const kind = req.query.kind === 'clients' ? 'clients' : 'artworks';
  const wb = new ExcelJS.Workbook();
  wb.creator = config.siteName;
  const ws = wb.addWorksheet(kind === 'clients' ? 'Clients' : 'Works');
  if (kind === 'clients') {
    ws.columns = [
      { header: 'Name', width: 24 }, { header: 'Email', width: 28 }, { header: 'Phone', width: 18 },
      { header: 'Company', width: 22 }, { header: 'City', width: 16 }, { header: 'Country', width: 14 },
      { header: 'Interests', width: 30 }, { header: 'Notes', width: 40 }
    ];
    ws.addRow(['Example: Inês Marlow', 'ines@example.com', '+351 912 345 678', '', 'Lisbon', 'Portugal', 'Large abstract painting, ceramics', 'Met at the spring opening']);
  } else {
    ws.columns = [
      { header: 'Inventory no.', width: 14 }, { header: 'Title', width: 28 }, { header: 'Artist', width: 22 },
      { header: 'Year', width: 8 }, { header: 'Type', width: 14 }, { header: 'Medium', width: 22 },
      { header: 'Dimensions', width: 18 }, { header: 'Status', width: 16 }, { header: 'Asking price', width: 14 },
      { header: 'Price paid', width: 12 }, { header: 'Valuation', width: 12 }, { header: 'Currency', width: 10 },
      { header: 'Date acquired', width: 14 }, { header: 'Acquired from', width: 22 }, { header: 'Location', width: 20 },
      { header: 'Image file', width: 22 }, { header: 'Notes', width: 40 }
    ];
    ws.addRow(['EX-001', 'Example: Harbour Light, No. 4', 'Mira Oduya', 1978, 'Painting', 'Oil on canvas', '120 × 90 cm', 'For sale', 18000, 12400, 19500, 'EUR', new Date('2019-03-14'), 'Galerie Vandel, Antwerp', 'Drawing room', 'harbour-light.jpg', 'Delete these example rows before importing.']);
    ws.addRow(['EX-002', 'Example: Standing Figure III', 'Hana Sørensen', 1961, 'Sculpture', 'Bronze, ed. 3/8', '64 × 18 × 18 cm', 'In the collection', '', 8200, 11000, 'EUR', '2016-09', '', 'Garden', 'standing-figure.jpg', '']);
  }
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3EFE7' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const help = wb.addWorksheet('How to fill this in');
  help.getColumn(1).width = 110;
  const lines = kind === 'clients' ? [
    'One client per row. Only Name is required; Email lets you send them links and PDFs from the Clients page.',
    'Rows with an email already on your list are skipped, so importing the same sheet twice does no harm.'
  ] : [
    'One work per row. Title and Artist are the only columns you need; leave anything else blank.',
    'Status: "For sale", "Sold" or "In the collection". Prices can be typed any way: 12400, €12.400 or 12,400.',
    'Image file: the file name of the work\'s photograph, e.g. harbour-light.jpg. Several photos: separate them with commas.',
    'When you import, add those photos (or a .zip of them). Rows without a photo are imported marked "No image yet".',
    'If you leave Image file blank, a photo named after the inventory number or the title is matched automatically.',
    'Your own column names work too: on the next screen you can match each column to a field.'
  ];
  lines.forEach(l => help.addRow([l]));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${config.siteName.toLowerCase()}-${kind}-template.xlsx"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

/* ---------- 1. the sheet ---------- */

const handle = (fn) => (req, res, next) => fn(req, res, next).catch(err => {
  if (err instanceof sheet.SheetError || err instanceof clientsLib.ClientError) return res.status(422).json({ error: 'invalid_sheet', message: err.message });
  next(err);
});

function describe(data) {
  return {
    id: data.id,
    kind: data.kind,
    filename: data.filename,
    sheetName: data.sheetName,
    headers: data.headers,
    rowCount: data.rows.length,
    embeddedImages: data.embedded.length,
    mapping: data.mapping,
    fields: sheet.FIELDS[data.kind].map(f => ({ key: f.key, label: f.label, required: !!f.required })),
    // a few values from each column, so the match can be checked by eye
    samples: data.headers.map((_, c) => data.rows.slice(0, 40).map(r => r[c]).filter(v => v !== '' && v != null).slice(0, 3)
      .map(v => String(v).slice(0, 60)))
  };
}

router.post('/', sheetUpload.single('sheet'), handle(async (req, res) => {
  if (!req.file) return res.status(422).json({ error: 'no_file', message: 'Choose a spreadsheet to import.' });
  const kind = req.body.kind === 'clients' ? 'clients' : 'artworks';
  sweep();
  const parsed = await sheet.readSheet(req.file.buffer, req.file.originalname);

  const id = tokens.publicId('imp').replace(/[^A-Za-z0-9_]/g, '');
  const dir = path.join(ROOT, id);
  fs.mkdirSync(path.join(dir, 'embedded'), { recursive: true });
  const embedded = [];
  for (const [row, img] of parsed.embedded) {
    const name = `row-${row}.${String(img.extension || 'png').replace(/[^a-z]/gi, '')}`;
    fs.writeFileSync(path.join(dir, 'embedded', name), img.buffer);
    embedded.push({ row, name });
  }
  const data = {
    id, kind, ownerId: req.user.id, createdAt: new Date().toISOString(),
    filename: path.basename(req.file.originalname || 'sheet'), sheetName: parsed.sheetName,
    headers: parsed.headers, rows: parsed.rows, lines: parsed.lines, embedded,
    mapping: sheet.guessMapping(parsed.headers, kind, { accountType: req.user.account_type })
  };
  fs.writeFileSync(path.join(dir, 'sheet.json'), JSON.stringify(data));
  res.status(201).json({ import: describe(data) });
}));

/* ---------- 2. checking a column match ---------- */

function cleanMapping(raw, kind, width) {
  const keys = new Set(sheet.FIELDS[kind].map(f => f.key));
  const seen = new Set();
  return Array.from({ length: width }, (_, i) => {
    const k = Array.isArray(raw) ? String(raw[i] || '') : '';
    if (!keys.has(k) || seen.has(k)) return '';
    seen.add(k);
    return k;
  });
}

const stem = (name) => path.basename(String(name)).toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^a-z0-9]+/g, '');

function existingKeys(user, kind) {
  if (kind === 'clients') return null;
  const rows = db.prepare('SELECT title, artist, inventory_number FROM artworks WHERE owner_id = ?').all(user.id);
  return {
    inv: new Set(rows.map(r => (r.inventory_number || '').trim().toLowerCase()).filter(Boolean)),
    work: new Set(rows.filter(r => !/^untitled$/i.test(r.title)).map(r => `${r.title}|${r.artist}`.toLowerCase()))
  };
}

/** Every row, read with the given match: what will happen to it. */
function plan(data, mapping, user) {
  const read = sheet.fromRow[data.kind];
  const existing = existingKeys(user, data.kind);
  const embeddedRows = new Set(data.embedded.map(e => e.row));
  return data.rows.map((row, i) => {
    const r = read(row, mapping);
    let duplicate = false;
    if (data.kind === 'artworks' && !r.problems.length) {
      const inv = r.body.inventoryNumber.toLowerCase();
      duplicate = inv ? existing.inv.has(inv) : existing.work.has(`${r.body.title}|${r.body.artist}`.toLowerCase());
    } else if (data.kind === 'clients' && !r.problems.length) {
      duplicate = !!clientsLib.findExisting({ ...r.body, email: r.body.email || null }, user.id);
    }
    // Photos to look for: named in the sheet, or else named after the inventory number or title.
    const byTitle = r.body.title && !/^untitled$/i.test(r.body.title) ? r.body.title : '';
    const wanted = r.images.length ? r.images : [r.body.inventoryNumber, byTitle].filter(Boolean);
    return { index: i, line: data.lines?.[i] ?? i + 2, ...r, duplicate, wanted, named: r.images.length > 0, embedded: embeddedRows.has(i) };
  });
}

function summarise(rows, kind) {
  const ready = rows.filter(r => !r.problems.length);
  return {
    total: rows.length,
    ready: ready.length,
    duplicates: ready.filter(r => r.duplicate).length,
    problems: rows.filter(r => r.problems.length).slice(0, 200).map(r => ({ line: r.line, message: r.problems.join(', ') })),
    warnings: rows.filter(r => r.warnings.length).slice(0, 200).map(r => ({ line: r.line, message: r.warnings.join('; ') })),
    // file names the sheet points at, so the browser can say which photos it has
    imageNames: kind === 'artworks' ? [...new Set(ready.filter(r => r.named).flatMap(r => r.images))] : [],
    withEmbeddedImage: ready.filter(r => r.embedded).length,
    preview: rows.slice(0, 6).map(r => ({ line: r.line, ...r.body, problems: r.problems }))
  };
}

router.post('/:id/check', (req, res) => {
  const data = load(req.params.id, req.user);
  if (!data) return res.status(404).json({ error: 'not_found', message: 'That import has expired. Upload the sheet again.' });
  const mapping = cleanMapping(req.body.mapping, data.kind, data.headers.length);
  const required = sheet.FIELDS[data.kind].filter(f => f.required).map(f => f.key);
  // Title can be left out (works come in as "Untitled"); a client's name can come in two halves.
  const missing = required.filter(k => !mapping.includes(k) && k !== 'title'
    && !(k === 'name' && (mapping.includes('firstName') || mapping.includes('lastName'))));
  res.json({ mapping, missing, ...summarise(plan(data, mapping, req.user), data.kind) });
});

/* ---------- 3. running it ---------- */

const jobs = new Map();          // import id -> progress and result

const fileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = dirOf(req.params.id);
      if (!dir) return cb(new Error('bad import id'));
      fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
      cb(null, path.join(dir, 'files'));
    },
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(12).toString('hex'))
  }),
  limits: { fileSize: config.importZipMaxBytes, files: 2000 }
});

/** The photographs on offer, by name: loose files plus whatever a zip holds that the sheet wants. */
function collectPhotos(files, rows) {
  const byStem = new Map();
  const add = (name, read) => {
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXT[ext]) return;
    const s = stem(name);
    if (s && !byStem.has(s)) byStem.set(s, { name: path.basename(name), mime: IMAGE_EXT[ext], read });
  };
  const wanted = new Set(rows.flatMap(r => r.wanted.map(stem)));
  for (const f of files) {
    if (/\.zip$/i.test(f.originalname)) {
      let entries;
      try {
        entries = unzipSync(fs.readFileSync(f.path), {
          filter: (e) => !e.name.startsWith('__MACOSX') && !path.basename(e.name).startsWith('.') && wanted.has(stem(e.name))
        });
      } catch { throw new sheet.SheetError('That zip file couldn’t be opened. Zip the photos again, or add them as separate files.'); }
      for (const [name, bytes] of Object.entries(entries)) add(name, () => Buffer.from(bytes));
    } else {
      add(f.originalname, () => fs.readFileSync(f.path));
    }
  }
  return byStem;
}

async function runArtworks(job, data, rows, photos, user, options) {
  const created = [];
  for (const r of rows) {
    job.done++;
    if (r.problems.length) { job.skipped.push({ line: r.line, reason: r.problems.join(', ') }); continue; }
    if (r.duplicate && options.skipDuplicates) { job.skipped.push({ line: r.line, reason: 'already in your collection' }); continue; }

    const fields = artworks.resolveBuyer(artworks.readFields(r.body), r.body, user.id);
    const problem = artworks.validate(fields);
    if (problem) { job.skipped.push({ line: r.line, reason: problem.replace(/^Please /, '').replace(/\.$/, '') }); continue; }

    // Decode photos before writing anything, so an unreadable file can't leave half a work behind.
    const prepared = { images: [], documents: [] };
    const found = r.wanted.map(n => photos.get(stem(n))).filter(Boolean);
    for (const p of r.named ? found : found.slice(0, 1)) {
      try { prepared.images.push(await images.processImage(p.read(), p.mime)); }
      catch { job.warnings.push({ line: r.line, message: `photo ${p.name} couldn’t be read, so it was left out` }); }
    }
    if (!prepared.images.length && r.embedded) {
      const e = data.embedded.find(x => x.row === r.index);
      try { prepared.images.push(await images.processImage(fs.readFileSync(path.join(data.dir, 'embedded', e.name)), 'image/png')); }
      catch { /* a picture in the sheet we can't read: carry on without it */ }
    }
    if (r.named && found.length < r.images.length) {
      const have = new Set(found.map(p => stem(p.name)));
      const missing = r.images.filter(n => !have.has(stem(n)));
      job.warnings.push({ line: r.line, message: `photo${missing.length > 1 ? 's' : ''} not found: ${missing.join(', ')}` });
    }

    db.transaction(() => {
      const id = artworks.insertArtwork(fields, user.id);
      artworks.attachFiles(id, prepared);
      created.push(id);
    })();
    if (!prepared.images.length) job.needsImage++;
    job.created++;
  }
  return created;
}

function runClients(job, rows, user, options) {
  for (const r of rows) {
    job.done++;
    if (r.problems.length) { job.skipped.push({ line: r.line, reason: r.problems.join(', ') }); continue; }
    if (r.duplicate && options.skipDuplicates) { job.skipped.push({ line: r.line, reason: 'already on your client list' }); continue; }
    try {
      clientsLib.insertClient(clientsLib.clientFields(r.body), user.id);
      job.created++;
    } catch (err) {
      job.skipped.push({ line: r.line, reason: err.message.replace(/\.$/, '') });
    }
  }
}

router.post('/:id/run', (req, res, next) => {
  const data = load(req.params.id, req.user);
  if (!data) return res.status(404).json({ error: 'not_found', message: 'That import has expired. Upload the sheet again.' });
  if (jobs.get(data.id)?.state === 'running') return res.status(409).json({ error: 'running', message: 'This import is already running.' });
  fileUpload.array('photos', 2000)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'too_large', message: `One file is larger than ${Math.round(config.importZipMaxBytes / 1048576)} MB. Split the photos into smaller zips, or add them as separate files.` });
      return next(err);
    }
    let mapping, options;
    try {
      mapping = cleanMapping(JSON.parse(req.body.mapping || '[]'), data.kind, data.headers.length);
      options = { skipDuplicates: req.body.skipDuplicates !== 'false' };
    } catch { return res.status(422).json({ error: 'invalid', message: 'The column match was not readable.' }); }

    const rows = plan(data, mapping, req.user);
    let photos;
    try { photos = data.kind === 'artworks' ? collectPhotos(req.files || [], rows) : new Map(); }
    catch (e) { return res.status(422).json({ error: 'invalid_zip', message: e.message }); }

    const job = { ownerId: req.user.id, state: 'running', kind: data.kind, total: rows.length, done: 0, created: 0, needsImage: 0, skipped: [], warnings: [], startedAt: Date.now() };
    jobs.set(data.id, job);
    res.status(202).json({ job: publicJob(job) });

    // The import carries on after the response; the page polls GET /api/imports/:id.
    (async () => {
      try {
        if (data.kind === 'artworks') await runArtworks(job, data, rows, photos, req.user, options);
        else runClients(job, rows, req.user, options);
        job.state = 'done';
      } catch (e) {
        console.error('Import failed:', e);
        job.state = 'failed';
        job.error = 'The import stopped part-way. Works already imported are kept.';
      } finally {
        job.finishedAt = Date.now();
        fs.rmSync(data.dir, { recursive: true, force: true });   // the sheet and photos aren't kept
        setTimeout(() => jobs.delete(data.id), 60 * 60 * 1000).unref();
      }
    })();
  });
});

const publicJob = (j) => ({
  state: j.state, kind: j.kind, total: j.total, done: j.done, created: j.created, needsImage: j.needsImage,
  skipped: j.skipped.slice(0, 300), warnings: j.warnings.slice(0, 300), error: j.error || null
});

router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job && job.ownerId === req.user.id) return res.json({ job: publicJob(job) });
  const data = load(req.params.id, req.user);
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json({ import: describe(data) });
});

module.exports = router;
