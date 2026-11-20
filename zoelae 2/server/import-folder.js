'use strict';
/**
 * Bulk-import folders of images into a collector's account, one artwork per image,
 * using each folder's name as the artist.
 *
 *   node server/import-folder.js --name "Zak Calisto" --email zak@example.com \
 *        --password "a-password" "/path/to/Yunizar" "/path/to/Georgina Gratrix"
 *
 * Options
 *   --name       display name, used when the account has to be created
 *   --email      account to import into; created if it does not exist yet
 *   --password   required only when the account is being created
 *   --type       artwork type for everything imported (default: Painting)
 *   --title      title for pieces with nothing better (default: Untitled)
 *   --fresh      delete that artist's existing pieces in this account before importing
 *   --dry-run    list what would happen and change nothing
 *
 * Pieces come in with just the artist and the image. Where a filename clearly carries
 * real catalogue data — the artist's name plus a four-digit year — that is used instead
 * of guessing, and a PDF sitting next to a matching image is attached to it as a document.
 */
const fs = require('fs');
const path = require('path');
const { db, migrate } = require('./db');
const tokens = require('./lib/tokens');
const passcodes = require('./lib/passcodes');
const uploads = require('./lib/uploads');
const { storeImage } = require('./lib/images');

const IMAGE_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml'
};

const MEDIUM_WORDS = /(oil|acrylic|watercolour|watercolor|gouache|ink|charcoal|pencil|canvas|linen|paper|board|panel|bronze|marble|basalt|steel|aluminium|stoneware|terracotta|mixed media|screenprint|lithograph|etching|cyanotype|gelatin silver|pigment print|photograph)/i;
const DIMENSIONS = /\d+(\.\d+)?\s*[x×]\s*\d+(\.\d+)?/i;

function parseArgs(argv) {
  const opts = { type: 'Painting', title: 'Untitled', folders: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fresh') opts.fresh = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--')) opts[arg.slice(2)] = argv[++i];
    else opts.folders.push(arg);
  }
  return opts;
}

/**
 * Reads catalogue data out of a filename, but only when it is unmistakably there:
 * the artist's name and a four-digit year both present. Anything less and the piece
 * goes in as untitled with no invented detail.
 */
function parseFilename(filename, artist) {
  const stem = path.basename(filename, path.extname(filename))
    .replace(/\s*\(\d+\)\s*$/, '')             // drop a trailing "(1)" from duplicate downloads
    .replace(/_/g, ':')                        // macOS writes ":" as "_" in filenames
    .replace(/\([^)]*framed[^)]*\)/ig, '')     // the framed size is not the work's size
    .trim();
  const surname = artist.split(/\s+/).pop().toLowerCase();

  const hasArtist = stem.toLowerCase().includes(surname);
  const yearMatch = stem.match(/\b(1\d{3}|20\d{2})\b/);
  if (!hasArtist || !yearMatch) return null;

  const year = Number(yearMatch[1]);
  if (year > new Date().getFullYear()) return null;

  const parts = stem.split(',').map(p => p.trim()).filter(Boolean);
  const artistIndex = parts.findIndex(p => p.toLowerCase().includes(surname));

  // The part right after the artist is the title, unless that part is the year itself.
  let title = null;
  const candidate = parts[artistIndex + 1];
  if (candidate && !/^\d{4}$/.test(candidate) && !DIMENSIONS.test(candidate)) title = candidate;

  const medium = parts.find(p => MEDIUM_WORDS.test(p) && !/framed/i.test(p)) || null;
  const dimensions = parts.find(p => DIMENSIONS.test(p) && !/framed/i.test(p)) || null;

  return {
    title,
    year,
    medium: medium ? medium.replace(/\s+/g, ' ') : null,
    dimensions: dimensions
      ? dimensions.replace(/\s+/g, ' ').replace(/(\d)\s*[x×]\s*(\d)/g, '$1 × $2').trim()
      : null
  };
}

/** First whitespace-or-comma token, e.g. "YUN310" — used to pair a PDF with its image. */
const leadToken = (filename) => path.basename(filename).split(/[\s,]/)[0].toLowerCase();

function findOrCreateUser({ email, name, password, dryRun }) {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) return { user: existing, created: false };
  if (!password) throw new Error(`No account for ${email} — pass --password to create one.`);
  // A dry run must not write anything, so stand in a fake row rather than creating the account.
  if (dryRun) return { user: { id: -1, email, display_name: name }, created: true };
  if (password.length < passcodes.MIN_PASSWORD_LENGTH) {
    throw new Error(`The password needs at least ${passcodes.MIN_PASSWORD_LENGTH} characters.`);
  }
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO users (public_id, email, password_hash, display_name, timezone, login_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`)
    .run(tokens.publicId('usr'), email, passcodes.hash(password), name || null, now, now);
  return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid), created: true };
}

const insertArtwork = db.prepare(`INSERT INTO artworks
  (public_id, owner_id, title, artist, year_created, type, medium, dimensions, currency, created_at, updated_at)
  VALUES (@public_id, @owner_id, @title, @artist, @year_created, @type, @medium, @dimensions, 'EUR', @now, @now)`);

const insertImage = db.prepare(`INSERT INTO artwork_images (public_id, artwork_id, file_path, display_path, thumb_path, width, height, mime_type, byte_size, sort_order, created_at)
  VALUES (@public_id, @artwork_id, @file_path, @display_path, @thumb_path, @width, @height, @mime_type, @byte_size, 0, @created_at)`);

const insertDocument = db.prepare(`INSERT INTO artwork_documents (public_id, artwork_id, kind, label, file_path, mime_type, byte_size, created_at)
  VALUES (?, ?, 'other', ?, ?, 'application/pdf', ?, ?)`);

async function importFolder(folder, user, opts) {
  const artist = path.basename(folder.replace(/[\\/]+$/, ''));
  const entries = fs.readdirSync(folder).filter(f => !f.startsWith('.')).sort();

  const images = entries.filter(f => IMAGE_MIME[path.extname(f).toLowerCase()]);
  const pdfs = entries.filter(f => path.extname(f).toLowerCase() === '.pdf');
  const skipped = entries.filter(f => !images.includes(f) && !pdfs.includes(f));

  console.log(`\n  ${artist} — ${images.length} image${images.length === 1 ? '' : 's'}` +
    (pdfs.length ? `, ${pdfs.length} PDF${pdfs.length === 1 ? '' : 's'}` : ''));

  if (opts.fresh && !opts.dryRun) {
    const gone = db.prepare('DELETE FROM artworks WHERE owner_id = ? AND artist = ?').run(user.id, artist);
    if (gone.changes) console.log(`    removed ${gone.changes} existing piece(s) by ${artist}`);
  }

  let added = 0;
  for (const file of images) {
    const full = path.join(folder, file);
    const parsed = parseFilename(file, artist) || {};
    const now = new Date().toISOString();

    const record = {
      title: parsed.title || opts.title,
      artist,
      year_created: parsed.year ?? null,
      type: opts.type,
      medium: parsed.medium,
      dimensions: parsed.dimensions
    };

    const detail = [record.title, record.year_created, record.medium, record.dimensions]
      .filter(Boolean).join(' · ');
    console.log(`    ${opts.dryRun ? 'would add' : 'added'}  ${detail}`);
    if (opts.dryRun) { added++; continue; }

    const bytes = fs.readFileSync(full);
    const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
    let stored;
    try { stored = await storeImage(bytes, mime); }
    catch (err) { console.log(`             ✗ skipped, unreadable image: ${err.message}`); continue; }
    const artworkId = insertArtwork.run({
      ...record, public_id: tokens.publicId('art'), owner_id: user.id, now
    }).lastInsertRowid;

    insertImage.run({ ...stored, public_id: tokens.publicId('img'), artwork_id: artworkId, created_at: now });

    // A PDF sharing this file's leading reference is its paperwork, not a separate piece.
    for (const pdf of pdfs.filter(p => leadToken(p) === leadToken(file))) {
      const pdfBytes = fs.readFileSync(path.join(folder, pdf));
      insertDocument.run(tokens.publicId('doc'), artworkId, path.basename(pdf, '.pdf'),
        uploads.writeFile(pdfBytes, 'application/pdf'), pdfBytes.length, now);
      console.log(`             ↳ attached ${pdf}`);
    }
    added++;
  }

  const orphanPdfs = pdfs.filter(p => !images.some(img => leadToken(img) === leadToken(p)));
  for (const pdf of orphanPdfs) {
    console.log(`    skipped   ${pdf} — a PDF with no matching image; export it as a JPG to include it`);
  }
  for (const file of skipped) console.log(`    skipped   ${file} — unsupported file type`);

  return added;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.email || !opts.folders.length) {
    console.error('Usage: node server/import-folder.js --name "Name" --email you@example.com --password "…" <folder> [folder…]');
    process.exit(1);
  }

  migrate({ log: () => {} });

  for (const folder of opts.folders) {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      console.error(`Not a folder: ${folder}`);
      process.exit(1);
    }
  }

  const { user, created } = findOrCreateUser({
    email: opts.email, name: opts.name, password: opts.password, dryRun: opts.dryRun
  });
  const state = created ? (opts.dryRun ? '  (would be created)' : '  (created)') : '  (existing)';
  console.log(`\n  Account: ${user.display_name || user.email} <${user.email}>${state}`);

  let total = 0;
  // Images are processed one at a time (resized and stripped of location data), so this can't be
  // a single database transaction; each piece is saved as soon as its image is ready.
  for (const folder of opts.folders) total += await importFolder(folder, user, opts);

  const count = db.prepare('SELECT COUNT(*) AS c FROM artworks WHERE owner_id = ?').get(user.id).c;
  console.log(`\n  ${opts.dryRun ? 'Would import' : 'Imported'} ${total} piece(s).` +
    (opts.dryRun ? '' : ` The account now holds ${count}.\n`));
}

main().catch(err => { console.error(err.message); process.exit(1); });
