'use strict';
// A selection of works to send a client: the "tearsheets" galleries email. One work to a page,
// large image, the facts beneath, and the price or "Sold" if the sender chose to include it.
// With more than one work, a first page lists them, with who it's for and from whom.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const sharp = require('sharp');
const fs = require('fs');
const uploads = require('./uploads');
const config = require('./../config');
const { safe, fit, wrap } = require('./pdfDocuments');

const A4 = [595.28, 841.89];
const M = 56;
const INK = rgb(0.106, 0.094, 0.078);
const INK2 = rgb(0.36, 0.33, 0.28);
const MUTED = rgb(0.48, 0.44, 0.38);
const LINE = rgb(0.89, 0.86, 0.80);
const PAPER = rgb(0.953, 0.937, 0.906);
const CADMIUM = rgb(0.81, 0.23, 0.14);
const VIRIDIAN = rgb(0.18, 0.48, 0.37);

const MAX_WORKS = 30;
const SYMBOL = { EUR: '€', GBP: '£', USD: '$' };
const money = (n, cur = 'EUR') => (n == null ? '' : (SYMBOL[cur] ? SYMBOL[cur] : `${cur} `) + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 }));

async function plate(relativePath) {
  try {
    const buf = fs.readFileSync(uploads.absolutePath(relativePath));
    return await sharp(buf, { failOn: 'none' })
      .resize(1100, 1100, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
  } catch { return null; }
}

/**
 * @param {object} o
 * @param {object} o.owner      user row (the sender)
 * @param {object} [o.client]   client row (the recipient), for "Prepared for"
 * @param {string} o.title
 * @param {Array}  o.works      [{ artwork (row), imagePath }]
 * @param {boolean} o.includePrices  asking price for works for sale
 * @param {boolean} o.includeStatus  "Available" / "Sold"
 */
async function buildSelection({ owner, client, title, works, includePrices, includeStatus }) {
  const pdf = await PDFDocument.create();
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const serifItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const from = owner.display_name || owner.email;
  const dateLong = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  pdf.setTitle(safe(title));
  pdf.setAuthor(safe(from));
  pdf.setProducer(safe(config.siteName));

  const pages = [];
  const header = (page) => {
    page.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: rgb(1, 0.992, 0.973) });
    page.drawText(fit(from, sansBold, 9, 300), { x: M, y: A4[1] - 40, size: 9, font: sansBold, color: INK });
    const d = safe(dateLong);
    page.drawText(d, { x: A4[0] - M - sans.widthOfTextAtSize(d, 9), y: A4[1] - 40, size: 9, font: sans, color: MUTED });
    page.drawLine({ start: { x: M, y: A4[1] - 50 }, end: { x: A4[0] - M, y: A4[1] - 50 }, thickness: 0.6, color: LINE });
  };
  const newPage = () => { const p = pdf.addPage(A4); header(p); pages.push(p); return p; };

  const statusLine = (a) => {
    if (!includeStatus && !includePrices) return null;
    if (a.status === 'sold') return includeStatus ? { text: 'Sold', color: CADMIUM, dot: true } : null;
    if (a.status === 'for_sale') {
      const parts = [includeStatus ? 'Available' : null, includePrices && a.asking_price != null ? money(a.asking_price, a.currency || 'EUR') : null].filter(Boolean);
      return parts.length ? { text: parts.join('  ·  '), color: VIRIDIAN, dot: includeStatus } : null;
    }
    return includeStatus ? { text: 'Not for sale', color: MUTED, dot: false } : null;
  };

  /* ---------- the list, when there's more than one ---------- */
  if (works.length > 1) {
    const p = newPage();
    let y = A4[1] - 150;
    for (const line of wrap(title, serif, 34, A4[0] - M * 2, 3)) { p.drawText(line, { x: M, y, size: 34, font: serif, color: INK }); y -= 40; }
    y -= 6;
    const sub = [client ? `Prepared for ${client.name}` : null, `${works.length} works`, `from ${from}`].filter(Boolean).join('  ·  ');
    p.drawText(fit(sub, serifItalic, 14, A4[0] - M * 2), { x: M, y, size: 14, font: serifItalic, color: INK2 });
    y -= 46;
    p.drawLine({ start: { x: M, y: y + 18 }, end: { x: A4[0] - M, y: y + 18 }, thickness: 0.6, color: LINE });
    works.forEach((w, i) => {
      if (y < 90) return;
      const a = w.artwork;
      p.drawText(String(i + 1).padStart(2, '0'), { x: M, y, size: 9, font: sans, color: MUTED });
      p.drawText(fit(a.title, serifItalic, 13, 260), { x: M + 28, y, size: 13, font: serifItalic, color: INK });
      p.drawText(fit([a.artist, a.year_created].filter(Boolean).join(', '), sans, 10, 170), { x: M + 300, y: y + 1, size: 10, font: sans, color: INK2 });
      const st = statusLine(a);
      if (st) {
        const t = fit(st.text, sans, 9.5, 120);
        p.drawText(t, { x: A4[0] - M - sans.widthOfTextAtSize(t, 9.5), y: y + 1, size: 9.5, font: sans, color: st.color });
      }
      y -= 24;
    });
    if (works.length > 28) p.drawText(safe(`and ${works.length - 28} more`), { x: M + 28, y, size: 10, font: sans, color: MUTED });
  }

  /* ---------- one work to a page ---------- */
  for (const w of works) {
    const a = w.artwork;
    const p = newPage();
    const boxTop = A4[1] - 82;
    const boxW = A4[0] - M * 2;
    const boxH = 470;
    const jpg = w.imagePath ? await plate(w.imagePath) : null;
    if (jpg) {
      const img = await pdf.embedJpg(jpg);
      const s = Math.min(boxW / img.width, boxH / img.height);
      const iw = img.width * s, ih = img.height * s;
      p.drawImage(img, { x: M + (boxW - iw) / 2, y: boxTop - ih - (boxH - ih) / 2, width: iw, height: ih });
    } else {
      p.drawRectangle({ x: M, y: boxTop - boxH, width: boxW, height: boxH, color: PAPER });
      const t = 'No image';
      p.drawText(t, { x: A4[0] / 2 - serifItalic.widthOfTextAtSize(t, 16) / 2, y: boxTop - boxH / 2, size: 16, font: serifItalic, color: MUTED });
    }

    let y = boxTop - boxH - 46;
    p.drawText(fit(a.artist, sansBold, 11, boxW), { x: M, y, size: 11, font: sansBold, color: INK });
    y -= 26;
    const titleLine = [a.title, a.year_created].filter(Boolean).join(', ');
    for (const line of wrap(titleLine, serifItalic, 22, boxW, 2)) { p.drawText(line, { x: M, y, size: 22, font: serifItalic, color: INK }); y -= 26; }
    y -= 4;
    for (const fact of [a.medium, a.dimensions, a.inventory_number ? `Inv. ${a.inventory_number}` : null].filter(Boolean)) {
      p.drawText(fit(fact, sans, 10.5, boxW), { x: M, y, size: 10.5, font: sans, color: INK2 });
      y -= 15;
    }
    const st = statusLine(a);
    if (st) {
      y -= 8;
      let x = M;
      if (st.dot) { p.drawCircle({ x: M + 4, y: y + 3.5, size: 4, color: st.color }); x += 14; }
      p.drawText(safe(st.text), { x, y, size: 11, font: sansBold, color: st.color });
    }
  }

  const contact = [from, owner.email].filter(Boolean).join('  ·  ');
  pages.forEach((p, i) => {
    p.drawText(fit(contact, sans, 8.5, 380), { x: M, y: 34, size: 8.5, font: sans, color: MUTED });
    const n = `${i + 1} / ${pages.length}`;
    p.drawText(n, { x: A4[0] - M - sans.widthOfTextAtSize(n, 8.5), y: 34, size: 8.5, font: sans, color: MUTED });
  });

  return Buffer.from(await pdf.save());
}

module.exports = { buildSelection, MAX_WORKS };
