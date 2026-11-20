'use strict';
// Generates the paid one-off documents: an insurance schedule and an estate inventory.
// Deliberately plain — this is a document somebody forwards to a broker or a solicitor, so it
// wants to be legible and complete rather than designed.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const sharp = require('sharp');
const fs = require('fs');
const uploads = require('./uploads');
const { DOCUMENT_KINDS } = require('./entitlements');

const A4 = [595.28, 841.89];
const MARGIN = 48;
const INK = rgb(0.08, 0.09, 0.11);
const MUTED = rgb(0.42, 0.45, 0.50);
const LINE = rgb(0.86, 0.87, 0.89);
const ACCENT = rgb(0.54, 0.42, 0.27);

// The standard PDF fonts encode WinAnsi only, so a name like "Věra Nowak" would throw. Latin-1
// characters pass through untouched; anything beyond it is decomposed to its base letter.
const SAFE_EXTRAS = new Set([0x2018, 0x2019, 0x201C, 0x201D, 0x2013, 0x2014, 0x2022, 0x20AC, 0x2026]);
function safe(text) {
  return String(text == null ? '' : text).split('').map(ch => {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || SAFE_EXTRAS.has(cp)) return ch;
    const stripped = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const scp = stripped.codePointAt(0);
    return (scp >= 0x20 && scp <= 0x7e) ? stripped : '?';
  }).join('');
}

const money = (n, currency = 'EUR') => {
  if (n === null || n === undefined) return '—';
  const symbol = { EUR: '€', GBP: '£', USD: '$' }[currency] || '';
  return symbol + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });
};

/** Cuts a string to fit a width in the given font, adding an ellipsis if it had to. */
function fit(text, font, size, maxWidth) {
  let s = safe(text);
  if (font.widthOfTextAtSize(s, size) <= maxWidth) return s;
  while (s.length > 1 && font.widthOfTextAtSize(s + '…', size) > maxWidth) s = s.slice(0, -1);
  return s + '…';
}

/** Greedy wrap into at most `maxLines` lines. */
function wrap(text, font, size, maxWidth, maxLines) {
  const words = safe(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) { line = next; continue; }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.length) {
    const last = lines[maxLines - 1];
    if (font.widthOfTextAtSize(last, size) > maxWidth - 10) lines[maxLines - 1] = fit(last, font, size, maxWidth);
  }
  return lines;
}

/** Everything becomes a JPEG at a sensible size — this is also what makes SVG plates printable. */
async function thumbnail(relativePath) {
  try {
    const buf = fs.readFileSync(uploads.absolutePath(relativePath));
    return await sharp(buf, { failOn: 'none' })
      .resize(260, 200, { fit: 'inside', withoutEnlargement: true, background: '#ffffff' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 78 })
      .toBuffer();
  } catch {
    return null;                       // a missing or unreadable image just leaves an empty frame
  }
}

/**
 * The wordmark: the site name in spaced capitals, set in the standard Times face so the PDF needs
 * no embedded font file. `y` is the baseline.
 */
function drawMark(page, x, y, size, font) {
  const name = safe(require('./../config').siteName).toUpperCase();
  let at = x;
  for (const ch of name) {
    page.drawText(ch, { x: at, y, size, font, color: INK });
    at += font.widthOfTextAtSize(ch, size) + size * 0.34;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.kind          insurance_schedule | estate_inventory
 * @param {object} opts.owner         the user row
 * @param {Array}  opts.pieces        [{ artwork, imagePath }]
 * @returns {Promise<{bytes:Buffer, pieceCount:number, totalValue:number, title:string}>}
 */
async function buildDocument({ kind, owner, pieces }) {
  const spec = DOCUMENT_KINDS[kind];
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const showProvenance = spec.sections.includes('provenance');
  const generatedOn = new Date();
  const dateLong = generatedOn.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const valued = pieces.filter(p => p.artwork.current_valuation != null);
  const totalValue = valued.reduce((sum, p) => sum + Number(p.artwork.current_valuation), 0);
  const totalInsured = pieces.reduce((sum, p) => sum + (Number(p.artwork.insured_value) || 0), 0);
  const ownerName = owner.display_name || owner.email;

  const pageNumbers = [];
  function newPage() {
    const page = pdf.addPage(A4);
    pageNumbers.push(page);
    return page;
  }

  /* ---------- cover ---------- */
  const cover = newPage();
  const W = A4[0];
  const markTop = A4[1] - MARGIN;
  drawMark(cover, MARGIN, markTop - 18, 14, await pdf.embedFont(StandardFonts.TimesRoman));

  cover.drawText(safe(spec.name), { x: MARGIN, y: A4[1] - 250, size: 32, font: bold, color: INK });
  cover.drawLine({
    start: { x: MARGIN, y: A4[1] - 274 }, end: { x: W - MARGIN, y: A4[1] - 274 },
    thickness: 0.8, color: LINE
  });

  const coverRows = [
    ['Prepared for', ownerName],
    ['Date', dateLong],
    ['Pieces', String(pieces.length)],
    ['Total valuation', valued.length ? money(totalValue) + `  (${valued.length} of ${pieces.length} valued)` : 'Not recorded'],
  ];
  if (kind === 'insurance_schedule') {
    coverRows.push(['Total insured value', totalInsured ? money(totalInsured) : 'Not recorded']);
  }

  let cy = A4[1] - 320;
  for (const [label, value] of coverRows) {
    cover.drawText(safe(label), { x: MARGIN, y: cy, size: 9, font, color: MUTED });
    cover.drawText(fit(value, bold, 14, W - MARGIN * 2), { x: MARGIN, y: cy - 17, size: 14, font: bold, color: INK });
    cy -= 46;
  }

  for (const [i, line] of wrap(spec.summary, font, 10.5, W - MARGIN * 2 - 120, 3).entries()) {
    cover.drawText(line, { x: MARGIN, y: 150 - i * 15, size: 10.5, font, color: MUTED });
  }

  /* ---------- the pieces ---------- */
  const ROW_H = 86;
  const IMG_W = 94, IMG_H = 70;
  let page = null;
  let y = 0;

  function startBodyPage() {
    page = newPage();
    page.drawText(safe(spec.name), { x: MARGIN, y: A4[1] - 54, size: 10, font: bold, color: INK });
    page.drawText(safe(ownerName + '  ·  ' + dateLong), {
      x: MARGIN, y: A4[1] - 68, size: 9, font, color: MUTED
    });
    page.drawLine({
      start: { x: MARGIN, y: A4[1] - 80 }, end: { x: W - MARGIN, y: A4[1] - 80 },
      thickness: 0.8, color: LINE
    });
    y = A4[1] - 104;
  }

  startBodyPage();

  for (const [index, piece] of pieces.entries()) {
    if (y - ROW_H < 70) startBodyPage();

    const a = piece.artwork;
    const top = y;

    // index
    page.drawText(String(index + 1).padStart(2, '0'), { x: MARGIN, y: top - 10, size: 9, font, color: MUTED });

    // image
    const imgX = MARGIN + 22;
    page.drawRectangle({
      x: imgX, y: top - IMG_H, width: IMG_W, height: IMG_H,
      borderColor: LINE, borderWidth: 0.8, color: rgb(0.98, 0.98, 0.98)
    });
    const jpg = piece.imagePath ? await thumbnail(piece.imagePath) : null;
    if (jpg) {
      const embedded = await pdf.embedJpg(jpg);
      const scale = Math.min((IMG_W - 6) / embedded.width, (IMG_H - 6) / embedded.height);
      const w = embedded.width * scale, h = embedded.height * scale;
      page.drawImage(embedded, {
        x: imgX + (IMG_W - w) / 2, y: top - IMG_H + (IMG_H - h) / 2, width: w, height: h
      });
    }

    // text block
    const tx = imgX + IMG_W + 16;
    const rightColX = W - MARGIN - 120;
    const textW = rightColX - tx - 14;

    page.drawText(fit(a.title, bold, 12, textW), { x: tx, y: top - 12, size: 12, font: bold, color: INK });
    page.drawText(fit(`${a.artist}${a.year_created ? ', ' + a.year_created : ''}`, font, 10, textW),
      { x: tx, y: top - 27, size: 10, font, color: MUTED });

    const detail = [a.type, a.medium, a.dimensions].filter(Boolean).join('  ·  ');
    page.drawText(fit(detail, font, 9, textW), { x: tx, y: top - 41, size: 9, font, color: MUTED });

    if (showProvenance) {
      const prov = [a.acquired_from && 'Acquired from ' + a.acquired_from, a.prior_owners]
        .filter(Boolean).join('  ·  ') || 'No provenance recorded';
      wrap(prov, font, 8.5, textW, 2).forEach((line, i) => {
        page.drawText(line, { x: tx, y: top - 55 - i * 11, size: 8.5, font, color: MUTED });
      });
    } else if (a.storage_location) {
      page.drawText(fit('Location: ' + a.storage_location, font, 8.5, textW),
        { x: tx, y: top - 55, size: 8.5, font, color: MUTED });
    }

    // values, right aligned
    const rows = [['Valuation', money(a.current_valuation, a.currency)]];
    if (kind === 'insurance_schedule') rows.push(['Insured', money(a.insured_value, a.currency)]);
    else rows.push(['Paid', money(a.purchase_price, a.currency)]);

    rows.forEach(([label, value], i) => {
      const vy = top - 12 - i * 22;
      page.drawText(label, { x: rightColX, y: vy + 10, size: 7.5, font, color: MUTED });
      const width = bold.widthOfTextAtSize(value, 11);
      page.drawText(value, { x: W - MARGIN - width, y: vy - 2, size: 11, font: bold, color: INK });
    });

    page.drawLine({
      start: { x: MARGIN, y: top - ROW_H + 10 }, end: { x: W - MARGIN, y: top - ROW_H + 10 },
      thickness: 0.5, color: LINE
    });
    y -= ROW_H;
  }

  /* ---------- totals ---------- */
  if (y - 80 < 70) startBodyPage();
  page.drawLine({ start: { x: MARGIN, y: y - 4 }, end: { x: W - MARGIN, y: y - 4 }, thickness: 1.4, color: ACCENT });
  page.drawText('Total', { x: MARGIN, y: y - 26, size: 12, font: bold, color: INK });
  page.drawText(`${pieces.length} piece${pieces.length === 1 ? '' : 's'}`,
    { x: MARGIN + 50, y: y - 26, size: 10, font, color: MUTED });

  const totalText = valued.length ? money(totalValue) : 'Not recorded';
  page.drawText(totalText, {
    x: W - MARGIN - bold.widthOfTextAtSize(totalText, 16), y: y - 28, size: 16, font: bold, color: INK
  });
  if (kind === 'insurance_schedule' && totalInsured) {
    const insuredText = 'Insured ' + money(totalInsured);
    page.drawText(insuredText, {
      x: W - MARGIN - font.widthOfTextAtSize(insuredText, 9.5), y: y - 44, size: 9.5, font, color: MUTED
    });
  }

  /* ---------- footers ---------- */
  pageNumbers.forEach((p, i) => {
    p.drawText(safe(`Generated by Zoelae on ${dateLong}`), { x: MARGIN, y: 40, size: 8, font, color: MUTED });
    const label = `${i + 1} / ${pageNumbers.length}`;
    p.drawText(label, { x: W - MARGIN - font.widthOfTextAtSize(label, 8), y: 40, size: 8, font, color: MUTED });
  });

  return {
    bytes: Buffer.from(await pdf.save()),
    pieceCount: pieces.length,
    totalValue: valued.length ? totalValue : null,
    title: spec.name
  };
}

module.exports = { buildDocument, safe, fit, wrap, drawMark };
