// Add / edit an artwork. Files are posted as multipart; the server writes them outside the web root.
import { $, esc, thisYear, fileSize, DOC_KIND_LABEL } from './format.js';
import { api, ApiError } from './api.js';
import { state, TYPES, STATUSES, STATUS_LABEL, loadClients } from './store.js';
import { openModal, closeModal, toast, confirmDialog } from './ui.js';

const DOC_KINDS = ['certificate', 'appraisal', 'invoice', 'condition_report', 'other'];

let pendingImages = [];      // File[]
let pendingDocuments = [];   // { file, kind, label }

export function openArtworkForm(existing, { onSaved, focusDocuments = false } = {}) {
  const editing = !!existing;
  pendingImages = [];
  pendingDocuments = [];

  const modal = openModal(`
    <div class="modal-head">
      <h3>${editing ? 'Edit artwork' : 'Add an artwork'}</h3>
      <button class="x" data-close>×</button>
    </div>
    <form id="workForm"><div class="modal-body">
      <div class="field">
        <label>Images</label>
        ${editing && existing.images.length ? `<div class="filelist" id="existingImages">${existing.images.map(img => `
          <span class="filepill"><img src="${esc(img.thumbUrl || img.url)}" alt="" style="width:26px;height:22px;object-fit:cover;border-radius:4px">
            image<button type="button" data-del-image="${img.id}" title="Remove">×</button></span>`).join('')}</div>` : ''}
        <div class="drop" id="imageDrop"><b>Click to upload</b> or drop images here<br>
          <span style="font-size:12.5px">JPG, PNG, WEBP or SVG · up to 25 MB each</span></div>
        <input type="file" id="imageInput" accept="image/*" multiple class="hidden">
        <div class="filelist" id="imageList"></div>
      </div>

      <div class="row2 title-row">
        <div class="field">
          <label for="wTitle">Title</label>
          <input class="input" id="wTitle" value="${editing ? esc(existing.title) : ''}" placeholder="Untitled (Red Field)">
        </div>
        <div class="field">
          <label for="wInv">Inventory no. <span class="opt">— optional</span></label>
          <input class="input" id="wInv" value="${editing ? esc(existing.inventoryNumber) : ''}" placeholder="GG-0142" maxlength="60">
        </div>
      </div>

      <div class="field">
        <label>Status</label>
        <div class="segmented" id="wStatus" role="radiogroup" aria-label="Status">
          ${STATUSES.map(st => `<label class="seg"><input type="radio" name="wStatus" value="${st}"${(existing?.status || 'collection') === st ? ' checked' : ''}><span><i class="dot ${st}"></i>${STATUS_LABEL[st]}</span></label>`).join('')}
        </div>
        <div class="status-extra" id="statusSale" hidden>
          <div class="field">
            <label for="wAsking">Asking price <span class="opt">— optional</span></label>
            <input class="input" id="wAsking" type="number" min="0" step="any" value="${valueOf(existing, 'askingPrice')}" placeholder="€ 18,000">
          </div>
        </div>
        <div class="status-extra" id="statusSold" hidden>
          <div class="row3">
            <div class="field">
              <label for="wSoldPrice">Sold for <span class="opt">— optional</span></label>
              <input class="input" id="wSoldPrice" type="number" min="0" step="any" value="${valueOf(existing, 'soldPrice')}">
            </div>
            <div class="field">
              <label for="wSoldAt">Date sold <span class="opt">— optional</span></label>
              <input class="input" id="wSoldAt" type="date" value="${editing ? esc(existing.soldAt) : ''}">
            </div>
            <div class="field">
              <label for="wSoldTo">Buyer <span class="opt">— optional</span></label>
              <select class="select" id="wSoldTo"><option value="">Not recorded</option></select>
            </div>
          </div>
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label for="wArtist">Artist</label>
          <input class="input" id="wArtist" list="artistList" value="${editing ? esc(existing.artist) : ''}" placeholder="Anders Holm">
          <datalist id="artistList">${[...new Set(state.artworks.map(w => w.artist).filter(Boolean))].map(a => `<option value="${esc(a)}">`).join('')}</datalist>
        </div>
        <div class="field">
          <label for="wYear">Year created <span class="opt">— optional</span></label>
          <input class="input" id="wYear" type="number" min="0" max="${thisYear}" value="${editing && existing.year != null ? existing.year : ''}" placeholder="Unknown">
        </div>
      </div>
      <div class="field">
        <label for="wType">Type</label>
        <select class="select" id="wType">
          ${TYPES.map(t => `<option value="${t}"${editing && existing.type === t ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="row2">
        <div class="field">
          <label for="wMedium">Medium <span class="opt">— optional</span></label>
          <input class="input" id="wMedium" value="${editing ? esc(existing.medium) : ''}" placeholder="Oil on canvas">
        </div>
        <div class="field">
          <label for="wDims">Dimensions <span class="opt">— optional</span></label>
          <input class="input" id="wDims" value="${editing ? esc(existing.dimensions) : ''}" placeholder="120 × 90 cm">
        </div>
      </div>

      <div class="section">
        <h4>Value</h4>
        <div class="inner">
          <div class="row2">
            <div class="field">
              <label for="wPrice">Price bought at <span class="opt">— optional</span></label>
              <input class="input" id="wPrice" type="number" min="0" step="any" value="${valueOf(existing, 'purchasePrice')}" placeholder="€ 12,400">
            </div>
            <div class="field">
              <label for="wValuation">Current valuation <span class="opt">— optional</span></label>
              <input class="input" id="wValuation" type="number" min="0" step="any" value="${valueOf(existing, 'currentValuation')}" placeholder="€ 19,500">
            </div>
          </div>
          <div class="row2">
            <div class="field">
              <label for="wInsured">Insured value <span class="opt">— optional</span></label>
              <input class="input" id="wInsured" type="number" min="0" step="any" value="${valueOf(existing, 'insuredValue')}">
            </div>
            <div class="field">
              <label for="wValuationDate">Valued on <span class="opt">— optional</span></label>
              <input class="input" id="wValuationDate" type="date" value="${editing ? esc(existing.valuationDate) : ''}">
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <h4>Provenance & ownership</h4>
        <div class="inner">
          <div class="row2">
            <div class="field">
              <label for="wAcquired">Date acquired <span class="opt">— optional</span></label>
              <input class="input" id="wAcquired" type="date" value="${editing ? esc(existing.acquiredAt) : ''}">
            </div>
            <div class="field">
              <label for="wAcquiredFrom">Acquired from <span class="opt">— optional</span></label>
              <input class="input" id="wAcquiredFrom" value="${editing ? esc(existing.acquiredFrom) : ''}" placeholder="Galerie Vandel, Antwerp">
            </div>
          </div>
          <div class="field">
            <label for="wProvenance">Ownership history <span class="opt">— optional</span></label>
            <textarea class="input" id="wProvenance" rows="2" placeholder="Where the piece has been, and when.">${editing ? esc(existing.provenance) : ''}</textarea>
          </div>
          <div class="field">
            <label for="wPriorOwners">Prior owners <span class="opt">— optional</span></label>
            <input class="input" id="wPriorOwners" value="${editing ? esc(existing.priorOwners) : ''}">
          </div>
          <div class="field" style="margin-bottom:0">
            <label for="wExhibitions">Exhibition history <span class="opt">— optional</span></label>
            <textarea class="input" id="wExhibitions" rows="2">${editing ? esc(existing.exhibitionHistory) : ''}</textarea>
          </div>
        </div>
      </div>

      <div class="section">
        <h4>Certificates & documents</h4>
        <div class="inner">
          ${editing && existing.documents.length ? `<div class="filelist" id="existingDocs" style="margin:0 0 12px">${existing.documents.map(doc => `
            <span class="filepill">${esc(doc.label)} <span style="color:var(--muted-2)">${fileSize(doc.sizeBytes)}</span>
              <button type="button" data-del-doc="${doc.id}" title="Remove">×</button></span>`).join('')}</div>` : ''}
          <div class="drop" id="docDrop"><b>Add a document</b> — certificate, appraisal, invoice or condition report<br>
            <span style="font-size:12.5px">PDF, JPG or PNG</span></div>
          <input type="file" id="docInput" accept="application/pdf,image/*" multiple class="hidden">
          <div id="docList" style="margin-top:10px"></div>
        </div>
      </div>

      <div class="field">
        <label for="wLocation">Storage location <span class="opt">— optional</span></label>
        <input class="input" id="wLocation" value="${editing ? esc(existing.storageLocation) : ''}" placeholder="Drawing room — north wall">
      </div>
      <div class="field">
        <label for="wNotes">Notes <span class="opt">— optional</span></label>
        <textarea class="input" id="wNotes" rows="3" placeholder="Condition, framing, anything worth remembering.">${editing ? esc(existing.notes) : ''}</textarea>
      </div>
      <div class="err hidden" id="formErr"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Add to collection'}</button>
    </div></form>`, { size: 'lg' });

  wireFilePickers(modal);
  wireExistingFileDeletes(modal, existing, onSaved);
  wireStatus(modal, existing);

  if (focusDocuments) modal.querySelector('#docDrop').scrollIntoView({ block: 'center' });

  modal.querySelector('#workForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const showError = (msg) => {
      const el = modal.querySelector('#formErr');
      el.textContent = msg;
      el.classList.remove('hidden');
    };

    const value = (id) => modal.querySelector(id).value.trim();
    if (!editing && !pendingImages.length) return showError('Please add an image of the work.');
    if (!value('#wTitle')) return showError('Please give the work a title.');
    if (!value('#wArtist')) return showError('Please name the artist.');
    // Blank is allowed — a piece can be owned without its year being known.
    const yearRaw = value('#wYear');
    if (yearRaw && (Number(yearRaw) < 0 || Number(yearRaw) > thisYear)) {
      return showError(`Please enter a valid year, up to ${thisYear}.`);
    }

    const fd = new FormData();
    fd.append('title', value('#wTitle'));
    fd.append('artist', value('#wArtist'));
    fd.append('year', yearRaw);
    fd.append('type', modal.querySelector('#wType').value);
    fd.append('medium', value('#wMedium'));
    fd.append('dimensions', value('#wDims'));
    fd.append('purchasePrice', value('#wPrice'));
    fd.append('currentValuation', value('#wValuation'));
    fd.append('insuredValue', value('#wInsured'));
    fd.append('valuationDate', value('#wValuationDate'));
    fd.append('acquiredAt', value('#wAcquired'));
    fd.append('acquiredFrom', value('#wAcquiredFrom'));
    fd.append('provenance', value('#wProvenance'));
    fd.append('priorOwners', value('#wPriorOwners'));
    fd.append('exhibitionHistory', value('#wExhibitions'));
    fd.append('storageLocation', value('#wLocation'));
    fd.append('notes', value('#wNotes'));
    fd.append('inventoryNumber', value('#wInv'));
    fd.append('status', modal.querySelector('input[name="wStatus"]:checked')?.value || 'collection');
    fd.append('askingPrice', value('#wAsking'));
    fd.append('soldPrice', value('#wSoldPrice'));
    fd.append('soldAt', value('#wSoldAt'));
    fd.append('soldTo', modal.querySelector('#wSoldTo').value);
    pendingImages.forEach(file => fd.append('images', file));
    pendingDocuments.forEach(({ file, kind, label }) => {
      fd.append('documents', file);
      fd.append('documentKinds', kind);
      fd.append('documentLabels', label || file.name);
    });

    try {
      const res = editing
        ? await api.patchForm(`/api/artworks/${existing.id}`, fd)
        : await api.postForm('/api/artworks', fd);
      closeModal();
      toast(editing ? 'Changes saved.' : `“${res.artwork.title}” added to your collection.`);
      onSaved?.(res.artwork);
    } catch (err) {
      showError(err instanceof ApiError ? err.message : 'Could not save that. Please try again.');
    }
  };
}

/** The status picker shows the asking price for a work for sale, and the sale for a sold one. */
function wireStatus(modal, existing) {
  const sync = () => {
    const st = modal.querySelector('input[name="wStatus"]:checked')?.value;
    modal.querySelector('#statusSale').hidden = st !== 'for_sale';
    modal.querySelector('#statusSold').hidden = st !== 'sold';
  };
  modal.querySelectorAll('input[name="wStatus"]').forEach(r => { r.onchange = sync; });
  sync();
  // Buyers come from the client list, when there is one.
  loadClients().then(clients => {
    const sel = modal.querySelector('#wSoldTo');
    if (!sel) return;
    sel.innerHTML = '<option value="">Not recorded</option>' + clients.map(c =>
      `<option value="${esc(c.id)}"${existing?.soldTo?.id === c.id ? ' selected' : ''}>${esc(c.name)}${c.company ? ` · ${esc(c.company)}` : ''}</option>`).join('');
    if (!clients.length) sel.closest('.field').querySelector('label').insertAdjacentHTML('beforeend', ' <span class="opt">(add clients to pick one)</span>');
  }).catch(() => {});
}

const valueOf = (existing, key) =>
  existing && existing[key] !== null && existing[key] !== undefined ? existing[key] : '';

function wireFilePickers(modal) {
  const imageInput = modal.querySelector('#imageInput');
  const imageDrop = modal.querySelector('#imageDrop');
  const docInput = modal.querySelector('#docInput');
  const docDrop = modal.querySelector('#docDrop');

  const paintImages = () => {
    modal.querySelector('#imageList').innerHTML = pendingImages.map((f, i) =>
      `<span class="filepill">${esc(f.name)} <span style="color:var(--muted-2)">${fileSize(f.size)}</span>
        <button type="button" data-rm-image="${i}">×</button></span>`).join('');
    modal.querySelectorAll('[data-rm-image]').forEach(btn => {
      btn.onclick = () => { pendingImages.splice(Number(btn.dataset.rmImage), 1); paintImages(); };
    });
  };

  const paintDocs = () => {
    modal.querySelector('#docList').innerHTML = pendingDocuments.map((d, i) => `
      <div class="orderitem" style="margin-bottom:8px">
        <span class="grow">
          <span class="oi-t">${esc(d.file.name)}</span>
          <span class="oi-a">${fileSize(d.file.size)}</span>
        </span>
        <select class="select" data-doc-kind="${i}" style="width:auto;min-width:150px">
          ${DOC_KINDS.map(k => `<option value="${k}"${d.kind === k ? ' selected' : ''}>${DOC_KIND_LABEL[k]}</option>`).join('')}
        </select>
        <button type="button" class="move" data-rm-doc="${i}">×</button>
      </div>`).join('');
    modal.querySelectorAll('[data-doc-kind]').forEach(sel => {
      sel.onchange = () => { pendingDocuments[Number(sel.dataset.docKind)].kind = sel.value; };
    });
    modal.querySelectorAll('[data-rm-doc]').forEach(btn => {
      btn.onclick = () => { pendingDocuments.splice(Number(btn.dataset.rmDoc), 1); paintDocs(); };
    });
  };

  imageDrop.onclick = () => imageInput.click();
  imageInput.onchange = () => { pendingImages.push(...imageInput.files); imageInput.value = ''; paintImages(); };
  dropTarget(imageDrop, (files) => {
    pendingImages.push(...files.filter(f => f.type.startsWith('image/')));
    paintImages();
  });

  docDrop.onclick = () => docInput.click();
  docInput.onchange = () => {
    pendingDocuments.push(...[...docInput.files].map(file => ({ file, kind: guessKind(file.name), label: file.name })));
    docInput.value = '';
    paintDocs();
  };
  dropTarget(docDrop, (files) => {
    pendingDocuments.push(...files.map(file => ({ file, kind: guessKind(file.name), label: file.name })));
    paintDocs();
  });
}

const guessKind = (name) => {
  const n = name.toLowerCase();
  if (n.includes('cert')) return 'certificate';
  if (n.includes('apprais') || n.includes('valuation')) return 'appraisal';
  if (n.includes('invoice') || n.includes('receipt')) return 'invoice';
  if (n.includes('condition')) return 'condition_report';
  return 'other';
};

function dropTarget(el, onFiles) {
  el.ondragover = (e) => { e.preventDefault(); el.classList.add('over'); };
  el.ondragleave = () => el.classList.remove('over');
  el.ondrop = (e) => {
    e.preventDefault();
    el.classList.remove('over');
    onFiles([...e.dataTransfer.files]);
  };
}

function wireExistingFileDeletes(modal, existing, onSaved) {
  if (!existing) return;
  modal.querySelectorAll('[data-del-image]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await api.del(`/api/artworks/${existing.id}/images/${btn.dataset.delImage}`);
        btn.closest('.filepill').remove();
        onSaved?.(null, { silent: true });
      } catch (err) { toast(err.message); }
    };
  });
  modal.querySelectorAll('[data-del-doc]').forEach(btn => {
    btn.onclick = async () => {
      const ok = await confirmDialog({
        title: 'Remove this document?',
        message: 'It will be deleted from the piece and from any shared collection that shows documents.',
        confirmLabel: 'Remove', danger: true
      });
      if (!ok) return openArtworkForm(existing, { onSaved });
      try {
        await api.del(`/api/artworks/${existing.id}/documents/${btn.dataset.delDoc}`);
        onSaved?.(null, { silent: true });
        openArtworkForm(existing, { onSaved });
      } catch (err) { toast(err.message); }
    };
  });
}
