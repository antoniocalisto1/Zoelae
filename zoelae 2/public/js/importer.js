// Importing works or clients from a spreadsheet: choose the file, check how its columns match,
// add the photographs, then watch it go in. One modal, three steps; the server does the reading.
import { esc } from './format.js';
import { api, ApiError } from './api.js';
import { openModal, closeModal, toast } from './ui.js';
import { SITE } from './brand.js';

const IMAGE_RE = /\.(jpe?g|png|webp|gif|tiff?|heic|svg)$/i;
const stem = (name) => String(name).split(/[\\/]/).pop().toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^a-z0-9]+/g, '');
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const WORDS = {
  artworks: { thing: 'work', things: 'works', place: 'your collection', title: 'Import works from a spreadsheet' },
  clients: { thing: 'client', things: 'clients', place: 'your client list', title: 'Import clients from a spreadsheet' }
};

let el = null;           // the open modal
let kind = 'artworks';
let imp = null;          // { id, headers, mapping, fields, samples, rowCount, embeddedImages, filename }
let check = null;        // the latest /check answer
let photos = [];         // File[]
let onDone = () => {};
let checkTimer = null;
let polling = null;

function step(html) {
  el.innerHTML = html;
  el.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => closeModal(); });
}

export function openImport({ kind: k = 'artworks', onFinished } = {}) {
  kind = k;
  imp = null; check = null; photos = [];
  onDone = onFinished || (() => {});
  clearInterval(polling);
  el = openModal('<div></div>', { size: 'lg' });
  el.classList.add('importer');
  chooseStep();
}

/* ---------- 1. the file ---------- */

function chooseStep(error) {
  const w = WORDS[kind];
  step(`
    <div class="modal-head"><h3>${w.title}</h3><button class="x" data-close aria-label="Close">×</button></div>
    <div class="modal-body">
      <p class="imp-lede">Bring in many ${w.things} at once from Excel, Numbers or Google Sheets. Your own column names are fine; you'll check how they match before anything is saved.</p>
      <div class="drop imp-drop" id="sheetDrop" tabindex="0" role="button">
        <span class="imp-icon" aria-hidden="true">⇪</span>
        <b>Choose a spreadsheet</b> or drop it here
        <span class="imp-hint">Excel (.xlsx) or CSV · up to 2,000 rows</span>
      </div>
      <input type="file" id="sheetInput" accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" class="hidden">
      <div class="err ${error ? '' : 'hidden'}" id="impErr" role="alert">${esc(error || '')}</div>
      <div class="imp-tips">
        <div>
          <h4>No sheet yet?</h4>
          <p>Start from the template: one ${w.thing} per row, with the columns ${SITE} understands.</p>
          <a class="btn btn-sm pill" href="/api/imports/template.xlsx?kind=${kind}" download>Download the template</a>
        </div>
        ${kind === 'artworks' ? `<div>
          <h4>Photographs</h4>
          <p>A column with each photo's file name lets ${SITE} match them, or name the photos after the inventory number or title. Pictures placed inside an Excel sheet are picked up too.</p>
        </div>` : `<div>
          <h4>Duplicates</h4>
          <p>Anyone whose email is already on your list is skipped, so importing the same sheet twice does no harm.</p>
        </div>`}
      </div>
    </div>`);

  const input = el.querySelector('#sheetInput');
  const drop = el.querySelector('#sheetDrop');
  drop.onclick = () => input.click();
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
  input.onchange = () => input.files[0] && upload(input.files[0]);
  dropTarget(drop, (files) => files[0] && upload(files[0]));
}

async function upload(file) {
  if (/\.(xls|numbers|ods)$/i.test(file.name)) {
    return chooseStep('That format can’t be read directly. Save it as an Excel workbook (.xlsx) or CSV first: in Numbers, File → Export To; in Google Sheets, File → Download.');
  }
  step(`<div class="modal-head"><h3>${WORDS[kind].title}</h3></div>
    <div class="modal-body imp-busy"><span class="spinner" aria-hidden="true"></span>Reading ${esc(file.name)}…</div>`);
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('sheet', file);
  try {
    imp = (await api.postForm('/api/imports', fd)).import;
    matchStep();
  } catch (err) {
    chooseStep(err instanceof ApiError ? err.message : 'That file couldn’t be read. Please try again.');
  }
}

/* ---------- 2. columns, photos, problems ---------- */

function matchStep() {
  const w = WORDS[kind];
  const options = (current) => `<option value="">Leave out</option>` + imp.fields.map(f =>
    `<option value="${f.key}"${current === f.key ? ' selected' : ''}>${esc(f.label)}${f.required ? ' *' : ''}</option>`).join('');

  step(`
    <div class="modal-head"><h3>Check the columns</h3><button class="x" data-close aria-label="Close">×</button></div>
    <div class="modal-body">
      <p class="imp-file"><b>${esc(imp.filename)}</b>${imp.sheetName && imp.sheetName !== imp.filename ? ` · sheet “${esc(imp.sheetName)}”` : ''} · ${plural(imp.rowCount, 'row')}
        <button type="button" class="linkish" id="otherFile">Choose a different file</button></p>

      <div class="imp-map" role="table" aria-label="Column matching">
        <div class="imp-map-head" role="row"><span role="columnheader">Your column</span><span role="columnheader">Goes into</span></div>
        ${imp.headers.map((h, i) => `
          <div class="imp-map-row ${imp.mapping[i] ? '' : 'off'}" role="row">
            <span class="imp-col" role="cell"><b>${esc(h)}</b><small>${imp.samples[i].map(esc).join(' · ') || '<i>empty</i>'}</small></span>
            <span role="cell"><select class="select" data-col="${i}" aria-label="Field for ${esc(h)}">${options(imp.mapping[i])}</select></span>
          </div>`).join('')}
      </div>

      ${kind === 'artworks' ? `
      <div class="section imp-photos">
        <h4>Photographs <span class="opt">optional</span></h4>
        <div class="inner">
          <div class="drop" id="photoDrop" tabindex="0" role="button"><b>Add photos</b> (select many at once) <b>or a .zip</b> of them<br>
            <span class="imp-hint">Matched to rows by file name, or by inventory number or title. Up to 25 MB a photo.</span></div>
          <input type="file" id="photoInput" accept="image/*,.zip,application/zip" multiple class="hidden">
          <div id="photoStatus" class="imp-photo-status"></div>
        </div>
      </div>` : ''}

      <div id="impCheck" class="imp-check" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Checking rows…</div>
    </div>
    <div class="modal-foot">
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn btn-primary" type="button" id="runBtn" disabled>Import</button>
    </div>`);

  el.querySelector('#otherFile').onclick = () => chooseStep();
  el.querySelectorAll('[data-col]').forEach(sel => {
    sel.onchange = () => {
      const i = Number(sel.dataset.col);
      // one column per field: taking a field from another column clears it there
      if (sel.value) imp.mapping.forEach((k, j) => { if (j !== i && k === sel.value) { imp.mapping[j] = ''; el.querySelector(`[data-col="${j}"]`).value = ''; el.querySelector(`[data-col="${j}"]`).closest('.imp-map-row').classList.add('off'); } });
      imp.mapping[i] = sel.value;
      sel.closest('.imp-map-row').classList.toggle('off', !sel.value);
      scheduleCheck();
    };
  });
  if (kind === 'artworks') {
    const input = el.querySelector('#photoInput');
    const drop = el.querySelector('#photoDrop');
    drop.onclick = () => input.click();
    drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    input.onchange = () => { addPhotos([...input.files]); input.value = ''; };
    dropTarget(drop, addPhotos);
  }
  el.querySelector('#runBtn').onclick = run;
  runCheck();
}

function addPhotos(files) {
  const known = new Set(photos.map(f => f.name + f.size));
  photos.push(...files.filter(f => (IMAGE_RE.test(f.name) || /\.zip$/i.test(f.name)) && !known.has(f.name + f.size)));
  paintPhotos();
}

function paintPhotos() {
  const box = el.querySelector('#photoStatus');
  if (!box) return;
  const zips = photos.filter(f => /\.zip$/i.test(f.name));
  const loose = photos.filter(f => !/\.zip$/i.test(f.name));
  const have = new Set(loose.map(f => stem(f.name)));
  const named = check?.imageNames || [];
  const matched = named.filter(n => have.has(stem(n))).length;
  const size = photos.reduce((s, f) => s + f.size, 0);
  let line = '';
  if (photos.length) {
    line = `<b>${plural(loose.length, 'photo')}${zips.length ? ` and ${plural(zips.length, 'zip')}` : ''}</b> added (${(size / 1048576).toFixed(1)} MB)`;
    if (named.length) line += zips.length ? `. Photos inside the zip are matched when importing.` : `. ${matched} of ${named.length} named in the sheet found.`;
    line += ` <button type="button" class="linkish" id="clearPhotos">Remove</button>`;
  } else if (named.length) {
    line = `The sheet names ${plural(named.length, 'photo')}. Add them here, or import now and add photos later.`;
  }
  if (check?.withEmbeddedImage) line += `<br>${plural(check.withEmbeddedImage, 'row')} ${check.withEmbeddedImage === 1 ? 'has a picture' : 'have pictures'} inside the sheet, used when no photo file matches.`;
  box.innerHTML = line;
  const clear = box.querySelector('#clearPhotos');
  if (clear) clear.onclick = () => { photos = []; paintPhotos(); };
}

function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, 250);
}

async function runCheck() {
  const box = el.querySelector('#impCheck');
  const runBtn = el.querySelector('#runBtn');
  if (!box) return;
  try {
    check = await api.post(`/api/imports/${imp.id}/check`, { mapping: imp.mapping });
  } catch (err) {
    box.innerHTML = `<div class="err">${esc(err instanceof ApiError ? err.message : 'Couldn’t check the rows.')}</div>`;
    return;
  }
  const w = WORDS[kind];
  const fieldLabel = (k) => imp.fields.find(f => f.key === k)?.label || k;

  if (check.missing.length) {
    box.innerHTML = `<div class="imp-missing">Choose which column holds the <b>${check.missing.map(fieldLabel).map(esc).join('</b> and the <b>')}</b>. It's needed for every ${w.thing}.</div>`;
    runBtn.disabled = true;
    paintPhotos();
    return;
  }

  box.innerHTML = `
    <div class="imp-summary">
      <span class="imp-big">${check.ready}</span>
      <span>of ${plural(check.total, 'row')} ready to import${kind === 'artworks' && !imp.mapping.includes('title') ? ', titled “Untitled” as there is no title column' : ''}.</span>
    </div>
    ${check.duplicates ? `<label class="imp-dupes"><input type="checkbox" id="skipDupes" checked>
      Skip ${plural(check.duplicates, 'row')} that ${check.duplicates === 1 ? 'looks' : 'look'} like ${check.duplicates === 1 ? `a ${w.thing}` : w.things} already in ${w.place}</label>` : ''}
    ${check.problems.length ? `<details class="imp-list bad" open><summary>${plural(check.problems.length, 'row')} can't be imported</summary>
      <ul>${check.problems.slice(0, 50).map(p => `<li><b>Row ${p.line}</b> ${esc(p.message)}</li>`).join('')}</ul></details>` : ''}
    ${check.warnings.length ? `<details class="imp-list"><summary>${plural(check.warnings.length, 'row')} with something left blank</summary>
      <ul>${check.warnings.slice(0, 50).map(p => `<li><b>Row ${p.line}</b> ${esc(p.message)}</li>`).join('')}</ul></details>` : ''}
    ${preview()}`;

  const skip = box.querySelector('#skipDupes');
  const label = () => {
    const n = check.ready - (skip && !skip.checked ? 0 : check.duplicates);
    runBtn.textContent = n ? `Import ${plural(n, w.thing, w.things)}` : 'Nothing to import';
    runBtn.disabled = !n;
  };
  if (skip) skip.onchange = label;
  label();
  paintPhotos();
}

function preview() {
  if (!check.preview.length) return '';
  if (kind === 'clients') {
    return `<div class="imp-preview"><h4>First rows, as they'll come in</h4><table><thead><tr><th>Row</th><th>Name</th><th>Email</th><th class="hide-sm">Company</th><th class="hide-sm">City</th></tr></thead><tbody>
      ${check.preview.map(r => `<tr class="${r.problems.length ? 'bad' : ''}"><td>${r.line}</td><td>${esc(r.name) || '—'}</td><td>${esc(r.email) || '—'}</td><td class="hide-sm">${esc(r.company) || '—'}</td><td class="hide-sm">${esc(r.city) || '—'}</td></tr>`).join('')}
    </tbody></table></div>`;
  }
  const status = { collection: 'In the collection', for_sale: 'For sale', sold: 'Sold' };
  const price = (r) => {
    const v = r.status === 'for_sale' ? r.askingPrice : r.status === 'sold' ? r.soldPrice : r.purchasePrice;
    return v === '' || v == null ? '—' : `${esc(r.currency)} ${Number(v).toLocaleString()}`;
  };
  return `<div class="imp-preview"><h4>First rows, as they'll come in</h4><table><thead><tr><th>Row</th><th>Title</th><th>Artist</th><th>Year</th><th class="hide-sm">Type</th><th class="hide-sm">Status</th><th class="hide-sm">Price</th></tr></thead><tbody>
    ${check.preview.map(r => `<tr class="${r.problems.length ? 'bad' : ''}"><td>${r.line}</td><td>${esc(r.title)}</td><td>${esc(r.artist) || '<i>missing</i>'}</td><td>${r.year === '' ? '—' : r.year}</td><td class="hide-sm">${esc(r.type)}</td><td class="hide-sm"><i class="dot ${r.status}"></i> ${status[r.status]}</td><td class="hide-sm">${price(r)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

/* ---------- 3. running ---------- */

function run() {
  const w = WORDS[kind];
  const fd = new FormData();
  fd.append('mapping', JSON.stringify(imp.mapping));
  fd.append('skipDuplicates', String(el.querySelector('#skipDupes')?.checked !== false));
  photos.forEach(f => fd.append('photos', f, f.name));

  step(`
    <div class="modal-head"><h3>Importing ${w.things}</h3><button class="x" data-close aria-label="Close">×</button></div>
    <div class="modal-body">
      <div class="imp-progress"><div class="bar"><span id="impBar"></span></div>
        <p id="impPhase">${photos.length ? 'Uploading photographs…' : 'Starting…'}</p></div>
      <p class="imp-hint">You can close this window: the import carries on, and the ${w.things} appear as they're added.</p>
    </div>`);

  // XHR rather than fetch, for upload progress on a large zip.
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/imports/${imp.id}/run`);
  xhr.withCredentials = true;
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable || !el.querySelector('#impBar')) return;
    const p = e.loaded / e.total;
    el.querySelector('#impBar').style.width = `${Math.round(p * 30)}%`;
    el.querySelector('#impPhase').textContent = `Uploading photographs… ${Math.round(p * 100)}%`;
  };
  xhr.onload = () => {
    let body = null;
    try { body = JSON.parse(xhr.responseText); } catch { /* not json */ }
    if (xhr.status !== 202) {
      step(`<div class="modal-head"><h3>Import didn't start</h3><button class="x" data-close>×</button></div>
        <div class="modal-body"><div class="err">${esc(body?.message || 'Something went wrong. Please try again.')}</div></div>
        <div class="modal-foot"><button class="btn" data-close>Close</button><button class="btn btn-primary" id="backBtn">Back</button></div>`);
      el.querySelector('#backBtn').onclick = () => matchStep();
      return;
    }
    poll();
  };
  xhr.onerror = () => step(`<div class="modal-head"><h3>Connection lost</h3><button class="x" data-close>×</button></div>
    <div class="modal-body"><p>The upload was interrupted. Check your connection and try again.</p></div>
    <div class="modal-foot"><button class="btn" data-close>Close</button></div>`);
  xhr.send(fd);
}

function poll() {
  const tick = async () => {
    let job;
    try { job = (await api.get(`/api/imports/${imp.id}`)).job; } catch { return; }
    if (!job) return;
    const bar = el?.isConnected && el.querySelector('#impBar');
    if (bar) {
      const share = photos.length ? 0.3 : 0;
      bar.style.width = `${Math.round((share + (1 - share) * (job.total ? job.done / job.total : 1)) * 100)}%`;
      el.querySelector('#impPhase').textContent = `${job.done} of ${job.total} rows · ${plural(job.created, WORDS[kind].thing, WORDS[kind].things)} added`;
    }
    if (job.state !== 'running') {
      clearInterval(polling);
      onDone(job);
      if (el?.isConnected) doneStep(job);
      else toast(`Import finished: ${plural(job.created, WORDS[kind].thing, WORDS[kind].things)} added.`);
    }
  };
  polling = setInterval(tick, 700);
  tick();
}

function doneStep(job) {
  const w = WORDS[kind];
  step(`
    <div class="modal-head"><h3>${job.state === 'done' ? 'Imported' : 'Import stopped'}</h3><button class="x" data-close aria-label="Close">×</button></div>
    <div class="modal-body">
      ${job.error ? `<div class="err">${esc(job.error)}</div>` : ''}
      <div class="imp-done">
        <span class="imp-big">${job.created}</span>
        <span>${job.created === 1 ? w.thing : w.things} added to ${w.place}.</span>
      </div>
      ${job.needsImage ? `<p class="imp-note"><i class="dot" style="background:var(--ochre)"></i><span>${plural(job.needsImage, 'work')} came in without a photograph and ${job.needsImage === 1 ? 'is' : 'are'} marked “No image yet”. Open one and choose <b>Add a photograph</b>.</span></p>` : ''}
      ${job.skipped.length ? `<details class="imp-list bad"${job.skipped.length < 8 ? ' open' : ''}><summary>${plural(job.skipped.length, 'row')} skipped</summary>
        <ul>${job.skipped.slice(0, 100).map(s => `<li><b>Row ${s.line}</b> ${esc(s.reason)}</li>`).join('')}</ul></details>` : ''}
      ${job.warnings.length ? `<details class="imp-list"><summary>${plural(job.warnings.length, 'note')}</summary>
        <ul>${job.warnings.slice(0, 100).map(s => `<li><b>Row ${s.line}</b> ${esc(s.message)}</li>`).join('')}</ul></details>` : ''}
    </div>
    <div class="modal-foot">
      <button class="btn" type="button" id="againBtn">Import another sheet</button>
      <button class="btn btn-primary" type="button" data-close>See ${w.place}</button>
    </div>`);
  el.querySelector('#againBtn').onclick = () => { imp = null; check = null; photos = []; chooseStep(); };
}

function dropTarget(target, onFiles) {
  target.ondragover = (e) => { e.preventDefault(); target.classList.add('over'); };
  target.ondragleave = () => target.classList.remove('over');
  target.ondrop = (e) => { e.preventDefault(); target.classList.remove('over'); onFiles([...e.dataTransfer.files]); };
}

