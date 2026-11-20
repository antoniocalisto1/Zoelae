// Sending works to clients: a shared link, or a PDF of chosen works, by email from the site.
// Opened from the client list, a client, a work's page, or a shared link.
import { esc, money } from './format.js';
import { api, ApiError } from './api.js';
import { state, loadClients, loadShares, STATUS_LABEL } from './store.js';
import { openModal, closeModal, toast } from './ui.js';

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const thumb = (w) => (w.images[0] ? `<img src="${esc(w.images[0].thumbUrl || w.images[0].url)}" alt="">` : '<span class="mini placeholder"></span>');

/**
 * @param {object} o
 * @param {string[]} [o.clientIds]   preselected recipients
 * @param {string[]} [o.artworkIds]  preselected works (opens on the PDF tab)
 * @param {string}   [o.shareSlug]   preselected link (opens on the link tab)
 * @param {Function} [o.onSent]
 */
export async function openSendModal({ clientIds = [], artworkIds = [], shareSlug = '', onSent } = {}) {
  let clients, shares;
  try {
    [clients, shares] = await Promise.all([loadClients(true), loadShares()]);
  } catch {
    return toast('Couldn’t load your clients. Please try again.');
  }
  const active = shares.filter(s => s.status === 'active');
  const to = new Set(clientIds);
  const works = new Set(artworkIds);
  let kind = shareSlug ? 'link' : artworkIds.length ? 'pdf' : (active.length ? 'link' : 'pdf');
  const from = state.user.displayName || state.user.email;

  const el = openModal(`
    <div class="modal-head"><h3>Send to clients</h3><button class="x" data-close aria-label="Close">×</button></div>
    <form id="sendForm">
    <div class="modal-body send-body">
      <div class="field">
        <label>To</label>
        <div class="send-to" id="sendTo"></div>
        <input class="input" id="toSearch" type="search" placeholder="${clients.length ? 'Add a client: type a name or email' : 'No clients yet'}" ${clients.length ? '' : 'disabled'} autocomplete="off">
        <div class="send-suggest hidden" id="toSuggest" role="listbox"></div>
      </div>

      <div class="field">
        <label>What to send</label>
        <div class="segmented" role="radiogroup">
          <label class="seg"><input type="radio" name="sendKind" value="link"${kind === 'link' ? ' checked' : ''}><span>A shared link</span></label>
          <label class="seg"><input type="radio" name="sendKind" value="pdf"${kind === 'pdf' ? ' checked' : ''}><span>A PDF of works</span></label>
        </div>
      </div>

      <div id="linkPane" class="send-pane">
        ${active.length ? `
        <div class="field">
          <label for="sendShare">Link</label>
          <select class="select" id="sendShare">${active.map(s => `<option value="${esc(s.slug)}"${s.slug === shareSlug ? ' selected' : ''}>${esc(s.title)} · ${plural(s.itemCount, 'work')}</option>`).join('')}</select>
          <div class="hint">They open it with the link's passcode. Only what that link allows is shown.</div>
        </div>
        <div class="field">
          <label for="sendPass">Passcode <span class="opt">— optional</span></label>
          <input class="input mono" id="sendPass" autocomplete="off" placeholder="Leave blank to send it separately">
          <div class="hint">Safer by text or phone than in the same email. Passcodes are stored scrambled, so it can't be filled in for you.</div>
        </div>` : `<div class="send-empty">You have no active shared links. Choose <b>A PDF of works</b>, or create a link from your collection first.</div>`}
      </div>

      <div id="pdfPane" class="send-pane">
        <div class="field">
          <label>Works <span class="opt" id="workCount"></span></label>
          <input class="input" id="workSearch" type="search" placeholder="Find a work: title, artist or inventory no." autocomplete="off">
          <div class="send-works" id="workList"></div>
        </div>
        <div class="send-options">
          <label><input type="checkbox" id="optStatus" checked> Say whether each work is available or sold</label>
          <label><input type="checkbox" id="optPrices"> Include asking prices</label>
          <a class="linkish" id="previewPdf" href="#" target="_blank">Preview the PDF</a>
        </div>
      </div>

      <div class="field">
        <label for="sendSubject">Subject</label>
        <input class="input" id="sendSubject" maxlength="160">
      </div>
      <div class="field">
        <label for="sendMessage">Message</label>
        <textarea class="input" id="sendMessage" rows="6" maxlength="5000"></textarea>
        <div class="hint">Write <b>{name}</b> for each client's first name. Replies come straight to ${esc(state.user.email)}.</div>
      </div>
      <div class="err hidden" id="sendErr" role="alert"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn btn-primary" type="submit" id="sendBtn">Send</button>
    </div>
    </form>`, { size: 'lg' });
  el.classList.add('send-modal');

  const $ = (s) => el.querySelector(s);
  let messageTouched = false;
  let subjectTouched = false;

  /* recipients */
  const paintTo = () => {
    $('#sendTo').innerHTML = [...to].map(id => {
      const c = clients.find(x => x.id === id);
      if (!c) return '';
      return `<span class="chip ${c.email ? '' : 'warn'}" title="${esc(c.email || 'No email address: will be skipped')}">${esc(c.name)}${c.email ? '' : ' · no email'}
        <button type="button" data-unpick="${esc(c.id)}" aria-label="Remove ${esc(c.name)}">×</button></span>`;
    }).join('') || '<span class="send-none">Nobody yet</span>';
    $('#sendTo').querySelectorAll('[data-unpick]').forEach(b => { b.onclick = () => { to.delete(b.dataset.unpick); paintTo(); syncButton(); }; });
  };
  const suggest = () => {
    const q = $('#toSearch').value.trim().toLowerCase();
    const box = $('#toSuggest');
    const hits = clients.filter(c => !to.has(c.id) && (!q || `${c.name} ${c.email} ${c.company}`.toLowerCase().includes(q))).slice(0, 8);
    if (!hits.length || document.activeElement !== $('#toSearch')) { box.classList.add('hidden'); return; }
    box.innerHTML = hits.map(c => `<button type="button" role="option" data-recipient="${esc(c.id)}"><b>${esc(c.name)}</b><span>${esc(c.email || 'no email')}${c.company ? ` · ${esc(c.company)}` : ''}</span></button>`).join('');
    box.classList.remove('hidden');
    box.querySelectorAll("[data-recipient]").forEach(b => {
      b.onmousedown = (e) => { e.preventDefault(); to.add(b.dataset.recipient); $('#toSearch').value = ''; box.classList.add('hidden'); paintTo(); syncButton(); };
    });
  };
  $('#toSearch').oninput = suggest;
  $('#toSearch').onfocus = suggest;
  $('#toSearch').onblur = () => setTimeout(() => $('#toSuggest').classList.add('hidden'), 120);
  $('#toSearch').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const first = $('#toSuggest [data-recipient]'); if (first) first.onmousedown(e); }
  };

  /* works for the PDF */
  const order = [...state.artworks].sort((a, b) => (works.has(b.id) - works.has(a.id))
    || ((b.status === 'for_sale') - (a.status === 'for_sale')) || a.artist.localeCompare(b.artist));
  const paintWorks = () => {
    const q = $('#workSearch').value.trim().toLowerCase();
    const list = order.filter(w => !q || `${w.title} ${w.artist} ${w.inventoryNumber}`.toLowerCase().includes(q)).slice(0, 120);
    $('#workList').innerHTML = list.map(w => `<label class="send-work ${works.has(w.id) ? 'on' : ''}">
        <input type="checkbox" data-work="${esc(w.id)}"${works.has(w.id) ? ' checked' : ''}>
        ${thumb(w)}
        <span class="grow"><b>${esc(w.title)}</b><span>${esc(w.artist)}${w.year ? `, ${w.year}` : ''}</span></span>
        <span class="send-st ${w.status}"><i class="dot ${w.status}"></i>${w.status === 'for_sale' && w.askingPrice != null ? esc(money(w.askingPrice, w.currency)) : esc(STATUS_LABEL[w.status])}</span>
      </label>`).join('') || '<div class="send-none">No works match.</div>';
    $('#workList').querySelectorAll('[data-work]').forEach(cb => {
      cb.onchange = () => {
        if (cb.checked) works.add(cb.dataset.work); else works.delete(cb.dataset.work);
        cb.closest('.send-work').classList.toggle('on', cb.checked);
        $('#workCount').textContent = works.size ? `— ${plural(works.size, 'work')} chosen` : '';
        prefill(); syncButton();
      };
    });
    $('#workCount').textContent = works.size ? `— ${plural(works.size, 'work')} chosen` : '';
  };
  $('#workSearch').oninput = paintWorks;

  const previewHref = () => `/api/clients/send/preview.pdf?works=${[...works].map(encodeURIComponent).join(',')}`
    + `&prices=${$('#optPrices').checked ? 1 : 0}&status=${$('#optStatus').checked ? 1 : 0}`
    + `&title=${encodeURIComponent($('#sendSubject').value || 'Selected works')}${to.size ? `&client=${encodeURIComponent([...to][0])}` : ''}`;
  $('#previewPdf').onclick = (e) => {
    if (!works.size) { e.preventDefault(); return showErr('Choose at least one work to preview.'); }
    $('#previewPdf').href = previewHref();
  };

  /* words */
  function prefill() {
    const share = active.find(s => s.slug === $('#sendShare')?.value);
    if (!subjectTouched) {
      $('#sendSubject').value = kind === 'link'
        ? (share ? share.title : 'A private view')
        : (works.size === 1 ? state.artworks.find(w => works.has(w.id))?.title || 'A work for you' : `${works.size || 'Some'} works for you`);
    }
    if (!messageTouched) {
      $('#sendMessage').value = kind === 'link'
        ? `Dear {name},\n\nI've put together a private view of some works I think you'll like. The link is below.\n\nBest wishes,\n${from}`
        : `Dear {name},\n\nI'm sending you ${works.size === 1 ? 'a work' : 'some works'} I think you'll like. The details are in the attached PDF.\n\nBest wishes,\n${from}`;
    }
  }
  $('#sendSubject').oninput = () => { subjectTouched = true; };
  $('#sendMessage').oninput = () => { messageTouched = true; };
  if ($('#sendShare')) $('#sendShare').onchange = () => { prefill(); syncButton(); };

  const showErr = (m) => { $('#sendErr').textContent = m; $('#sendErr').classList.toggle('hidden', !m); };
  function syncKind() {
    kind = el.querySelector('input[name="sendKind"]:checked').value;
    $('#linkPane').hidden = kind !== 'link';
    $('#pdfPane').hidden = kind !== 'pdf';
    prefill(); syncButton();
  }
  function syncButton() {
    const reachable = [...to].filter(id => clients.find(c => c.id === id)?.email).length;
    const ready = reachable && (kind === 'pdf' ? works.size : active.length);
    $('#sendBtn').disabled = !ready;
    $('#sendBtn').textContent = reachable ? `Send to ${plural(reachable, 'client')}` : 'Send';
  }
  el.querySelectorAll('input[name="sendKind"]').forEach(r => { r.onchange = syncKind; });

  $('#sendForm').onsubmit = async (e) => {
    e.preventDefault();
    showErr('');
    const btn = $('#sendBtn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await api.post('/api/clients/send', {
        kind, clientIds: [...to],
        shareSlug: $('#sendShare')?.value, passcode: $('#sendPass')?.value || '',
        artworkIds: [...works], includePrices: $('#optPrices').checked, includeStatus: $('#optStatus').checked,
        subject: $('#sendSubject').value, message: $('#sendMessage').value
      });
      closeModal();
      toast(res.outbox ? `${res.message} Running locally: see the outbox.` : res.message);
      onSent?.(res);
    } catch (err) {
      showErr(err instanceof ApiError ? err.message : 'That didn’t send. Please try again.');
      syncButton();
    }
  };

  paintTo();
  paintWorks();
  syncKind();
}
