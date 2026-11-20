'use strict';
// Reading a collector's or gallery's own spreadsheet: Excel (.xlsx) or CSV.
//
// Nobody's sheet looks like anybody else's, so nothing here assumes a layout. The header row is
// found, each column is matched to a Zoelae field by its name, and the person checks the match
// before anything is saved. Values are read forgivingly: "€12.400,00", "c. 1975", "NFS", a real
// Excel date or a typed one all come out as what was meant.
const ExcelJS = require('exceljs');

class SheetError extends Error {}

const MAX_ROWS = 2000;

/* ---------- the fields a sheet can fill ---------- */

// Synonyms are compared after normalising: lower case, accents and punctuation removed.
const ARTWORK_FIELDS = [
  { key: 'title', label: 'Title', required: true, syn: ['title', 'titulo', 'titre', 'work', 'artwork', 'name of work', 'work title', 'piece'] },
  { key: 'artist', label: 'Artist', required: true, syn: ['artist', 'artista', 'artiste', 'maker', 'creator', 'author', 'artist name'] },
  { key: 'year', label: 'Year', syn: ['year', 'date', 'ano', 'annee', 'year created', 'date of work', 'dated', 'circa'] },
  { key: 'type', label: 'Type', syn: ['type', 'category', 'medium type', 'classification', 'object type', 'tipo'] },
  { key: 'medium', label: 'Medium', syn: ['medium', 'media', 'materials', 'technique', 'tecnica', 'material'] },
  { key: 'dimensions', label: 'Dimensions', syn: ['dimensions', 'size', 'dims', 'measurements', 'dimensoes', 'h x w', 'hxw'] },
  { key: 'inventoryNumber', label: 'Inventory no.', syn: ['inventory', 'inventory number', 'inventory no', 'inv', 'inv no', 'stock', 'stock number', 'stock no', 'ref', 'reference', 'ref no', 'catalogue number', 'cat no', 'id', 'code', 'sku', 'object number', 'accession number'] },
  { key: 'status', label: 'Status', syn: ['status', 'availability', 'available', 'for sale', 'sold', 'estado', 'disponibilidade'] },
  { key: 'askingPrice', label: 'Asking price', syn: ['asking price', 'retail', 'retail price', 'sale price', 'selling price', 'list price', 'price', 'preco', 'prix'] },
  { key: 'purchasePrice', label: 'Price paid', syn: ['price paid', 'purchase price', 'cost', 'bought for', 'acquisition price', 'paid', 'net', 'net price'] },
  { key: 'currentValuation', label: 'Current valuation', syn: ['valuation', 'current valuation', 'value', 'market value', 'estimate', 'fair market value', 'current value'] },
  { key: 'insuredValue', label: 'Insured value', syn: ['insured value', 'insurance value', 'insured', 'insurance'] },
  { key: 'currency', label: 'Currency', syn: ['currency', 'ccy', 'moeda', 'devise'] },
  { key: 'soldPrice', label: 'Sold price', syn: ['sold price', 'sale amount', 'sold for', 'final price'] },
  { key: 'soldAt', label: 'Date sold', syn: ['date sold', 'sold date', 'sale date', 'sold on'] },
  { key: 'acquiredAt', label: 'Date acquired', syn: ['date acquired', 'acquired', 'acquisition date', 'purchase date', 'date of purchase', 'date bought'] },
  { key: 'acquiredFrom', label: 'Acquired from', syn: ['acquired from', 'source', 'vendor', 'seller', 'purchased from', 'bought from', 'consignor', 'gallery'] },
  { key: 'provenance', label: 'Provenance', syn: ['provenance', 'history', 'ownership history'] },
  { key: 'priorOwners', label: 'Prior owners', syn: ['prior owners', 'previous owners', 'former owners'] },
  { key: 'exhibitionHistory', label: 'Exhibitions', syn: ['exhibitions', 'exhibition history', 'exhibited', 'shows'] },
  { key: 'storageLocation', label: 'Location', syn: ['location', 'storage', 'storage location', 'where', 'room', 'shelf', 'localizacao'] },
  { key: 'notes', label: 'Notes', syn: ['notes', 'note', 'comments', 'comment', 'remarks', 'description', 'condition', 'notas'] },
  { key: 'image', label: 'Image file name', syn: ['image', 'image file', 'image filename', 'filename', 'file name', 'file', 'photo', 'photograph', 'picture', 'imagem', 'foto'] }
];

const CLIENT_FIELDS = [
  { key: 'name', label: 'Name', required: true, syn: ['name', 'full name', 'client', 'client name', 'contact', 'contact name', 'nome', 'nom'] },
  { key: 'firstName', label: 'First name', syn: ['first name', 'first', 'given name', 'forename', 'primeiro nome', 'prenom'] },
  { key: 'lastName', label: 'Last name', syn: ['last name', 'last', 'surname', 'family name', 'apelido', 'nom de famille'] },
  { key: 'email', label: 'Email', syn: ['email', 'e mail', 'email address', 'mail', 'correio'] },
  { key: 'phone', label: 'Phone', syn: ['phone', 'telephone', 'tel', 'mobile', 'cell', 'telefone', 'telemovel'] },
  { key: 'company', label: 'Company', syn: ['company', 'organisation', 'organization', 'institution', 'business', 'empresa', 'gallery', 'museum'] },
  { key: 'city', label: 'City', syn: ['city', 'town', 'cidade', 'ville'] },
  { key: 'country', label: 'Country', syn: ['country', 'pais', 'pays', 'nation'] },
  { key: 'interests', label: 'Interests', syn: ['interests', 'interest', 'collects', 'artists of interest', 'preferences', 'tags', 'budget'] },
  { key: 'notes', label: 'Notes', syn: ['notes', 'note', 'comments', 'remarks'] }
];

const FIELDS = { artworks: ARTWORK_FIELDS, clients: CLIENT_FIELDS };

const norm = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ---------- reading the file ---------- */

/** Excel cells come in several shapes; reduce each to a string, number or Date. */
function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('').trim();
    if ('result' in v) return cellValue(v.result);                // formula
    if ('text' in v) return cellValue(v.text);                    // hyperlink
    if ('error' in v) return '';
  }
  return String(v).trim();
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  // Pick the delimiter that splits the first line most: comma, semicolon (common in Europe) or tab.
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field.trim()); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field.trim()); rows.push(row); }
  return rows;
}

function decodeText(buffer) {
  const utf8 = buffer.toString('utf8');
  // Excel on Windows often saves CSV as Windows-1252; replacement characters give it away.
  return utf8.includes('�') ? buffer.toString('latin1') : utf8;
}

/**
 * @returns {{ sheetName, headers: string[], rows: any[][], lines: number[], embedded: Map<number, {buffer, extension}> }}
 *   rows are the data rows below the header; `embedded` maps a data-row index to a picture
 *   placed in that row of an Excel sheet.
 */
async function readSheet(buffer, filename) {
  const name = String(filename || '').toLowerCase();
  let grid = [];
  let sheetName = '';
  const embeddedByRow = new Map();     // sheet row index (0-based) -> image

  if (name.endsWith('.xls') || name.endsWith('.numbers') || name.endsWith('.ods')) {
    throw new SheetError('That format can’t be read. In Excel, Numbers or Google Sheets, choose File → Save As (or Download) → Excel workbook (.xlsx) or CSV, and upload that.');
  }
  if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
    grid = parseCsv(decodeText(buffer));
    sheetName = filename;
  } else {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer); }
    catch { throw new SheetError('That file isn’t an Excel workbook we can read. Save it as .xlsx or CSV and try again.'); }
    // The first sheet that has something in it.
    const ws = wb.worksheets.find(w => w.actualRowCount > 0) || wb.worksheets[0];
    if (!ws) throw new SheetError('That workbook has no sheets.');
    sheetName = ws.name;
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, c) => { vals[c - 1] = cellValue(cell.value); });
      grid[n - 1] = Array.from(vals, v => (v === undefined ? '' : v));
    });
    grid = Array.from(grid, r => r || []);
    // Pictures placed in cells: many gallery stock sheets carry a thumbnail per row.
    for (const img of ws.getImages()) {
      const media = wb.getImage(Number(img.imageId));
      const r = Math.floor(img.range?.tl?.nativeRow ?? img.range?.tl?.row ?? -1);
      if (media?.buffer && r >= 0 && !embeddedByRow.has(r)) embeddedByRow.set(r, { buffer: Buffer.from(media.buffer), extension: media.extension });
    }
  }

  const filled = (r) => (r || []).filter(v => v !== '' && v !== null && v !== undefined).length;
  // The header is the first of the opening rows with at least two filled cells, mostly text.
  const headerIndex = grid.slice(0, 15).findIndex(r => filled(r) >= 2 && r.filter(v => typeof v === 'string' && v).length >= filled(r) * 0.6);
  if (headerIndex < 0) throw new SheetError('We couldn’t find a row of column headings. Put names like Title, Artist and Year in the first row.');

  const width = Math.max(...grid.slice(headerIndex, headerIndex + MAX_ROWS + 1).map(r => r.length));
  const headers = Array.from({ length: width }, (_, i) => String(grid[headerIndex][i] ?? '').trim() || `Column ${String.fromCharCode(65 + (i % 26))}`);

  const rows = [];
  const lines = [];                    // the spreadsheet row number of each data row, for messages
  const embedded = new Map();
  for (let i = headerIndex + 1; i < grid.length; i++) {
    if (!filled(grid[i])) continue;
    lines.push(i + 1);
    if (rows.length >= MAX_ROWS) throw new SheetError(`That sheet has more than ${MAX_ROWS} rows. Split it into smaller sheets and import them one after another.`);
    if (embeddedByRow.has(i)) embedded.set(rows.length, embeddedByRow.get(i));
    rows.push(Array.from({ length: width }, (_, c) => grid[i][c] ?? ''));
  }
  if (!rows.length) throw new SheetError('The sheet has headings but no rows underneath them.');
  return { sheetName, headers, rows, lines, embedded };
}

/* ---------- matching columns to fields ---------- */

function guessMapping(headers, kind, { accountType } = {}) {
  let fields = FIELDS[kind];
  // A bare "Price" column means what was paid to a collector, and the asking price to a seller.
  if (kind === 'artworks' && accountType !== 'gallery' && accountType !== 'artist') {
    fields = fields.map(f => (f.key === 'askingPrice' ? { ...f, syn: f.syn.filter(x => x !== 'price') }
      : f.key === 'purchasePrice' ? { ...f, syn: [...f.syn, 'price'] } : f));
  }
  const mapping = Array(headers.length).fill('');
  const taken = new Set();
  const h = headers.map(norm);
  // Exact synonym first, then "contains", so "Price paid (EUR)" still finds price paid.
  for (const pass of ['exact', 'contains']) {
    for (const f of fields) {
      if (taken.has(f.key)) continue;
      const i = h.findIndex((name, idx) => !mapping[idx] && f.syn.some(s => (pass === 'exact' ? name === s : (` ${name} `).includes(` ${s} `))));
      if (i >= 0) { mapping[i] = f.key; taken.add(f.key); }
    }
  }
  return mapping;
}

/* ---------- reading values ---------- */

/** "€12.400,50", "12,400", "$ 3k" → number. Returns null for blanks and NaN. */
function parseMoney(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').trim().toLowerCase();
  if (!s || /^(n\/?a|nfs|poa|tbc|—|-|–|none|unknown)$/.test(s)) return null;
  let mult = 1;
  if (/\d\s*k$/.test(s)) { mult = 1000; s = s.replace(/k$/, ''); }
  if (/\d\s*m$/.test(s)) { mult = 1e6; s = s.replace(/m$/, ''); }
  s = s.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // whichever comes last is the decimal mark
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // "12,400" is thousands; "12,5" or "1.234,56"-style single comma with 1–2 digits after is decimal
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if ((s.match(/\./g) || []).length > 1 || /^-?[1-9]\d{0,2}\.\d{3}$/.test(s)) {
    // "1.234.567", or "12.400": in prices a single dot before exactly three digits is a thousands mark
    s = s.replace(/\./g, '');
  }
  const n = Number(s) * mult;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** "c. 1975", "1975–78", 1975, a Date → 1975. */
function parseYear(v) {
  if (v instanceof Date) return v.getUTCFullYear();
  if (typeof v === 'number') return v >= 1 && v <= 3000 && Number.isInteger(v) ? v : null;
  const m = String(v ?? '').match(/(?<!\d)(1[0-9]{3}|20[0-9]{2})(?!\d)/);
  return m ? Number(m[1]) : null;
}

/** A real Excel date, an ISO date, 31/12/2024, 12/31/2024 or "March 2021" → YYYY-MM-DD. */
function parseDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) {        // an Excel serial that wasn't typed as a date
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
    // Day first unless that's impossible (most of the world writes 31/12).
    let d = Number(a), mo = Number(b);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  const y = parseYear(s);
  return y ? `${y}-01-01` : null;
}

function parseStatus(v) {
  const s = norm(v);
  if (!s) return null;
  if (/\b(sold|vendid|vendu|verkauft)\b/.test(s)) return 'sold';
  if (/\b(not for sale|nfs|collection|private|kept|owned|in house|personal)\b/.test(s)) return 'collection';
  if (/\b(for sale|available|avail|on sale|on consignment|consigned|a venda|disponivel|disponible|yes|y|true)\b/.test(s)) return 'for_sale';
  if (/\b(reserved|on hold|hold)\b/.test(s)) return 'for_sale';
  return null;
}

const TYPE_WORDS = [
  ['Photography', /photo|c-?print|gelatin silver|chromogenic|archival pigment|inkjet|platinum print|daguerreotype|polaroid/],
  ['Print', /\bprint\b|lithograph|etching|screen ?print|serigraph|woodcut|linocut|engraving|aquatint|monotype|giclee|drypoint/],
  ['Sculpture', /sculpt|bronze|marble|stone|ceramic|porcelain|terracotta|wood carving|cast|installation|resin|steel|assemblage/],
  ['Work on paper', /paper|watercolou?r|gouache|charcoal|pastel|pencil|graphite|ink|drawing|collage/],
  ['Painting', /paint|oil|acrylic|tempera|canvas|panel|linen|encaustic|enamel/]
];
const TYPES = ['Painting', 'Sculpture', 'Work on paper', 'Print', 'Photography', 'Other'];

function parseType(typeValue, mediumValue) {
  const t = norm(typeValue);
  if (t) {
    const exact = TYPES.find(x => norm(x) === t);
    if (exact) return exact;
    for (const [type, re] of TYPE_WORDS) if (re.test(t)) return type;
  }
  const m = norm(mediumValue);
  for (const [type, re] of TYPE_WORDS) if (re.test(m)) return type;
  return t ? 'Other' : 'Painting';
}

const CURRENCIES = new Set(['EUR', 'USD', 'GBP', 'CHF', 'ZAR', 'JPY', 'CNY', 'HKD', 'SGD', 'AUD', 'CAD', 'NZD', 'SEK', 'NOK', 'DKK',
  'BRL', 'MXN', 'INR', 'IDR', 'AED', 'KRW', 'TWD', 'PLN', 'CZK', 'HUF', 'ILS', 'TRY', 'ARS', 'CLP', 'COP', 'NGN', 'KES', 'MAD', 'EGP']);
const SYMBOLS = [['€', 'EUR'], ['£', 'GBP'], ['US$', 'USD'], ['HK$', 'HKD'], ['A$', 'AUD'], ['C$', 'CAD'], ['S$', 'SGD'], ['R$', 'BRL'],
  ['$', 'USD'], ['¥', 'JPY'], ['₹', 'INR'], ['CHF', 'CHF'], ['RP', 'IDR'], ['R', 'ZAR']];

function parseCurrency(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (!s) return null;
  const code = s.match(/\b[A-Z]{3}\b/);
  if (code && CURRENCIES.has(code[0])) return code[0];
  if (s === 'EURO' || s === 'EUROS') return 'EUR';
  // a currency column holding a symbol: "€", "US$", "R"
  const sym = SYMBOLS.find(([mark]) => s === mark || (!/^[A-Z]+$/.test(mark) && s.startsWith(mark)));
  return sym ? sym[1] : null;
}
/** A price typed as "R 85,000" or "€24.000" says its currency; "NFS" says nothing. */
const currencyHint = (...vals) => vals.map(v => {
  if (typeof v !== 'string' || !/\d/.test(v)) return null;
  const mark = v.replace(/[\d.,\s'-]/g, '').toUpperCase();
  if (!mark) return null;
  if (CURRENCIES.has(mark)) return mark;
  const sym = SYMBOLS.find(([m]) => m === mark);
  return sym ? sym[1] : null;
}).find(Boolean) || null;

const text = (v, max = 2000) => {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim();
  return s ? s.slice(0, max) : '';
};

/**
 * One sheet row → the body the artworks route already understands, plus the image file names
 * the row points at. `problems` are reasons the row can't be imported; `warnings` don't stop it.
 */
function artworkFromRow(row, mapping) {
  const get = (key) => { const i = mapping.indexOf(key); return i >= 0 ? row[i] : ''; };
  const problems = [];
  const warnings = [];

  const title = text(get('title'), 200) || 'Untitled';
  const artist = text(get('artist'), 200);
  if (!artist) problems.push('no artist');

  const rawYear = get('year');
  const year = parseYear(rawYear);
  if (text(rawYear) && year === null) warnings.push(`year “${text(rawYear, 30)}” not understood`);
  if (year !== null && year > new Date().getFullYear()) { problems.push(`year ${year} is in the future`); }

  const money = (key) => {
    const raw = get(key);
    const n = parseMoney(raw);
    if (text(raw) && n === null && !/^(n\/?a|nfs|poa|tbc)$/i.test(text(raw))) warnings.push(`${key.replace(/([A-Z])/g, ' $1').toLowerCase()} “${text(raw, 30)}” not understood`);
    return n;
  };
  const askingPrice = money('askingPrice');
  const soldPrice = money('soldPrice');
  let status = parseStatus(get('status'));
  if (!status) status = soldPrice != null || text(get('soldAt')) ? 'sold' : (mapping.includes('askingPrice') && askingPrice != null ? 'for_sale' : 'collection');
  // On a stock list, the one price beside a sold work is what it sold for.
  const soldFor = status === 'sold' && soldPrice == null ? askingPrice : soldPrice;

  const imageCell = text(get('image'), 1000);
  const images = imageCell ? imageCell.split(/[;,|\n]+/).map(s => s.trim()).filter(Boolean) : [];

  const body = {
    title, artist,
    year: year ?? '',
    type: parseType(get('type'), get('medium')),
    medium: text(get('medium'), 200),
    dimensions: text(get('dimensions'), 120),
    inventoryNumber: text(get('inventoryNumber'), 60),
    status,
    askingPrice: askingPrice ?? '',
    soldPrice: soldFor ?? '',
    soldAt: parseDate(get('soldAt')) || '',
    purchasePrice: money('purchasePrice') ?? '',
    currentValuation: money('currentValuation') ?? '',
    insuredValue: money('insuredValue') ?? '',
    currency: parseCurrency(get('currency')) || currencyHint(get('askingPrice'), get('purchasePrice'), get('currentValuation')) || 'EUR',
    acquiredAt: parseDate(get('acquiredAt')) || '',
    acquiredFrom: text(get('acquiredFrom'), 300),
    provenance: text(get('provenance'), 4000),
    priorOwners: text(get('priorOwners'), 2000),
    exhibitionHistory: text(get('exhibitionHistory'), 4000),
    storageLocation: text(get('storageLocation'), 300),
    notes: text(get('notes'), 4000)
  };
  return { body, images, problems, warnings };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function clientFromRow(row, mapping) {
  const get = (key) => { const i = mapping.indexOf(key); return i >= 0 ? row[i] : ''; };
  const problems = [];
  const warnings = [];
  const name = text(get('name'), 200) || [text(get('firstName'), 100), text(get('lastName'), 100)].filter(Boolean).join(' ');
  if (!name) problems.push('no name');
  let email = text(get('email'), 200).toLowerCase().replace(/^mailto:/, '');
  if (email && !EMAIL_RE.test(email)) { warnings.push(`email “${email}” doesn’t look right, left out`); email = ''; }
  return {
    body: {
      name, email,
      phone: text(get('phone'), 60), company: text(get('company'), 200), city: text(get('city'), 120),
      country: text(get('country'), 120), interests: text(get('interests'), 1000), notes: text(get('notes'), 4000)
    },
    images: [], problems, warnings
  };
}

const fromRow = { artworks: artworkFromRow, clients: clientFromRow };

module.exports = {
  readSheet, guessMapping, fromRow, FIELDS, SheetError, MAX_ROWS,
  // exported for tests
  parseMoney, parseYear, parseDate, parseStatus, parseType, parseCsv
};
