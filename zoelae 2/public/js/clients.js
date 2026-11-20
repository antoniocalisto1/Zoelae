// "Clients": the people a gallery or an artist sells to. Private to the account; viewers never see it.
import { $, esc, money, shortDate, dateTimeLabel } from './format.js';
import { api, ApiError } from './api.js';
import { state, loadClients } from './store.js';
import { openModal, closeModal, toast, confirmDialog } from './ui.js';
import { openSendModal } from './sendModal.js';
import { openImport } from './importer.js';

let query = '';
const picked = new Set();
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export async function renderClients() {
  $('#main').innerHTML = `<section><div class="page-head"><div><h1>Clients</h1><p>Loading…</p></div></div></section>`;
  let clients;
  try { clients = await loadClients(true); }
  catch (err) { $('#main').innerHTML = `<div class="empty"><h3>Couldn’t load your clients</h3><p>${esc(err.message)}</p></div>`; return; }
  paint(clients);
}

function paint(clients) {
  const q = query.trim().toLowerCase();
  const list = clients.filter(c => !q || [c.name, c.email, c.company, c.city, c.country, c.interests, c.notes].join(' ').toLowerCase().includes(q));
  for (const id of [...picked]) if (!clients.some(c => c.id === id)) picked.delete(id);

  $('#main').innerHTML = `
    <section class="clients">
      <div class="page-head">
        <div>
          <h1>Clients</h1>
          <p>${clients.length ? `${plural(clients.length, 'person', 'people')} you sell to, and what you've sent them. Only you can see this list.` : ''}</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-sm" id="importClients">⇪ Import from a spreadsheet</button>
          <button class="btn btn-sm" id="sendWorksBtn"${clients.length ? '' : ' disabled'}>✉ Send works</button>
          <button class="btn btn-primary btn-sm" id="addClient">＋ Add a client</button>
        </div>
      </div>
      ${clients.length ? `
        <div class="toolbar clients-bar">
          <div class="search-in"><input class="input" id="clientSearch" type="search" placeholder="Search name, email, city, interests…" value="${esc(query)}"></div>
          <span class="lbl">${list.length === clients.length ? plural(clients.length, 'client') : `${list.length} of ${clients.length}`}</span>
        </div>
        ${list.length ? table(list) : `<div class="empty"><h3>Nobody matches</h3><p>Try another name, or clear the search.</p></div>`}
      ` : empty()}
    </section>
    ${picked.size ? `<div class="selectbar" id="clientBar"><span class="n">${plural(picked.size, 'client')} chosen</span>
      <button class="btn btn-sm" data-clear>Clear</button>
      <button class="btn btn-sm btn-primary" data-send>Send works to ${picked.size === 1 ? 'them' : 'them all'}</button></div>` : ''}`;

  $('#addClient').onclick = () => openClientForm(null);
  $('#importClients').onclick = () => openImport({ kind: 'clients', onFinished: () => renderClients() });
  $('#sendWorksBtn').onclick = () => openSendModal({ clientIds: [...picked], onSent: () => renderClients() });
  const search = $('#clientSearch');
  if (search) {
    search.oninput = () => { query = search.value; paint(clients); const s = $('#clientSearch'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); };
  }
  $('#main').querySelectorAll('[data-empty-add]').forEach(b => { b.onclick = () => openClientForm(null); });
  $('#main').querySelectorAll('[data-empty-import]').forEach(b => { b.onclick = () => $('#importClients').click(); });
  $('#main').querySelectorAll('tr[data-id]').forEach(tr => {
    tr.onclick = (e) => {
      if (e.target.closest('input,a,button,label')) return;
      openClient(tr.dataset.id);
    };
  });
  $('#main').querySelectorAll('[data-pick]').forEach(cb => {
    cb.onchange = () => { if (cb.checked) picked.add(cb.dataset.pick); else picked.delete(cb.dataset.pick); paint(clients); };
  });
  const all = $('#pickAll');
  if (all) all.onchange = () => { list.forEach(c => (all.checked ? picked.add(c.id) : picked.delete(c.id))); paint(clients); };
  const bar = $('#clientBar');
  if (bar) {
    bar.querySelector('[data-clear]').onclick = () => { picked.clear(); paint(clients); };
    bar.querySelector('[data-send]').onclick = () => openSendModal({ clientIds: [...picked], onSent: () => { picked.clear(); renderClients(); } });
  }
}

function table(list) {
  const allOn = list.length && list.every(c => picked.has(c.id));
  return `<div class="table-wrap"><table class="client-table">
    <thead><tr>
      <th style="width:38px"><input type="checkbox" id="pickAll" aria-label="Choose everyone shown"${allOn ? ' checked' : ''}></th>
      <th>Name</th><th>Email</th><th class="hide-sm">Where</th><th class="hide-sm">Interests</th><th class="hide-sm">Last sent</th><th class="num hide-sm">Bought</th>
    </tr></thead><tbody>
    ${list.map(c => `<tr data-id="${esc(c.id)}">
      <td><input type="checkbox" data-pick="${esc(c.id)}" aria-label="Choose ${esc(c.name)}"${picked.has(c.id) ? ' checked' : ''}></td>
      <td><span class="tname">${esc(c.name)}</span>${c.company ? `<span class="sub">${esc(c.company)}</span>` : ''}</td>
      <td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '<span class="muted">—</span>'}</td>
      <td class="hide-sm">${esc([c.city, c.country].filter(Boolean).join(', ')) || '<span class="muted">—</span>'}</td>
      <td class="hide-sm interests">${esc(c.interests) || '<span class="muted">—</span>'}</td>
      <td class="hide-sm">${c.lastContactedAt ? shortDate(c.lastContactedAt) : '<span class="muted">Never</span>'}</td>
      <td class="num hide-sm">${c.worksBought || '<span class="muted">—</span>'}</td>
    </tr>`).join('')}
    </tbody></table></div>`;
}

const empty = () => `<div class="empty">
  <h3>Your client list is empty</h3>
  <p>Keep the people you sell to here: what they collect, what they've bought, and every link and PDF you've sent them.</p>
  <div class="empty-actions">
    <button class="btn btn-primary pill" data-empty-add>＋ Add a client</button>
    <button class="btn pill" data-empty-import>Import a spreadsheet</button>
  </div>
  <span class="pv-note" aria-hidden="true">only you see this list</span>
</div>`;

/* ---------- one client ---------- */

async function openClient(id) {
  let data;
  try { data = await api.get(`/api/clients/${id}`); }
  catch { return toast('Couldn’t open that client.'); }
  const c = data.client;
  const facts = [
    ['Email', c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'],
    ['Phone', c.phone ? `<a href="tel:${esc(c.phone.replace(/\s/g, ''))}">${esc(c.phone)}</a>` : '—'],
    ['Company', esc(c.company) || '—'],
    ['Where', esc([c.city, c.country].filter(Boolean).join(', ')) || '—'],
    ['On your list since', shortDate(c.createdAt)]
  ];
  const el = openModal(`
    <div class="modal-head"><h3>${esc(c.name)}</h3><button class="x" data-close aria-label="Close">×</button></div>
    <div class="modal-body client-card">
      <div class="dl">${facts.map(([k, v]) => `<div class="r"><span>${k}</span><b>${v}</b></div>`).join('')}</div>
      ${c.interests ? `<div class="notes"><div class="k">Interests</div><p>${esc(c.interests)}</p></div>` : ''}
      ${c.notes ? `<div class="notes"><div class="k">Notes</div><p>${esc(c.notes)}</p></div>` : ''}

      <h4 class="client-h">Sent</h4>
      ${data.messages.length ? `<ul class="client-log">${data.messages.map(m => `<li>
          <span class="kind ${m.kind}">${m.kind === 'pdf' ? 'PDF' : 'Link'}</span>
          <span class="grow"><b>${esc(m.subject)}</b><span>${m.kind === 'pdf' ? plural(m.artworkCount, 'work') : m.share ? esc(m.share.title) : 'a link since deleted'}${m.delivery === 'failed' ? ' · <em class="bad">not delivered</em>' : ''}</span></span>
          <span class="when">${dateTimeLabel(m.createdAt)}</span></li>`).join('')}</ul>`
        : '<p class="muted">Nothing yet.</p>'}

      <h4 class="client-h">Bought</h4>
      ${data.bought.length ? `<ul class="client-log">${data.bought.map(a => `<li>
          <i class="dot sold"></i>
          <span class="grow"><b>${esc(a.title)}</b><span>${esc(a.artist)}${a.year ? `, ${a.year}` : ''}</span></span>
          <span class="when">${a.soldPrice != null ? esc(money(a.soldPrice, a.currency)) : ''}${a.soldAt ? ` · ${shortDate(a.soldAt)}` : ''}</span></li>`).join('')}</ul>`
        : '<p class="muted">Nothing recorded. Mark a work as sold and choose them as the buyer.</p>'}
    </div>
    <div class="modal-foot">
      <button class="btn btn-danger" type="button" id="delClient">Remove</button>
      <span class="spacer"></span>
      <button class="btn" type="button" id="editClient">Edit</button>
      <button class="btn btn-primary" type="button" id="clientSend"${c.email ? '' : ' disabled title="Add an email address first"'}>Send works</button>
    </div>`, { size: 'sm' });

  el.querySelector('#editClient').onclick = () => openClientForm(c);
  el.querySelector('#clientSend').onclick = () => openSendModal({ clientIds: [c.id], onSent: () => renderClients() });
  el.querySelector('#delClient').onclick = async () => {
    const ok = await confirmDialog({
      title: `Remove ${esc(c.name)}?`,
      message: 'They come off your client list, with the record of what you sent them. Works they bought stay sold.',
      confirmLabel: 'Remove', danger: true
    });
    if (!ok) return;
    await api.del(`/api/clients/${c.id}`);
    toast(`${c.name} removed.`);
    renderClients();
  };
}

/* ---------- add or edit ---------- */

export function openClientForm(existing, { onSaved } = {}) {
  const c = existing || {};
  const v = (k) => esc(c[k] || '');
  const el = openModal(`
    <div class="modal-head"><h3>${existing ? 'Edit client' : 'Add a client'}</h3><button class="x" data-close aria-label="Close">×</button></div>
    <form id="clientForm"><div class="modal-body">
      <div class="field"><label for="cName">Name</label><input class="input" id="cName" value="${v('name')}" maxlength="200" autocomplete="off" required></div>
      <div class="row2">
        <div class="field"><label for="cEmail">Email <span class="opt">— to send them works</span></label><input class="input" id="cEmail" type="email" value="${v('email')}" autocomplete="off"></div>
        <div class="field"><label for="cPhone">Phone <span class="opt">— optional</span></label><input class="input" id="cPhone" value="${v('phone')}" autocomplete="off"></div>
      </div>
      <div class="field"><label for="cCompany">Company or institution <span class="opt">— optional</span></label><input class="input" id="cCompany" value="${v('company')}"></div>
      <div class="row2">
        <div class="field"><label for="cCity">City <span class="opt">— optional</span></label><input class="input" id="cCity" value="${v('city')}"></div>
        <div class="field"><label for="cCountry">Country <span class="opt">— optional</span></label><input class="input" id="cCountry" value="${v('country')}"></div>
      </div>
      <div class="field"><label for="cInterests">Interests <span class="opt">— what they collect, budget, artists they follow</span></label><input class="input" id="cInterests" value="${v('interests')}"></div>
      <div class="field"><label for="cNotes">Notes <span class="opt">— optional</span></label><textarea class="input" id="cNotes" rows="3">${v('notes')}</textarea></div>
      <div class="err hidden" id="clientErr" role="alert"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn btn-primary" type="submit">${existing ? 'Save' : 'Add to your list'}</button>
    </div></form>`, { size: 'sm' });
  el.querySelector('#cName').focus();
  el.querySelector('#clientForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      name: el.querySelector('#cName').value, email: el.querySelector('#cEmail').value, phone: el.querySelector('#cPhone').value,
      company: el.querySelector('#cCompany').value, city: el.querySelector('#cCity').value, country: el.querySelector('#cCountry').value,
      interests: el.querySelector('#cInterests').value, notes: el.querySelector('#cNotes').value
    };
    try {
      const res = existing ? await api.patch(`/api/clients/${existing.id}`, body) : await api.post('/api/clients', body);
      state.clients = null;
      closeModal();
      toast(existing ? 'Saved.' : `${res.client.name} added.`);
      if (onSaved) onSaved(res.client); else if (state.view === 'clients') renderClients();
    } catch (err) {
      const box = el.querySelector('#clientErr');
      box.textContent = err instanceof ApiError ? err.message : 'Couldn’t save. Please try again.';
      box.classList.remove('hidden');
    }
  };
}
