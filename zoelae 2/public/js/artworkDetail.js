// A single piece, everything the collector recorded about it.
//
// The detail is a layer that rises over the collection rather than a page that
// replaces it. Opening grows the thumbnail into the detail image on four
// independent springs; the collection doesn't disappear, it steps back and dims
// underneath, which is what gives the swipe-back gesture something real to
// reveal. At the end of the flight the flying copy cross-fades into the placed
// image: a card crops its artwork and this page shows the whole thing, and the
// cross-fade is what turns that change of framing into a settle rather than a jump.
import { $, esc, money, ageLabel, byline, dateLabel, fileSize, DOC_KIND_LABEL } from './format.js';
import { state, visibleArtworks, STATUS_LABEL } from './store.js';
import { Spring, RM, motionFor, fadeIn, dragAxis, project, clamp } from './motion.js';

let current = null;
let imageIndex = 0;
let hooks = {};
let order = [];
let open = false;
let sheetPush = 0;

/* ---------- the stage: detail layer over the app ---------- */

const stage = { present: null, dx: null };

function paintStage() {
  const d = $('#detailLayer'), app = $('#app');
  if (!d || !app) return;
  // A modal can open before any artwork has (Add artwork, the share flow), so the stage's
  // springs may not exist yet; treat that as "no detail layer".
  const p = stage.present ? clamp(stage.present.x, 0, 1) : 0;
  const dxNow = stage.dx ? stage.dx.x : 0;
  const slid = clamp(dxNow / (window.innerWidth || 1), 0, 1);
  const depth = clamp(p * (1 - slid), 0, 1);

  d.style.opacity = String(p);
  d.style.transform = `translate3d(${dxNow}px,0,0) scale(${1 - 0.03 * (open ? sheetPush : 0)})`;
  // A leading edge that catches light, so the layer reads as lifted off the
  // collection rather than painted onto it.
  d.style.boxShadow = dxNow > 0.5
    ? `-10px 0 ${(24 + 16 * slid) | 0}px rgba(27,24,20,${(0.1 + 0.12 * (1 - slid)).toFixed(3)})`
    : '';

  // Whichever layer is on top is the one a modal pushes back.
  const push = Math.max(depth, open ? 0 : sheetPush);
  app.style.transform = push > 0.001 ? `scale(${1 - 0.03 * push})` : '';
  app.style.opacity = depth > 0.001 ? String(1 - 0.5 * depth) : '';
}

function ensureStage() {
  if (stage.present) return;
  stage.present = new Spring(0, paintStage, { eps: 0.004 });
  stage.dx = new Spring(0, paintStage, { eps: 0.4 });

  $('#backBtn').onclick = () => closeDetail();
  $('#prevBtn').onclick = () => step(-1);
  $('#nextBtn').onclick = () => step(1);
  $('#detailLayer').addEventListener('scroll', function () {
    $('#detailBar').classList.toggle('scrolled', this.scrollTop > 4);
  }, { passive: true });

  // Swipe back from the left edge: tracked 1:1, rubber-banded at the closed
  // position, and on release the resting point is projected from the flick.
  // A swipe slides the layer away rather than flying the image home — the
  // gesture is the transition, and following it with a second, different one
  // would read as two separate events.
  dragAxis($('#detailEdge'), stage.dx, 'x', {
    lo: 0, hi: Infinity, dim: () => window.innerWidth,
    guard: () => open && !document.querySelector('#modalRoot .modal'),
    release: (x, v, moved) => {
      if (!moved) { stage.dx.to(0, { response: 0.3 }); return; }
      // A third of the way, but never more than a comfortable wrist's worth —
      // a percentage alone makes this a marathon on a wide window.
      if (x + project(v) > Math.min(window.innerWidth * 0.35, 280)) {
        open = false; current = null; state.detailId = null;
        endFlight();
        stage.dx.to(window.innerWidth, { velocity: v, response: 0.3, onRest: finishClose });
      } else {
        stage.dx.to(0, { velocity: v, damping: Math.abs(v) > 250 ? 0.85 : 1, response: 0.32 });
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (document.querySelector('#modalRoot .modal')) return;
    if (e.target.closest('input,select,textarea')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
  });
}

/** Modals step the topmost layer back; the artwork form calls this. */
export function setModalPush(p) { sheetPush = RM.matches ? 0 : p; paintStage(); }

export const isDetailOpen = () => open;

/* Width and height from the server let the browser lay the image out before it has loaded,
   which the flight below needs: it measures where the image will land. */
const dims = (img) => (img && img.width && img.height ? ` width="${img.width}" height="${img.height}"` : '');

/* ---------- the flying image ---------- */

let flight = null;

function makeFlight(src, base) {
  const el = document.createElement('img');
  el.src = src; el.className = 'flyer'; el.alt = '';
  el.style.width = base.width + 'px';
  el.style.height = base.height + 'px';
  el.style.objectFit = 'cover';
  document.body.appendChild(el);
  const f = { el, base };
  const apply = () => {
    el.style.transform = `translate3d(${f.x.x}px,${f.y.x}px,0) scale(${f.sx.x},${f.sy.x})`;
    el.style.opacity = String(f.o.x);
  };
  f.x = new Spring(base.left, apply, { eps: 0.3 });
  f.y = new Spring(base.top, apply, { eps: 0.3 });
  f.sx = new Spring(1, apply, { eps: 0.0015 });
  f.sy = new Spring(1, apply, { eps: 0.0015 });
  f.o = new Spring(1, apply, { eps: 0.01 });
  return f;
}
function setFlight(f, r) {
  f.x.hold(r.left); f.y.hold(r.top);
  f.sx.hold(r.width / f.base.width); f.sy.hold(r.height / f.base.height);
}
function flyTo(f, r, done) {
  let left = 4;
  const rest = () => { if (--left === 0 && done) done(); };
  const o = { response: 0.44, onRest: rest };
  f.x.to(r.left, o); f.y.to(r.top, o);
  f.sx.to(r.width / f.base.width, o); f.sy.to(r.height / f.base.height, o);
}
function endFlight() {
  if (!flight) return;
  // Whatever the flyer stood in for becomes visible again, even if the flight was cut short.
  if (flight.hidden) flight.hidden.style.visibility = '';
  ['x', 'y', 'sx', 'sy', 'o'].forEach(k => flight[k].stop());
  flight.el.remove();
  flight = null;
}

/* ---------- open / close / step ---------- */

export function openDetail(artworkId, srcImg, h) {
  const w = state.artworks.find(a => a.id === artworkId);
  if (!w) return;
  hooks = h || hooks;
  ensureStage();

  const wasOpen = open;
  const first = srcImg && !wasOpen ? srcImg.getBoundingClientRect() : null;

  current = w;
  state.detailId = w.id;
  imageIndex = 0;
  order = visibleArtworks().map(a => a.id);
  if (!order.includes(w.id)) order = state.artworks.map(a => a.id);

  const layer = $('#detailLayer');
  layer.classList.remove('hidden');
  layer.scrollTop = 0;
  $('#detailBar').classList.remove('scrolled');
  open = true;
  paint(0);

  if (!wasOpen) {
    stage.dx.hold(0);
    stage.present.hold(RM.matches ? 1 : 0);
    stage.present.to(1, { response: 0.36 });
  }

  endFlight();
  const img = $('#detailImage');
  const landing = img ? img.getBoundingClientRect() : null;
  if (first && img && !RM.matches && landing.width > 1 && landing.height > 1) {
    const last = landing;
    // Fly the thumbnail the browser already has; the larger copy takes over when it lands.
    flight = makeFlight(srcImg.currentSrc || srcImg.src, last);
    setFlight(flight, first);
    flight.hidden = img;
    img.style.visibility = 'hidden';
    flyTo(flight, last, () => {
      img.style.visibility = '';
      const f = flight;
      if (!f) return;
      f.o.to(0, { response: 0.2, onRest: () => { if (flight === f) endFlight(); } });
    });
  }
}

function finishClose() {
  const layer = $('#detailLayer');
  layer.classList.add('hidden');
  $('#detailSlab').textContent = '';
  stage.present.hold(0);
  stage.dx.hold(0);
  paintStage();
  if (hooks.afterClose) hooks.afterClose();
}

export function closeDetail(instant) {
  if (!open) return;
  const id = state.detailId;
  const img = $('#detailImage');
  const from = img ? img.getBoundingClientRect() : null;
  const src = img ? img.src : null;
  open = false;
  current = null;
  state.detailId = null;

  if (instant || RM.matches) { stage.present.hold(0); endFlight(); finishClose(); return; }

  stage.present.to(0, { response: 0.36, onRest: finishClose });

  const target = document.querySelector(`#results [data-id="${id}"] img`);
  endFlight();
  if (target && from) {
    flight = makeFlight(src, from);
    setFlight(flight, from);
    flight.hidden = target;
    target.style.visibility = 'hidden';
    flyTo(flight, target.getBoundingClientRect(), () => {
      target.style.visibility = '';
      endFlight();
    });
  }
}

/** Forward exits left and enters from the right; back does the reverse. */
function step(delta) {
  const i = order.indexOf(state.detailId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return;
  const next = state.artworks.find(a => a.id === order[j]);
  if (!next) return;
  endFlight();
  current = next;
  state.detailId = next.id;
  imageIndex = 0;
  $('#detailLayer').scrollTop = 0;
  if (RM.matches) { paint(0); return; }

  const slab = $('#detailSlab');
  const m = motionFor(slab);
  m.x.to(-delta * 24, { response: 0.2 });
  m.o.to(0, { response: 0.18, onRest: () => {
    paint(delta);
    m.x.hold(delta * 10); m.o.hold(1);
    m.x.to(0, { response: 0.4, onRest: m.settle });
  } });
}

/** Called after a save so the open layer shows the new data. */
export function refreshDetail() {
  if (!open) return;
  const w = state.artworks.find(a => a.id === state.detailId);
  if (!w) { closeDetail(true); return; }
  current = w;
  paint(0);
}

function syncStepper() {
  const i = order.indexOf(state.detailId);
  $('#prevBtn').disabled = i <= 0;
  $('#nextBtn').disabled = i < 0 || i >= order.length - 1;
  $('#ofN').textContent = i >= 0 ? `${i + 1} / ${order.length}` : '';
}

/* ---------- painting the slab ---------- */

function paint(dir) {
  const w = current;
  if (!w) return;
  const rows = [
    ['Artist', w.artist ? esc(w.artist) : '—'],
    ['Type', esc(w.type)],
    ['Year created', w.year == null
      ? '<span style="color:var(--muted-2);font-weight:400">Not recorded</span>'
      : `${w.year} <span style="color:var(--muted-2);font-weight:400">· ${ageLabel(w.year)}</span>`],
    ['Medium', esc(w.medium) || '—'],
    ['Dimensions', esc(w.dimensions) || '—']
  ];

  const valueRows = [
    ['Price paid', money(w.purchasePrice, w.currency)],
    ['Current valuation', money(w.currentValuation, w.currency)],
    ['Insured value', money(w.insuredValue, w.currency)],
    ['Valued on', w.valuationDate ? dateLabel(w.valuationDate) : '—']
  ];

  const provenanceRows = [
    ['Acquired', w.acquiredAt ? dateLabel(w.acquiredAt) : '—'],
    ['Acquired from', esc(w.acquiredFrom) || '—'],
    ['Prior owners', esc(w.priorOwners) || '—']
  ];

  $('#barTitle').textContent = w.title;
  $('#detailSlab').innerHTML = `
    <div class="detail">
      <div class="detail-img stagger">
        ${w.images.length
          ? `<img id="detailImage" src="${esc(w.images[imageIndex]?.url || '')}" alt="${esc(w.title)}"${dims(w.images[imageIndex])}>`
          : `<div class="noimage-slab"><p>No image yet</p><button class="btn btn-primary pill" id="addImageBtn">Add a photograph</button></div>`}
        ${w.images.length > 1 ? `<div class="thumbrow">${w.images.map((img, i) =>
          `<button data-img="${i}" class="${i === imageIndex ? 'active' : ''}"><img src="${esc(img.thumbUrl || img.url)}" alt=""></button>`).join('')}</div>` : ''}
      </div>
      <div class="detail-side">
        <h2 class="stagger">${esc(w.title)}</h2>
        ${w.needsDetails
          ? '<p class="byline stagger"><span class="needs">Waiting for details</span> — use Edit to add the artist and the rest.</p>'
          : `<p class="byline stagger">${esc(byline(w.artist, w.year))}</p>`}

        <div class="dl stagger">${rows.map(row).join('')}</div>

        <div class="dl stagger">
          <div class="sect">Status</div>
          ${statusRows(w).map(row).join('')}
        </div>

        <div class="dl stagger">
          <div class="sect">Value</div>
          ${valueRows.map(row).join('')}
        </div>

        <div class="dl stagger">
          <div class="sect">Provenance &amp; ownership</div>
          ${provenanceRows.map(row).join('')}
          ${w.provenance ? `<div class="r" style="display:block"><span>History</span><div style="margin-top:6px;white-space:pre-wrap">${esc(w.provenance)}</div></div>` : ''}
          ${w.exhibitionHistory ? `<div class="r" style="display:block"><span>Exhibitions</span><div style="margin-top:6px;white-space:pre-wrap">${esc(w.exhibitionHistory)}</div></div>` : ''}
        </div>

        <div class="dl stagger">
          <div class="sect">Storage</div>
          ${row(['Location', esc(w.storageLocation) || '—'])}
        </div>

        ${w.documents.length ? `<div class="notes stagger">
          <div class="k">Certificates &amp; documents</div>
          <div class="doclist">${w.documents.map(documentRow).join('')}</div>
        </div>` : ''}

        ${w.notes ? `<div class="notes stagger"><div class="k">Notes</div><p>${esc(w.notes)}</p></div>` : ''}

        <div class="detail-actions stagger">
          <button class="btn" id="editBtn">Edit details</button>
          <button class="btn" id="shareBtn">Share this piece</button>
          ${hooks.sells?.() ? '<button class="btn" id="sendClientBtn">Send to a client</button>' : ''}
          <button class="btn btn-danger" id="delBtn">Remove</button>
        </div>
      </div>
    </div>`;

  if ($('#detailImage')) fadeIn($('#detailImage'));
  if ($('#addImageBtn')) $('#addImageBtn').onclick = () => hooks.openForm(current);
  $('#editBtn').onclick = () => hooks.openForm(current);
  $('#shareBtn').onclick = () => hooks.openShareModal([current.id]);
  if ($('#sendClientBtn')) $('#sendClientBtn').onclick = () => hooks.sendToClient(current);
  $('#delBtn').onclick = () => hooks.remove(current);
  $('#detailSlab').querySelectorAll('[data-img]').forEach(btn => {
    btn.onclick = () => { imageIndex = Number(btn.dataset.img); paint(0); };
  });
  syncStepper();
  staggerIn($('#detailSlab'), dir);
}

function statusRows(w) {
  const out = [['Status', `<span class="status-pill ${w.status}"><i class="dot ${w.status}"></i>${esc(STATUS_LABEL[w.status] || '')}</span>`]];
  if (w.inventoryNumber) out.push(['Inventory no.', esc(w.inventoryNumber)]);
  if (w.status === 'for_sale') out.push(['Asking price', money(w.askingPrice, w.currency)]);
  if (w.status === 'sold') {
    out.push(['Sold for', money(w.soldPrice, w.currency)]);
    out.push(['Sold on', w.soldAt ? dateLabel(w.soldAt) : '—']);
    out.push(['Buyer', w.soldTo ? esc(w.soldTo.name) : '—']);
  }
  return out;
}

/** The parts of the page arrive one after another, in reading order. */
function staggerIn(root, dir) {
  if (RM.matches) return;
  Array.from(root.querySelectorAll('.stagger')).forEach((el, i) => {
    const m = motionFor(el);
    m.o.hold(0); m.y.hold(dir === 0 ? 12 : 0); m.x.hold(dir * 26); m.s.hold(1);
    setTimeout(() => {
      m.o.to(1, { response: 0.36, onRest: m.settle });
      m.y.to(0, { response: 0.46, onRest: m.settle });
      m.x.to(0, { response: 0.46, onRest: m.settle });
    }, i * 26);
  });
}

const row = ([label, value]) => `<div class="r"><span>${label}</span><b>${value}</b></div>`;

const documentRow = (doc) => `<a class="doc" href="${esc(doc.url)}" target="_blank" rel="noopener">
  <span class="ico">${doc.mimeType === 'application/pdf' ? 'PDF' : 'IMG'}</span>
  <span class="grow" style="flex:1;min-width:0">
    <span class="dt" style="display:block">${esc(doc.label)}</span>
    <span class="dk">${esc(DOC_KIND_LABEL[doc.kind] || 'Document')} · ${fileSize(doc.sizeBytes)}</span>
  </span>
</a>`;
