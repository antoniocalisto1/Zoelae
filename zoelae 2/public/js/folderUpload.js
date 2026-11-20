// A folder of photographs, then the details one work at a time.
//
// Step one sends every image in a folder (chosen, or dragged in) to the server, one request per
// image, so a big folder never becomes one huge upload and one unreadable file doesn't stop the
// rest. Each image becomes a work that is waiting for its details.
//
// Step two, the describer, goes through those works in order: the photograph on the left, the
// fields on the right, "Save and next" at the bottom. Anything skipped stays in the collection,
// marked as waiting, until someone comes back to it.
import { $, esc, thisYear, fileSize } from './format.js';
import { api, ApiError } from './api.js';
import { state, TYPES, STATUSES, STATUS_LABEL } from './store.js';
import { openModal, closeModal, toast, confirmDialog } from './ui.js';

const MAX_FILES = 300;
const MAX_BYTES = 25 * 1024 * 1024;
const PARALLEL = 3;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|svg)$/i;
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']);
const HEIC = /\.(heic|heif)$/i;

const isImage = (f) => IMAGE_MIME.has(f.type) || (!f.type && IMAGE_EXT.test(f.name));
const pathOf = (f) => f.relPath || f.webkitRelativePath || f.name;
const byPath = (a, b) => pathOf(a).localeCompare(pathOf(b), undefined, { numeric: true, sensitivity: 'base' });

/* ============================== step one: the folder ============================== */

export function openFolderUpload({ onFinished, onDescribe } = {}) {
  let picked = [];          // File[] that will be sent
  let skipped = [];         // { name, why }
  let folderName = '';
  const previews = [];      // object URLs to release

  const modal = openModal(`
    <div class="modal-head"><h3>Add a folder of photographs</h3><button class="x" data-close aria-label="Close">×</button></div>
    <div class="modal-body folder-body" id="fuBody"></div>
    <div class="modal-foot" id="fuFoot"></div>`, { size: 'lg folder-modal' });
  const body = modal.querySelector('#fuBody');
  const foot = modal.querySelector('#fuFoot');

  const release = () => { previews.forEach(u => URL.revokeObjectURL(u)); previews.length = 0; };

  /* --- choose --- */
  function paintPick() {
    release();
    body.innerHTML = `
      <p class="imp-lede">Every photograph in the folder becomes a work. Then you go through them one by one and add the title, artist and anything else you know.</p>
      <div class="drop fu-drop" id="fuDrop" tabindex="0" role="button" aria-label="Drop a folder or photographs here, or choose a folder">
        <span class="fu-big">Drop a folder here</span>
        <span class="fu-or">or</span>
        <span class="fu-buttons">
          <button type="button" class="btn btn-primary caps" id="fuFolderBtn">Choose a folder</button>
          <button type="button" class="btn caps" id="fuFilesBtn">Choose photographs</button>
        </span>
      </div>
      <input type="file" id="fuFolderInput" webkitdirectory directory multiple class="hidden">
      <input type="file" id="fuFilesInput" accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml" multiple class="hidden">
      <p class="fu-hint">JPEG, PNG, WebP, GIF or SVG, up to 25 MB each and ${MAX_FILES} at a time. Photographs inside folders within the folder are included. Location data is removed from every image.</p>`;
    foot.innerHTML = `<button class="btn" type="button" data-close>Cancel</button>`;
    foot.querySelector('[data-close]').onclick = () => closeModal();

    const folderInput = body.querySelector('#fuFolderInput');
    const filesInput = body.querySelector('#fuFilesInput');
    body.querySelector('#fuFolderBtn').onclick = (e) => { e.stopPropagation(); folderInput.click(); };
    body.querySelector('#fuFilesBtn').onclick = (e) => { e.stopPropagation(); filesInput.click(); };
    folderInput.onchange = () => take([...folderInput.files]);
    filesInput.onchange = () => take([...filesInput.files]);

    const drop = body.querySelector('#fuDrop');
    drop.onclick = () => folderInput.click();
    drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); folderInput.click(); } };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      body.querySelector('.fu-big').textContent = 'Reading the folder…';
      take(await filesFromDrop(e.dataTransfer));
    };
  }

  /* --- sort out what arrived --- */
  function take(files) {
    if (!files.length) return paintPick();
    const first = pathOf(files[0]);
    folderName = first.includes('/') ? first.split('/')[0] : '';
    picked = []; skipped = [];
    for (const f of files.sort(byPath)) {
      const name = pathOf(f);
      if (f.name.startsWith('.')) continue;                           // .DS_Store and friends
      if (HEIC.test(f.name)) { skipped.push({ name, why: 'HEIC photos from an iPhone aren’t supported yet. Export them as JPEG first.' }); continue; }
      if (!isImage(f)) continue;                                      // documents, videos: silently left out
      if (f.size > MAX_BYTES) { skipped.push({ name, why: `${fileSize(f.size)} — over the 25 MB limit.` }); continue; }
      if (picked.length >= MAX_FILES) { skipped.push({ name, why: `Only ${MAX_FILES} at a time. Add the rest afterwards.` }); continue; }
      picked.push(f);
    }
    paintReview();
  }

  function paintReview() {
    release();
    const n = picked.length;
    const shown = picked.slice(0, 48);
    body.innerHTML = `
      ${n ? `<div class="imp-summary"><span class="imp-big">${n}</span><span>photograph${n === 1 ? '' : 's'}${folderName ? ` from <b>${esc(folderName)}</b>` : ''}, each becoming a work.</span></div>
      <div class="fu-grid">${shown.map((f, i) => {
        const url = URL.createObjectURL(f); previews.push(url);
        return `<figure><img src="${url}" alt="" loading="lazy"><figcaption title="${esc(pathOf(f))}">${esc(f.name)}</figcaption></figure>`;
      }).join('')}${n > shown.length ? `<div class="fu-more">and ${n - shown.length} more</div>` : ''}</div>`
      : '<div class="imp-missing">There are no photographs in that folder that can be added. JPEG, PNG, WebP, GIF and SVG images work.</div>'}
      ${skipped.length ? `<details class="imp-list bad"><summary>${skipped.length} left out</summary><ul>${skipped.map(s => `<li><b>${esc(s.name)}</b>${esc(s.why)}</li>`).join('')}</ul></details>` : ''}`;
    foot.innerHTML = `
      <button class="btn" type="button" id="fuAgain">Choose again</button>
      <span class="spacer"></span>
      ${n ? `<button class="btn btn-primary caps" type="button" id="fuGo">Add ${n} work${n === 1 ? '' : 's'}</button>` : ''}`;
    foot.querySelector('#fuAgain').onclick = paintPick;
    if (n) foot.querySelector('#fuGo').onclick = upload;
  }

  /* --- send, a few at a time --- */
  async function upload() {
    release();
    const total = picked.length;
    const created = new Array(total).fill(null);
    const failed = [];
    let done = 0;
    body.innerHTML = `
      <div class="imp-progress">
        <div class="bar"><span id="fuBar"></span></div>
        <p id="fuCount">Adding 0 of ${total}…</p>
        <p class="fu-hint">Keep this window open until it finishes. Each photograph is resized and cleaned of location data as it arrives.</p>
      </div>`;
    foot.innerHTML = '';
    const paint = () => {
      const bar = body.querySelector('#fuBar');
      if (bar) bar.style.width = `${Math.round((done / total) * 100)}%`;
      const count = body.querySelector('#fuCount');
      if (count) count.textContent = `Adding ${done} of ${total}…`;
    };

    let next = 0;
    async function worker() {
      while (next < total) {
        const i = next++;
        const f = picked[i];
        const form = new FormData();
        form.append('image', f, f.name);
        form.append('name', f.name);
        try {
          const res = await api.postForm('/api/artworks/drafts', form);
          created[i] = res.artwork.id;
        } catch (ex) {
          failed.push({ name: pathOf(f), why: ex instanceof ApiError ? ex.message : 'The upload was interrupted.' });
          if (ex instanceof ApiError && ex.body?.error === 'too_many_drafts') next = total;   // stop: every next one would fail too
        }
        done++;
        paint();
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, total) }, worker));

    const ids = created.filter(Boolean);
    if (onFinished) await onFinished();
    paintDone(ids, failed);
  }

  function paintDone(ids, failed) {
    const n = ids.length;
    // The window may have been closed while the uploads ran; then a toast has to say it.
    if (!document.body.contains(body)) {
      toast(n ? `${n} work${n === 1 ? '' : 's'} added. They’re waiting for their details in your collection.` : 'Nothing could be added.');
      return;
    }
    body.innerHTML = `
      <div class="imp-done"><span class="imp-big">${n}</span><span>work${n === 1 ? '' : 's'} added to your collection, each waiting for ${n === 1 ? 'its' : 'their'} details.</span></div>
      ${failed.length ? `<details class="imp-list bad" open><summary>${failed.length} couldn’t be added</summary><ul>${failed.map(s => `<li><b>${esc(s.name)}</b>${esc(s.why)}</li>`).join('')}</ul></details>` : ''}
      ${n ? '<p class="imp-note">Now go through them one by one. Title and artist are all that’s required; anything you skip waits for you in the collection.</p>' : ''}`;
    foot.innerHTML = `
      <button class="btn" type="button" id="fuLater">${n ? 'Later' : 'Close'}</button>
      <span class="spacer"></span>
      ${n ? `<button class="btn btn-primary caps" type="button" id="fuDescribe">Describe ${n === 1 ? 'it' : 'them'} now</button>` : ''}`;
    foot.querySelector('#fuLater').onclick = () => closeModal();
    if (n) foot.querySelector('#fuDescribe').onclick = () => closeModal(0, () => onDescribe && onDescribe(ids));
  }

  paintPick();
}

/** Everything dropped, folders walked recursively. Falls back to plain files where entries aren't supported. */
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])];
  const entries = items.map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])];
  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
      if (file) { file.relPath = prefix + file.name; out.push(file); }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries hands back at most ~100 at a time; keep asking until it returns nothing.
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}

/* ============================== step two: the details ============================== */

/** Camera file names make poor titles; for those the title field starts empty instead. */
const CAMERA_NAME = /^(img|dsc|dscn|dscf|dcim|pxl|photo|image|screenshot|screen shot|whatsapp|mvimg|gopr|p\d{5,}|\d{5,})/i;

export function openDescriber({ ids = [], onChanged, _at = null, _previous = null, _changed = false } = {}) {
  const works = ids.map(id => state.artworks.find(w => w.id === id)).filter(Boolean);
  if (!works.length) { toast('Those works have already been described.'); return; }

  let at = _at != null ? Math.min(_at, works.length - 1) : Math.max(0, works.findIndex(w => w.needsDetails));
  let previous = _previous;         // the last details saved, for "Same as the last one"
  let changed = _changed;
  const done = new Set(works.filter(w => !w.needsDetails).map(w => w.id));
  const artists = () => [...new Set(state.artworks.map(w => w.artist).concat(works.map(w => w.artist)).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const modal = openModal(`
    <div class="modal-head">
      <h3>Describe the works</h3>
      <span class="d-count" id="dCount" aria-live="polite"></span>
      <button class="x" data-close aria-label="Close">×</button>
    </div>
    <form id="dForm" class="describe" novalidate>
      <div class="d-art"><div class="d-frame" id="dFrame"></div><p class="d-file" id="dFile"></p></div>
      <div class="d-fields" id="dFields"></div>
    </form>
    <div class="d-strip" id="dStrip" aria-label="Works in this folder"></div>
    <div class="modal-foot">
      <button class="btn btn-danger btn-sm" type="button" id="dRemove">Remove this one</button>
      <span class="spacer"></span>
      <button class="btn" type="button" id="dPrev">Previous</button>
      <button class="btn" type="button" id="dSkip">Skip</button>
      <button class="btn btn-primary caps" type="submit" form="dForm" id="dSave">Save and next</button>
    </div>`, { size: 'xl describe-modal' });

  // The collection behind is refreshed after every save, so however this closes it is current.
  const finish = () => {
    closeModal();
    const left = works.filter(w => !done.has(w.id)).length;
    if (changed) toast(left ? `Saved. ${left} still waiting for details — they’re in your collection.` : 'Every work is described.');
  };

  function paint() {
    const w = works[at];
    const n = works.length;
    $('#dCount').textContent = `${at + 1} of ${n} · ${done.size} done`;
    const img = w.images[0];
    $('#dFrame').innerHTML = img
      ? `<img src="${esc(img.url)}" alt="The photograph for this work"${img.width ? ` width="${img.width}" height="${img.height}"` : ''}>`
      : '<div class="noimage-slab"><p>No image</p></div>';
    $('#dFile').textContent = w.needsDetails ? `From ${w.title}` : 'Already described';

    const title = w.needsDetails && CAMERA_NAME.test(w.title) ? '' : w.title;
    const v = (k) => (w[k] == null ? '' : w[k]);
    $('#dFields').innerHTML = `
      ${previous ? '<button type="button" class="linkish d-same" id="dSame">Same artist and details as the last one</button>' : ''}
      <div class="field">
        <label for="dTitle">Title</label>
        <input class="input" id="dTitle" value="${esc(title)}" placeholder="${esc(w.needsDetails ? w.title : 'Untitled')}" maxlength="200" autocomplete="off">
      </div>
      <div class="row2">
        <div class="field">
          <label for="dArtist">Artist</label>
          <input class="input" id="dArtist" list="dArtists" value="${esc(v('artist'))}" maxlength="200" autocomplete="off">
          <datalist id="dArtists">${artists().map(a => `<option value="${esc(a)}">`).join('')}</datalist>
        </div>
        <div class="field">
          <label for="dYear">Year <span class="opt">— optional</span></label>
          <input class="input" id="dYear" type="number" min="0" max="${thisYear}" value="${esc(v('year'))}" placeholder="Unknown">
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label for="dType">Type</label>
          <select class="select" id="dType">${TYPES.map(t => `<option${w.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label for="dInv">Inventory no. <span class="opt">— optional</span></label>
          <input class="input" id="dInv" value="${esc(v('inventoryNumber'))}" maxlength="60">
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label for="dMedium">Medium <span class="opt">— optional</span></label>
          <input class="input" id="dMedium" value="${esc(v('medium'))}" placeholder="Oil on canvas" maxlength="200">
        </div>
        <div class="field">
          <label for="dDims">Dimensions <span class="opt">— optional</span></label>
          <input class="input" id="dDims" value="${esc(v('dimensions'))}" placeholder="120 × 90 cm" maxlength="120">
        </div>
      </div>
      <div class="field">
        <span class="label" id="dStatusLabel">Status</span>
        <div class="segmented" role="radiogroup" aria-labelledby="dStatusLabel">
          ${STATUSES.map(st => `<label class="seg"><input type="radio" name="dStatus" value="${st}"${(w.status || 'collection') === st ? ' checked' : ''}><span><i class="dot ${st}"></i>${STATUS_LABEL[st]}</span></label>`).join('')}
        </div>
      </div>
      <div class="row2">
        <div class="field" id="dAskWrap">
          <label for="dAsking">Asking price <span class="opt">— optional</span></label>
          <input class="input" id="dAsking" type="number" min="0" step="any" value="${esc(v('askingPrice'))}">
        </div>
        <div class="field" id="dSoldWrap">
          <label for="dSold">Sold for <span class="opt">— optional</span></label>
          <input class="input" id="dSold" type="number" min="0" step="any" value="${esc(v('soldPrice'))}">
        </div>
        <div class="field" id="dPaidWrap">
          <label for="dPaid">Price paid <span class="opt">— optional</span></label>
          <input class="input" id="dPaid" type="number" min="0" step="any" value="${esc(v('purchasePrice'))}">
        </div>
        <div class="field">
          <label for="dLocation">Where it is <span class="opt">— optional</span></label>
          <input class="input" id="dLocation" value="${esc(v('storageLocation'))}" placeholder="Living room, north wall" maxlength="300">
        </div>
      </div>
      <div class="field">
        <label for="dNotes">Notes <span class="opt">— optional</span></label>
        <textarea class="input" id="dNotes" rows="2" maxlength="4000">${esc(v('notes'))}</textarea>
      </div>
      <div class="err hidden" id="dErr" role="alert"></div>`;

    const status = () => document.querySelector('input[name="dStatus"]:checked')?.value || 'collection';
    const showPrices = () => {
      $('#dAskWrap').hidden = status() !== 'for_sale';
      $('#dSoldWrap').hidden = status() !== 'sold';
      $('#dPaidWrap').hidden = status() !== 'collection';
    };
    document.querySelectorAll('input[name="dStatus"]').forEach(r => { r.onchange = showPrices; });
    showPrices();

    const same = $('#dSame');
    if (same) same.onclick = () => {
      $('#dArtist').value = previous.artist;
      $('#dYear').value = previous.year ?? '';
      $('#dType').value = previous.type;
      $('#dMedium').value = previous.medium || '';
      $('#dDims').value = previous.dimensions || '';
      const r = document.querySelector(`input[name="dStatus"][value="${previous.status}"]`);
      if (r) { r.checked = true; showPrices(); }
      $('#dTitle').focus();
    };

    $('#dPrev').disabled = at === 0;
    $('#dSave').textContent = done.size + (w.needsDetails ? 1 : 0) >= works.length || at === works.length - 1 ? 'Save and finish' : 'Save and next';
    paintStrip();
    if (matchMedia('(pointer: fine)').matches) requestAnimationFrame(() => ($('#dTitle').value ? $('#dArtist') : $('#dTitle')).focus({ preventScroll: true }));
  }

  function paintStrip() {
    $('#dStrip').innerHTML = works.map((w, i) => `
      <button type="button" data-i="${i}" class="${i === at ? 'on' : ''}${done.has(w.id) ? ' done' : ''}" aria-label="Work ${i + 1}${done.has(w.id) ? ', described' : ''}"${i === at ? ' aria-current="true"' : ''}>
        ${w.images[0] ? `<img src="${esc(w.images[0].thumbUrl || w.images[0].url)}" alt="" loading="lazy">` : ''}
      </button>`).join('');
    $('#dStrip').querySelectorAll('[data-i]').forEach(b => { b.onclick = () => { at = Number(b.dataset.i); paint(); }; });
    $('#dStrip .on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  /** The next work still waiting, after this one, wrapping round; -1 when none are left. */
  const nextWaiting = () => {
    for (let k = 1; k <= works.length; k++) {
      const i = (at + k) % works.length;
      if (!done.has(works[i].id)) return i;
    }
    return -1;
  };

  modal.querySelector('#dForm').onsubmit = async (e) => {
    e.preventDefault();
    const w = works[at];
    const err = $('#dErr');
    const body = {
      title: $('#dTitle').value.trim(),
      artist: $('#dArtist').value.trim(),
      year: $('#dYear').value,
      type: $('#dType').value,
      inventoryNumber: $('#dInv').value.trim(),
      medium: $('#dMedium').value.trim(),
      dimensions: $('#dDims').value.trim(),
      status: document.querySelector('input[name="dStatus"]:checked')?.value || 'collection',
      askingPrice: $('#dAsking').value,
      soldPrice: $('#dSold').value,
      purchasePrice: $('#dPaid').value,
      storageLocation: $('#dLocation').value.trim(),
      notes: $('#dNotes').value.trim()
    };
    if (!body.title) { err.textContent = 'Please give the work a title. “Untitled” is fine.'; err.classList.remove('hidden'); return $('#dTitle').focus(); }
    if (!body.artist) { err.textContent = 'Please name the artist. “Unknown” is fine.'; err.classList.remove('hidden'); return $('#dArtist').focus(); }
    const save = $('#dSave');
    save.disabled = true;
    try {
      const res = await api.patch(`/api/artworks/${w.id}`, body);
      works[at] = res.artwork;
      const idx = state.artworks.findIndex(x => x.id === w.id);
      if (idx !== -1) state.artworks[idx] = res.artwork;
      done.add(w.id);
      changed = true;
      previous = res.artwork;
      if (onChanged) onChanged();
      const next = nextWaiting();
      if (next === -1) return finish();
      at = next;
      paint();
    } catch (ex) {
      err.textContent = ex instanceof ApiError ? ex.message : 'That didn’t save. Please try again.';
      err.classList.remove('hidden');
    } finally { save.disabled = false; }
  };

  modal.querySelector('#dPrev').onclick = () => { if (at > 0) { at--; paint(); } };
  modal.querySelector('#dSkip').onclick = () => {
    const next = nextWaiting();
    if (next === -1 || next === at) { if (at < works.length - 1) { at++; paint(); } else finish(); return; }
    at = next; paint();
  };
  modal.querySelector('#dRemove').onclick = async () => {
    const w = works[at];
    const ok = await confirmDialog({
      title: 'Remove this one?',
      message: 'The photograph and this work are removed from your collection. The file on your computer isn’t touched.',
      confirmLabel: 'Remove', danger: true
    });
    // confirmDialog replaced the describer; reopen it on the same place either way.
    if (ok) {
      try { await api.del(`/api/artworks/${w.id}`); } catch { /* already gone */ }
      state.artworks = state.artworks.filter(x => x.id !== w.id);
      works.splice(at, 1);
      done.delete(w.id);
      changed = true;
    }
    if (!works.length) { if (onChanged) onChanged(); return; }
    openDescriber({ ids: works.map(x => x.id), onChanged, _at: Math.min(at, works.length - 1), _previous: previous, _changed: changed });
  };

  paint();
}
