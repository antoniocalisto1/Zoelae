// The collector's own collection: stats, filters, grid/list, and selection mode for sharing.
//
// The grid moves rather than redraws. Changing the sort no longer rebuilds the
// page: every card that survives the change travels from where it was to where
// it now belongs, cards that stop matching shrink away from their old spot, and
// new matches rise in behind them. That only works if the shell survives a
// rerender, so this file paints the scaffolding once and updates it in place.
import { $, $$, esc, money, ageLabel, yearAndAge } from './format.js';
import { state, TYPES, STATUSES, STATUS_LABEL, visibleArtworks } from './store.js';
import { Spring, RM, motionFor, flipList, fadeIn, animateNumber, clamp } from './motion.js';
import { firstRunHtml } from './welcome.js';

let handlers = {};
let shellPainted = false;
let switching = false;

const SHELL = `
  <section id="collectionRoot" class="coll">
    <div class="coll-head">
      <h1 id="collTitle">The <em>collection</em></h1>
      <div class="coll-actions">
        <div class="search-in">
          <label class="sr-only" for="searchInput">Search the collection</label>
          <input class="input" id="searchInput" type="search" placeholder="Search title, artist, medium, notes">
        </div>
        <button class="btn caps" id="importBtn" title="Many works at once from Excel or CSV">Import</button>
        <button class="btn caps" id="folderBtn" title="Every photograph in a folder becomes a work, ready for its details">Add a folder</button>
        <button class="btn btn-primary caps" id="addWorkBtn">Add a work</button>
      </div>
    </div>
    <p class="coll-sub" id="subline"></p>
    <div class="todo-banner" id="todoBanner" hidden></div>
    <div class="stats" id="stats"></div>
    <div class="status-tabs" id="statusTabs" role="tablist" aria-label="Show works by status"></div>
    <div class="toolbar">
      <label class="lbl" for="typeFilter">Type</label>
      <select class="select" id="typeFilter"></select>
      <label class="lbl" for="artistFilter">Artist</label>
      <select class="select" id="artistFilter"></select>
      <label class="lbl" for="sortSelect">Sort</label>
      <select class="select" id="sortSelect">
        <option value="added">Recently added</option>
        <option value="age_desc">Age — oldest first</option>
        <option value="age_asc">Age — newest first</option>
        <option value="price_desc">Price — high to low</option>
        <option value="price_asc">Price — low to high</option>
        <option value="value_desc">Valuation — high to low</option>
        <option value="artist_az">Artist — A to Z</option>
        <option value="title_az">Title — A to Z</option>
      </select>
      <button class="btn btn-sm" id="selectToggle">Select</button>
      <div class="viewtoggle" id="viewToggle">
        <span class="vt-thumb" id="vtThumb"></span>
        <button id="gridViewBtn">Grid</button>
        <button id="listViewBtn">List</button>
      </div>
    </div>
    <div class="chipbar" id="chipbar"></div>
    <div id="results"></div>
  </section>`;

export function renderCollection(hooks) {
  handlers = hooks;

  if (!$('#collectionRoot')) {
    $('#main').innerHTML = SHELL;
    shellPainted = false;
  }
  if (!shellPainted) {
    bindToolbar();
    placeViewThumb(false);
    shellPainted = true;
  }

  const list = visibleArtworks();
  $('#selectToggle').textContent = state.selecting ? 'Done' : 'Select';
  renderStats(list);
  renderTodo();
  renderStatusTabs();
  renderFilters();
  renderChips();
  renderResults(list);
  renderSelectBar();
  document.body.classList.toggle('selecting', state.selecting);
  // An empty catalogue has nothing to count or filter: just the first step.
  const empty = state.artworks.length === 0;
  $('#collectionRoot').classList.toggle('is-empty', empty);
}

/** The shell is gone whenever another view has taken over #main. */
export function invalidateCollectionShell() { shellPainted = false; }

/* ---------- works waiting for their details ----------
   A folder of photographs arrives as works with only an image. They stay in the collection, and
   this line offers to step through them until each has a title and an artist. */
function renderTodo() {
  const waiting = state.artworks.filter(w => w.needsDetails);
  const el = $('#todoBanner');
  el.hidden = !waiting.length;
  if (!waiting.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<p><b>${waiting.length} work${waiting.length === 1 ? ' is' : 's are'}</b> waiting for ${waiting.length === 1 ? 'its' : 'their'} details.</p>
    <button class="btn btn-sm btn-primary caps" id="describeBtn">Describe ${waiting.length === 1 ? 'it' : 'them'}</button>`;
  $('#describeBtn').onclick = () => handlers.describe(waiting.map(w => w.id));
}

/* ---------- stats ----------
   They answer the question you just asked: filter to one artist and the
   figures narrow to that artist, with the whole-collection count still beside
   them. The numbers spring between values rather than snapping. */
function renderStats(list) {
  const all = state.artworks;
  const filtered = list.length !== all.length;
  const spend = list.reduce((sum, w) => sum + (Number(w.purchasePrice) || 0), 0);
  const valued = list.filter(w => w.currentValuation != null);
  const valuation = valued.reduce((sum, w) => sum + Number(w.currentValuation), 0);
  const counts = {};
  list.forEach(w => { if (w.artist) counts[w.artist] = (counts[w.artist] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const of = (n) => (filtered ? `<span class="of">of ${n}</span>` : '');

  // A gallery or an artist is selling: show what's for sale and what has sold. A collector
  // is keeping: show what was spent and what it's worth.
  const selling = ['gallery', 'artist'].includes(state.user?.accountType) || all.some(w => w.status !== 'collection');
  const forSale = list.filter(w => w.status === 'for_sale');
  const sold = list.filter(w => w.status === 'sold');
  const askingTotal = forSale.reduce((sum, w) => sum + (Number(w.askingPrice) || 0), 0);
  const soldTotal = sold.reduce((sum, w) => sum + (Number(w.soldPrice) || 0), 0);
  const tiles = selling ? [
    ['For sale', 'sale', forSale.length ? askingTotal : 0, (v) => (askingTotal ? money(Math.round(v)) : '—'), `<small>· ${forSale.length} work${forSale.length === 1 ? '' : 's'}</small>`],
    ['Sold', 'sold', soldTotal, (v) => (soldTotal ? money(Math.round(v)) : '—'), `<small>· ${sold.length} work${sold.length === 1 ? '' : 's'}</small>`]
  ] : [
    [filtered ? 'Spend, shown' : 'Total spend', 'spend', spend, (v) => (spend ? money(Math.round(v)) : '—'), ''],
    [filtered ? 'Valuation, shown' : 'Current valuation', 'value', valuation, (v) => (valued.length ? money(Math.round(v)) : '—'), '']
  ];

  $('#stats').innerHTML = `
    <div class="stat"><div class="k">Works</div><div class="v"><span data-n="works">0</span>${of(all.length)}</div></div>
    ${tiles.map(([k, key, , , extra]) => `<div class="stat"><div class="k">${k}</div><div class="v"><span data-n="${key}">—</span> ${extra}</div></div>`).join('')}
    <div class="stat"><div class="k">${selling ? 'Most represented' : 'Most collected'}</div><div class="v" style="font-size:15px">${top ? esc(top[0]) : '—'}${top ? ` <small>· ${top[1]} work${top[1] === 1 ? '' : 's'}</small>` : ''}</div></div>`;

  animateNumber($('#stats [data-n="works"]'), 'works', list.length, v => String(Math.round(v)));
  tiles.forEach(([, key, value, fmt]) => animateNumber($(`#stats [data-n="${key}"]`), key, value, fmt));
}

function renderStatusTabs() {
  const counts = { collection: 0, for_sale: 0, sold: 0 };
  state.artworks.forEach(w => { counts[w.status] = (counts[w.status] || 0) + 1; });
  const tabs = [['', 'All', state.artworks.length], ...STATUSES.map(s => [s, STATUS_LABEL[s], counts[s]])];
  const el = $('#statusTabs');
  el.innerHTML = tabs.map(([key, label, n]) => `<button role="tab" data-status="${key}" aria-selected="${state.status === key}"
      class="${state.status === key ? 'on' : ''}">${key ? `<i class="dot ${key}"></i>` : ''}${esc(label)}<span>${n}</span></button>`).join('');
  el.querySelectorAll('[data-status]').forEach(b => {
    b.onclick = () => { state.status = b.dataset.status; handlers.rerender(); };
  });
}

function renderFilters() {
  const artists = [...new Set(state.artworks.map(w => w.artist).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const artistSel = $('#artistFilter');
  const artistHtml = '<option value="">All artists</option>' +
    artists.map(a => `<option value="${esc(a)}"${a === state.artist ? ' selected' : ''}>${esc(a)}</option>`).join('');
  if (artistSel.innerHTML !== artistHtml) artistSel.innerHTML = artistHtml;

  const counts = {};
  state.artworks.forEach(w => { counts[w.type] = (counts[w.type] || 0) + 1; });
  const typeSel = $('#typeFilter');
  const typeHtml = '<option value="">All types</option>' +
    TYPES.filter(t => counts[t]).map(t =>
      `<option value="${esc(t)}"${t === state.type ? ' selected' : ''}>${esc(t)} (${counts[t]})</option>`).join('');
  if (typeSel.innerHTML !== typeHtml) typeSel.innerHTML = typeHtml;

  $('#sortSelect').value = state.sort;
  if ($('#searchInput').value !== state.q) $('#searchInput').value = state.q;
}

function renderChips() {
  const chips = [];
  if (state.type) chips.push(`<span class="chip">Type: ${esc(state.type)} <button data-clear="type">×</button></span>`);
  if (state.artist) chips.push(`<span class="chip">Artist: ${esc(state.artist)} <button data-clear="artist">×</button></span>`);
  if (state.q) chips.push(`<span class="chip">Search: “${esc(state.q)}” <button data-clear="q">×</button></span>`);
  if (state.status) chips.push(`<span class="chip">${esc(STATUS_LABEL[state.status])} <button data-clear="status">×</button></span>`);

  const bar = $('#chipbar');
  bar.innerHTML = chips.join('');
  bar.style.display = chips.length ? 'flex' : 'none';
  bar.querySelectorAll('[data-clear]').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.clear;
      if (key === 'q') { state.q = ''; $('#searchInput').value = ''; } else state[key] = '';
      handlers.rerender();
    };
  });
}

const thumbUrl = (w) => (w.images[0] ? (w.images[0].thumbUrl || w.images[0].url) : '');

/* ---------- results ---------- */

function renderResults(list) {
  $('#subline').textContent = state.artworks.length === 0
    ? 'Nothing catalogued yet.'
    : `${list.length} of ${state.artworks.length} work${state.artworks.length === 1 ? '' : 's'} shown`;

  const results = $('#results');

  if (state.artworks.length === 0) { results.innerHTML = emptyCollectionHtml(); return bindResults(list); }
  if (list.length === 0) { results.innerHTML = emptyFilteredHtml(); return bindResults(list); }

  if (state.layout === 'grid') {
    let grid = results.querySelector('.grid');
    if (!grid) {
      results.textContent = '';
      grid = document.createElement('div');
      grid.className = 'grid';
      results.appendChild(grid);
    }
    flipList(grid, list, buildCard, { exitLayer: $('#fxLayer'), refresh: refreshCard });
    // Selection state can change without the list changing, so repaint it in place.
    Array.from(grid.children).forEach(el => {
      el.classList.toggle('selected', state.selected.has(el.dataset.id));
    });
  } else {
    results.innerHTML = listHtml(list);
  }
  bindResults(list);
}

/** What a card shows, as one string: when it changes, the card is repainted in place. */
const cardSig = (w) => JSON.stringify([w.title, w.artist, w.year, w.status, w.askingPrice, w.soldPrice, w.purchasePrice,
  w.needsDetails, w.images[0]?.id || '']);

/** A card that stays in the grid keeps its element (so it can move), but takes on new details. */
function refreshCard(el, w) {
  if (el.dataset.sig === cardSig(w)) return;
  const fresh = buildCard(w);
  el.className = fresh.className + (el.classList.contains('selected') ? ' selected' : '');
  el.innerHTML = fresh.innerHTML;
  el.dataset.sig = fresh.dataset.sig;
}

function buildCard(w) {
  const el = document.createElement('button');
  el.dataset.sig = cardSig(w);
  el.className = 'card' + (w.needsDetails ? ' draft' : '');
  el.dataset.id = w.id;
  el.innerHTML = `<span class="card-in">
      <span class="thumb">
        ${w.images.length ? `<img src="${esc(thumbUrl(w))}" alt="${esc(w.title)}" loading="lazy">` : '<span class="placeholder" aria-hidden="true"></span>'}
        ${w.status === 'sold' ? '<span class="sold-dot" title="Sold" aria-label="Sold"></span>' : ''}
        ${w.images.length ? '' : '<span class="noimg">No image yet</span>'}
        <span class="check">✓</span>
      </span>
      <span class="body">
        <span class="t">${esc(w.title)}</span>
        ${w.needsDetails
          ? '<span class="a needs">Waiting for details</span>'
          : `<span class="a">${esc(w.artist)}${w.year != null ? ` · ${w.year}` : ''}</span>`}
        <span class="meta">${cardPrice(w)}</span>
      </span>
    </span>`;
  const img = el.querySelector('img');
  if (img) fadeIn(img);
  return el;
}

/** What the corner of a card says about money depends on where the work stands. */
function cardPrice(w) {
  if (w.status === 'for_sale') return `<span class="price sale">For sale${w.askingPrice != null ? ` · ${money(w.askingPrice, w.currency)}` : ''}</span>`;
  if (w.status === 'sold') return `<span class="price sold">Sold${w.soldPrice != null ? ` · ${money(w.soldPrice, w.currency)}` : ''}</span>`;
  return `<span class="price">In the collection</span>`;
}

function listHtml(list) {
  const arrow = (k) => (state.sort.startsWith(k) ? `<span class="arrow">${state.sort.endsWith('asc') ? '▲' : '▼'}</span>` : '');
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th style="width:56px"></th>
      <th class="sortable" data-sort="title_az">Title</th>
      <th class="sortable" data-sort="artist_az">Artist</th>
      <th class="sortable" data-sort="age">Year ${arrow('age')}</th>
      <th class="hide-sm">Type</th>
      <th class="hide-sm">Medium</th>
      <th class="hide-sm">Status</th>
      <th class="sortable num" data-sort="price">Price ${arrow('price')}</th>
    </tr></thead><tbody>` +
    list.map(w => `<tr data-id="${w.id}" class="${state.selected.has(w.id) ? 'selected' : ''}">
      <td>${w.images.length ? `<img class="mini" src="${esc(thumbUrl(w))}" alt="" loading="lazy">` : '<span class="mini placeholder"></span>'}</td>
      <td class="tname">${esc(w.title)}</td>
      <td>${w.needsDetails ? '<span class="needs">Waiting for details</span>' : esc(w.artist)}</td>
      <td>${w.year == null
        ? '<span style="color:var(--muted-2)">Unknown</span>'
        : `${w.year} <span style="color:var(--muted-2)">· ${ageLabel(w.year)}</span>`}</td>
      <td class="hide-sm">${esc(w.type)}</td>
      <td class="hide-sm" style="color:var(--muted)">${esc(w.medium) || '—'}</td>
      <td class="hide-sm"><span class="status-pill ${w.status}"><i class="dot ${w.status}"></i>${esc(STATUS_LABEL[w.status] || '')}</span></td>
      <td class="num">${money(w.purchasePrice, w.currency)}</td>
    </tr>`).join('') + '</tbody></table></div>';
}

const emptyCollectionHtml = () => firstRunHtml('data-add');

const emptyFilteredHtml = () => `<div class="empty">
  <h3>Nothing matches</h3>
  <p>Try a different artist or type, or clear the search.</p>
  <button class="btn" data-reset>Clear filters</button>
</div>`;

/** Shift-click selects the range between the last toggled piece and this one, in displayed order. */
function toggleSelection(id, list, shiftKey) {
  if (shiftKey && state.lastToggledId) {
    const ids = list.map(w => w.id);
    const from = ids.indexOf(state.lastToggledId);
    const to = ids.indexOf(id);
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      const selecting = !state.selected.has(id);
      for (let i = lo; i <= hi; i++) {
        if (selecting) state.selected.add(ids[i]); else state.selected.delete(ids[i]);
      }
      state.lastToggledId = id;
      return;
    }
  }
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  state.lastToggledId = id;
}

function bindResults(list) {
  const activate = (id, ev, el) => {
    if (state.selecting) {
      toggleSelection(id, list, ev.shiftKey);
      handlers.rerender();
    } else {
      handlers.openDetail(id, el ? el.querySelector('img') : null);
    }
  };

  $$('#results .card').forEach(card => { card.onclick = (ev) => activate(card.dataset.id, ev, card); });
  $$('#results tbody tr').forEach(row => { row.onclick = (ev) => activate(row.dataset.id, ev, row); });

  $$('#results th.sortable').forEach(th => {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (key === 'age') state.sort = state.sort === 'age_desc' ? 'age_asc' : 'age_desc';
      else if (key === 'price') state.sort = state.sort === 'price_desc' ? 'price_asc' : 'price_desc';
      else state.sort = key;
      handlers.rerender();
    };
  });

  const add = $('#results [data-add]');
  if (add) add.onclick = () => handlers.openForm();
  const imp = $('#results [data-import]');
  if (imp) imp.onclick = () => handlers.openImport();
  const folder = $('#results [data-folder]');
  if (folder) folder.onclick = () => handlers.openFolder();
  const reset = $('#results [data-reset]');
  if (reset) reset.onclick = () => { state.q = ''; state.type = ''; state.artist = ''; handlers.rerender(); };
}

/* ---------- toolbar ---------- */

/** The view thumb rides a spring, so double-tapping redirects it mid-slide. */
let vtX = null;
function placeViewThumb(animate) {
  const thumb = $('#vtThumb');
  if (!thumb) return;
  if (!vtX) vtX = new Spring(0, x => { thumb.style.transform = `translateX(${x}px)`; }, { eps: 0.3 });
  const btn = state.layout === 'grid' ? $('#gridViewBtn') : $('#listViewBtn');
  $('#gridViewBtn').classList.toggle('active', state.layout === 'grid');
  $('#listViewBtn').classList.toggle('active', state.layout === 'list');
  thumb.style.width = btn.offsetWidth + 'px';
  if (animate) vtX.to(btn.offsetLeft, { damping: 0.85, response: 0.34 });
  else vtX.hold(btn.offsetLeft);
}

/** Grid and list are different shapes, so the switch dissolves through rather
 *  than pretending one becomes the other. */
function switchLayout(next) {
  if (state.layout === next || switching) return;
  state.layout = next;
  placeViewThumb(true);
  if (RM.matches) { handlers.rerender(); return; }
  switching = true;
  const results = $('#results');
  const out = new Spring(1, p => {
    results.style.opacity = String(p);
    results.style.transform = `scale(${0.995 + 0.005 * p})`;
  }, { eps: 0.006 });
  out.to(0, { response: 0.2, onRest: () => {
    results.textContent = '';
    handlers.rerender();
    const inS = new Spring(0, p => {
      results.style.opacity = String(p);
      results.style.transform = `scale(${1.006 - 0.006 * p})`;
    }, { eps: 0.006 });
    inS.hold(0);
    inS.to(1, { response: 0.4, onRest: () => {
      results.style.opacity = ''; results.style.transform = ''; switching = false;
    } });
  } });
}

function bindToolbar() {
  $('#typeFilter').onchange = (e) => { state.type = e.target.value; handlers.rerender(); };
  $('#importBtn').onclick = () => handlers.openImport();
  $('#folderBtn').onclick = () => handlers.openFolder();
  $('#addWorkBtn').onclick = () => handlers.openForm();
  // No debounce: the collection filters on every keystroke.
  $('#searchInput').oninput = (e) => { state.q = e.target.value; handlers.rerender(); };
  $('#artistFilter').onchange = (e) => { state.artist = e.target.value; handlers.rerender(); };
  $('#sortSelect').onchange = (e) => { state.sort = e.target.value; handlers.rerender(); };
  // Act on the press, not the release — the thumb starts moving under the finger.
  $('#gridViewBtn').addEventListener('pointerdown', e => { if (e.button === 0) switchLayout('grid'); });
  $('#listViewBtn').addEventListener('pointerdown', e => { if (e.button === 0) switchLayout('list'); });
  $('#selectToggle').onclick = () => {
    state.selecting = !state.selecting;
    if (!state.selecting) { state.selected.clear(); state.lastToggledId = null; }
    handlers.rerender();
  };
  window.addEventListener('resize', () => { if ($('#vtThumb')) placeViewThumb(false); });
}


/* ---------- selection bar ---------- */

let selectBarSpring = null;
function renderSelectBar() {
  const existing = $('#selectBar');
  if (!state.selecting) { if (existing) hideSelectBar(existing); return; }

  const count = state.selected.size;
  let bar = existing;
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'selectBar';
    bar.className = 'selectbar';
    document.body.appendChild(bar);
    // It rises from the bottom edge, and it will leave the same way.
    selectBarSpring = new Spring(90, y => {
      bar.style.transform = `translate3d(-50%,${y}px,0)`;
      bar.style.opacity = String(clamp(1 - y / 90, 0, 1));
    }, { eps: 0.3 });
    selectBarSpring.hold(90);
    selectBarSpring.to(0, { response: 0.38 });
  }
  bar.innerHTML = `
    <span class="n">${count} selected</span>
    <button class="btn btn-sm" data-all>Select all</button>
    <button class="btn btn-sm" data-clear>Clear</button>
    <button class="btn btn-sm btn-primary" data-share ${count ? '' : 'disabled'}>Create shared link</button>`;

  bar.querySelector('[data-all]').onclick = () => {
    visibleArtworks().forEach(w => state.selected.add(w.id));
    handlers.rerender();
  };
  bar.querySelector('[data-clear]').onclick = () => {
    state.selected.clear(); state.lastToggledId = null; handlers.rerender();
  };
  bar.querySelector('[data-share]').onclick = () => {
    if (state.selected.size) handlers.openShareModal([...state.selected]);
  };
}

function hideSelectBar(bar) {
  if (!selectBarSpring || RM.matches) { bar.remove(); selectBarSpring = null; return; }
  selectBarSpring.to(90, { response: 0.32, onRest: () => { bar.remove(); selectBarSpring = null; } });
}

export function teardownSelectBar() {
  const bar = $('#selectBar');
  if (bar) { bar.remove(); selectBarSpring = null; }
  document.body.classList.remove('selecting');
}
