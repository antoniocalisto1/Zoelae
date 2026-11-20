// Viewer app for /s/:slug — passcode gate, then gallery, then a piece.
// The client never decides what may be shown: it renders exactly the fields the server sent.
import { $, esc, money, byline, yearLabel, dateLabel, fileSize, DOC_KIND_LABEL } from './format.js';
import { api, ApiError } from './api.js';
import { toast } from './ui.js';
import { SITE, wordmark, setFavicon } from './brand.js';

setFavicon();

/* The gate sits on the warm band; the gallery on the white wall. */
function backdrop(on) { document.body.classList.toggle('at-gate', on); }
const markLine = () => `<a class="vmark" href="/" target="_blank" rel="noopener"><span>Shared privately with</span> ${wordmark({ small: true })}</a>`;

const slug = decodeURIComponent(location.pathname.split('/s/')[1] || '').replace(/\/$/, '');
const root = $('#root');

let collection = null;   // { title, introMessage, ownerName, permissions, items }
let imageIndex = 0;

/* ---------- gate ---------- */

async function start() {
  try {
    const meta = await api.get(`/api/s/${slug}/meta`);
    // A session may already exist from an earlier visit within the two-hour window.
    try {
      await loadCollection();
      return renderGallery();
    } catch (err) {
      if (err.status === 410 || err.status === 404) return renderUnavailable();
      renderGate(meta);
    }
  } catch (err) {
    renderUnavailable();
  }
}

function renderGate(meta) {
  backdrop(true);
  root.innerHTML = `
    <div class="gate"><div class="gate-card pv-slip">
      <p class="pv-kicker">A private view</p>
      <h1>${esc(meta.title)}</h1>
      <p class="owner">Shared with you by ${esc(meta.ownerName)}</p>
      <form id="gateForm" autocomplete="off">
        <label class="sr-only" for="gatePass">Passcode</label>
        <input class="input mono" id="gatePass" type="password" placeholder="Passcode" autocomplete="off" autofocus>
        <button class="btn btn-primary pill" type="submit" id="gateSubmit">View the collection</button>
        <p class="err hidden" id="gateErr" role="alert"></p>
      </form>
      <p class="foot">The passcode comes from ${esc(meta.ownerName)}, not from ${esc(SITE)}, so we can't send it to you.</p>
    </div></div>
    <div class="gate-mark">${markLine()}</div>`;

  $('#gateForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const err = $('#gateErr');
    const button = $('#gateSubmit');
    err.classList.add('hidden');
    button.disabled = true;
    try {
      await api.post(`/api/s/${slug}/unlock`, { passcode: $('#gatePass').value });
      await loadCollection();
      renderGallery();
    } catch (e) {
      if (e.status === 410 || e.status === 404) return renderUnavailable();
      err.textContent = e instanceof ApiError ? e.message : 'That passcode isn’t right.';
      err.classList.remove('hidden');
      $('#gatePass').value = '';
      $('#gatePass').focus();
    } finally {
      button.disabled = false;
    }
  };
}

function renderUnavailable() {
  backdrop(true);
  root.innerHTML = `<div class="unavailable"><div class="pv-slip">
    <p class="pv-kicker">Private view</p>
    <h1>This view has closed</h1>
    <p>The link has expired, reached its limit or been switched off by the person who shared it. Ask them for a new one.</p>
  </div></div>
  <div class="gate-mark">${markLine()}</div>`;
}

async function loadCollection() {
  collection = await api.get(`/api/s/${slug}/collection`);
  return collection;
}

/* ---------- gallery ---------- */

function renderGallery() {
  const { title, introMessage, ownerName, items, permissions } = collection;
  document.title = `${title} · ${SITE}`;
  backdrop(false);

  root.innerHTML = `
    <header class="gallery-head">
      <div class="pv-kicker">A private view · shared by ${esc(ownerName)}</div>
      <h1>${esc(title)}</h1>
      ${introMessage ? `<p class="intro">${esc(introMessage)}</p>` : ''}
      <div class="count">${items.length} piece${items.length === 1 ? '' : 's'}</div>
    </header>
    <div class="gallery ${permissions.downloads ? '' : 'noselect'}" id="gallery">
      ${items.map(piece).join('')}
    </div>
    <footer class="viewer-foot">Shown with the owner's permission. Please don't pass these images on.${markLine()}</footer>`;

  root.querySelectorAll('[data-item]').forEach(el => {
    el.onclick = () => openPiece(el.dataset.item);
  });
  guardImages();
  window.scrollTo(0, 0);
}

function piece(item) {
  // `prices` is only present when the owner permitted it — there is no field to hide otherwise.
  const price = item.prices
    ? [item.prices.currentValuation ?? item.prices.purchasePrice].filter(v => v != null)
      .map(v => money(v, item.prices.currency))[0]
    : null;

  return `<button class="piece" data-item="${esc(item.id)}">
    <div class="frame">${item.availability === 'sold' ? '<span class="sold-dot" title="Sold" aria-label="Sold"></span>' : ''}${item.images.length ? `<img src="${esc(item.images[0].thumbUrl || item.images[0].url)}" alt="${esc(item.title)}" loading="lazy">` : '<div class="noimage-slab"><p>No image</p></div>'}</div>
    <div class="cap">
      <div class="t">${esc(item.title)}</div>
      <div class="a">${esc(byline(item.artist, item.year))}</div>
      ${availabilityLine(item) || (price ? `<div class="p">${esc(price)}</div>` : '')}
    </div>
  </button>`;
}

/** For sale and sold say so, the way a gallery wall label would. */
function availabilityLine(item) {
  if (item.availability === 'sold') return '<div class="p avail sold"><i class="dot sold"></i>Sold</div>';
  if (item.availability === 'for_sale') {
    return `<div class="p avail sale"><i class="dot for_sale"></i>Available${item.askingPrice != null ? ` · ${esc(money(item.askingPrice, item.prices?.currency))}` : ''}</div>`;
  }
  return '';
}

/* ---------- one piece ---------- */

async function openPiece(itemId) {
  let data;
  try {
    data = await api.get(`/api/s/${slug}/items/${itemId}`);
  } catch (err) {
    if (err.status === 410 || err.status === 404) return renderUnavailable();
    if (err.status === 401) return start();
    return toast('Could not open that piece.');
  }
  imageIndex = 0;
  paintPiece(data.item, data.permissions);
}

function paintPiece(item, permissions) {
  const image = item.images[imageIndex] || item.images[0];

  const facts = [
    ['Artist', esc(item.artist)],
    ['Year', item.year == null ? '<span style="font-weight:400;color:var(--muted-2)">Not recorded</span>' : item.year],
    ['Type', esc(item.type)],
    ['Medium', esc(item.medium) || '—'],
    ['Dimensions', esc(item.dimensions) || '—']
  ];

  root.innerHTML = `
    <div class="vdetail ${permissions.downloads ? '' : 'noselect'}">
      <button class="back" id="vBack">← Back to the collection</button>
      <div class="vgrid">
        <div>
          <div class="vstage">
            ${item.images.length ? '' : '<div class="noimage-slab"><p>No image</p></div>'}
            <img ${item.images.length ? '' : 'hidden '}id="vImage" src="${esc(image?.url || '')}" alt="${esc(item.title)}"${image?.width ? ` width="${image.width}" height="${image.height}"` : ''}>
          </div>
          ${item.images.length > 1 ? carousel(item) : ''}
        </div>
        <div class="vmeta">
          <h2>${esc(item.title)}</h2>
          <p class="byline">${esc(byline(item.artist, item.year))}</p>
          ${availabilityLine(item)}

          <div class="vsect">
            <h3>The work</h3>
            ${facts.map(row).join('')}
          </div>

          ${item.prices ? `<div class="vsect">
            <h3>Value</h3>
            ${row(['Purchase price', money(item.prices.purchasePrice, item.prices.currency)])}
            ${row(['Current valuation', money(item.prices.currentValuation, item.prices.currency)])}
            ${row(['Insured value', money(item.prices.insuredValue, item.prices.currency)])}
            ${item.prices.valuationDate ? row(['Valued on', dateLabel(item.prices.valuationDate)]) : ''}
          </div>` : ''}

          ${item.provenance ? `<div class="vsect">
            <h3>Provenance</h3>
            ${item.provenance.acquiredAt ? row(['Acquired', dateLabel(item.provenance.acquiredAt)]) : ''}
            ${item.provenance.acquiredFrom ? row(['Acquired from', esc(item.provenance.acquiredFrom)]) : ''}
            ${item.provenance.priorOwners ? row(['Prior owners', esc(item.provenance.priorOwners)]) : ''}
            ${item.provenance.history ? `<p class="vtext" style="margin-top:12px">${esc(item.provenance.history)}</p>` : ''}
            ${item.provenance.exhibitionHistory ? `<p class="vtext"><b>Exhibited:</b> ${esc(item.provenance.exhibitionHistory)}</p>` : ''}
          </div>` : ''}

          ${item.location ? `<div class="vsect">
            <h3>Location</h3>
            ${row(['Currently', esc(item.location.storageLocation) || '—'])}
          </div>` : ''}

          ${item.documents?.length ? `<div class="vsect">
            <h3>Certificates & documents</h3>
            <div class="doclist">${item.documents.map(documentRow).join('')}</div>
          </div>` : ''}

          ${permissions.downloads ? `<a class="btn pill" href="${esc(image?.url || '')}?download=1" download>Download image</a>` : ''}
        </div>
      </div>
    </div>`;

  $('#vBack').onclick = () => renderGallery();
  root.querySelectorAll('[data-go]').forEach(btn => {
    btn.onclick = () => {
      const count = item.images.length;
      imageIndex = (imageIndex + Number(btn.dataset.go) + count) % count;
      paintPiece(item, permissions);
    };
  });
  root.querySelectorAll('[data-dot]').forEach(btn => {
    btn.onclick = () => { imageIndex = Number(btn.dataset.dot); paintPiece(item, permissions); };
  });
  guardImages();
  window.scrollTo(0, 0);
}

const row = ([label, value]) => `<div class="vrow"><span>${label}</span><b>${value}</b></div>`;

const carousel = (item) => `<div class="carousel">
  <button class="nav" data-go="-1" aria-label="Previous image">←</button>
  <div class="dots">${item.images.map((_, i) =>
    `<button class="dot ${i === imageIndex ? 'active' : ''}" data-dot="${i}" aria-label="Image ${i + 1}"></button>`).join('')}</div>
  <button class="nav" data-go="1" aria-label="Next image">→</button>
</div>`;

const documentRow = (doc) => `<a class="doc" href="${esc(doc.url)}" target="_blank" rel="noopener">
  <span class="ico">${doc.mimeType === 'application/pdf' ? 'PDF' : 'IMG'}</span>
  <span style="flex:1;min-width:0">
    <span class="dt" style="display:block">${esc(doc.label)}</span>
    <span class="dk">${esc(DOC_KIND_LABEL[doc.kind] || 'Document')} · ${fileSize(doc.sizeBytes)}</span>
  </span>
</a>`;

/**
 * When downloads are off, block the obvious save gestures. This is a courtesy deterrent only —
 * the real protection is that image bytes are served from a session-checked route with no static
 * URL, so nothing here is what actually keeps the files private.
 */
function guardImages() {
  if (collection?.permissions?.downloads) return;
  root.querySelectorAll('img').forEach(img => {
    img.addEventListener('contextmenu', (e) => e.preventDefault());
    img.addEventListener('dragstart', (e) => e.preventDefault());
  });
}

start();
