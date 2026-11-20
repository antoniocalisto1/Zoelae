'use strict';
// Every image a collector uploads passes through here before it is stored.
//
//  * It is decoded by sharp, so anything that isn't really an image is refused.
//  * It is turned the right way up (phones record rotation as metadata) and re-encoded, which drops
//    all metadata: camera, date, and GPS coordinates. A phone photo of a painting at home often
//    carries the home's location, and shared-link viewers receive these files.
//  * SVG is rasterised to PNG. An SVG served from our own origin can carry script.
//  * Two smaller copies are made: a thumbnail for the grid and a display size for detail pages
//    and shared links, so nobody downloads a 12 MB photo to see a 300 px card.
const fs = require('fs');
const sharp = require('sharp');
const { db } = require('./../db');
const uploads = require('./uploads');

const SIZES = { display: 1600, thumb: 480 };
const MAX_ORIGINAL = 6000;
const INPUT = { failOn: 'error', limitInputPixels: 120_000_000 };

class ImageError extends Error {}

/** Decode, orient and strip. Returns { original, display, thumb } buffers with types and size. */
async function processImage(buffer, mimetype) {
  const isSvg = mimetype === 'image/svg+xml';
  const open = () => sharp(buffer, { ...INPUT, ...(isSvg ? { density: 144 } : {}), animated: false });

  let meta;
  try { meta = await open().metadata(); } catch { throw new ImageError('That file isn’t an image we can read. Try a JPEG, PNG or WebP.'); }
  if (!meta.width || !meta.height) throw new ImageError('That image has no size we can read.');

  const oriented = () => open().rotate();          // apply EXIF orientation, then forget it

  // The original keeps its resolution (within reason) and, where it makes sense, its format.
  let original;
  const capped = (s) => s.resize({ width: MAX_ORIGINAL, height: MAX_ORIGINAL, fit: 'inside', withoutEnlargement: true });
  if (meta.format === 'jpeg') original = { buffer: await capped(oriented()).jpeg({ quality: 92, mozjpeg: true }).toBuffer(), mime: 'image/jpeg' };
  else if (meta.format === 'webp') original = { buffer: await capped(oriented()).webp({ quality: 92 }).toBuffer(), mime: 'image/webp' };
  else original = { buffer: await capped(oriented()).png().toBuffer(), mime: 'image/png' };   // png, gif, svg, others

  const variant = (size, quality) => oriented()
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();

  const info = await sharp(original.buffer).metadata();
  return {
    original,
    display: { buffer: await variant(SIZES.display, 84), mime: 'image/webp' },
    thumb: { buffer: await variant(SIZES.thumb, 78), mime: 'image/webp' },
    width: info.width,
    height: info.height
  };
}

/** Store all three sizes; returns the columns for an artwork_images row. */
async function storeImage(buffer, mimetype) {
  const p = await processImage(buffer, mimetype);
  return {
    file_path: uploads.writeFile(p.original.buffer, p.original.mime),
    display_path: uploads.writeFile(p.display.buffer, p.display.mime),
    thumb_path: uploads.writeFile(p.thumb.buffer, p.thumb.mime),
    mime_type: p.original.mime,
    byte_size: p.original.buffer.length,
    width: p.width,
    height: p.height
  };
}

/** Images attached as documents (a photographed certificate) are stripped too, but not resized. */
async function stripDocumentImage(buffer, mimetype) {
  if (!mimetype.startsWith('image/')) return { buffer, mime: mimetype };
  try {
    const s = sharp(buffer, INPUT).rotate();
    if (mimetype === 'image/jpeg') return { buffer: await s.jpeg({ quality: 92 }).toBuffer(), mime: 'image/jpeg' };
    if (mimetype === 'image/webp') return { buffer: await s.webp({ quality: 92 }).toBuffer(), mime: 'image/webp' };
    return { buffer: await s.png().toBuffer(), mime: 'image/png' };
  } catch {
    throw new ImageError('One of the documents isn’t an image or PDF we can read.');
  }
}

/**
 * Which stored file to send for a requested size, with its type. Falls back to the original for
 * images whose smaller copies haven't been made yet.
 */
function variantOf(row, size) {
  if (size === 'thumb' && row.thumb_path) return { file_path: row.thumb_path, mime_type: 'image/webp' };
  if (size !== 'original' && row.display_path) return { file_path: row.display_path, mime_type: 'image/webp' };
  return { file_path: row.file_path, mime_type: row.mime_type };
}

/** Files belonging to an image row, for deletion. */
const filesOf = (row) => [row.file_path, row.display_path, row.thumb_path].filter(Boolean);

/**
 * Images uploaded before this pipeline existed have no smaller copies. Make them in the
 * background at startup; until then the original is served in their place.
 */
async function backfillVariants({ log = console.log } = {}) {
  const rows = db.prepare('SELECT * FROM artwork_images WHERE thumb_path IS NULL OR display_path IS NULL').all();
  if (!rows.length) return 0;
  const update = db.prepare('UPDATE artwork_images SET display_path = ?, thumb_path = ?, width = ?, height = ? WHERE id = ?');
  let done = 0;
  for (const row of rows) {
    try {
      const buf = fs.readFileSync(uploads.absolutePath(row.file_path));
      const p = await processImage(buf, row.mime_type);
      update.run(uploads.writeFile(p.display.buffer, p.display.mime), uploads.writeFile(p.thumb.buffer, p.thumb.mime),
        p.width, p.height, row.id);
      done++;
    } catch (err) {
      log(`  could not make smaller copies of image ${row.public_id}: ${err.message}`);
    }
  }
  if (done) log(`Made smaller copies of ${done} earlier image${done === 1 ? '' : 's'}.`);
  return done;
}

module.exports = { processImage, storeImage, variantOf, stripDocumentImage, filesOf, backfillVariants, ImageError, SIZES };
