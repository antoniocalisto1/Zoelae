// "Shared links" — every collection this collector has shared, and what has happened to it.
import { $, esc, byline, shortDate, dateTimeLabel, STATUS_LABEL } from './format.js';
import { api, ApiError } from './api.js';
import { state, loadShares } from './store.js';
import { openModal, closeModal, toast, confirmDialog, copyToClipboard } from './ui.js';
import { summarise, toggleRow, TOGGLES, generatePasscode } from './shareModal.js';
import { SITE } from './brand.js';

let hooks = {};

const shareUrl = (slug) => `${location.origin}/s/${slug}`;

export function renderSharedLinks(h) {
  hooks = h;
  const shares = state.shares;

  $('#main').innerHTML = `
    <section>
      <div class="page-head">
        <div>
          <h1>Shared links</h1>
          <p>${shares.length ? 'Every collection you have shared, and what has happened to it since.' : ''}</p>
        </div>
        <button class="btn btn-primary btn-sm" id="newShareBtn">＋ New shared link</button>
      </div>
      ${shares.length ? tableHtml(shares) : emptyHtml()}
    </section>`;

  $('#newShareBtn').onclick = () => hooks.startSelection();
  const startBtn = $('#main [data-start]');
  if (startBtn) startBtn.onclick = () => hooks.startSelection();
  bindRows();
}

const emptyHtml = () => `<div class="empty">
  <h3>No shared links yet</h3>
  <p>Pick pieces from your collection, decide what a viewer may see, and set a passcode. Nobody sees anything until you do.</p>
  <button class="btn btn-primary pill" data-start>Choose pieces to share</button>
  <span class="pv-note" aria-hidden="true">prices can stay hidden</span>
</div>`;

function tableHtml(shares) {
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Title</th><th>Pieces</th><th class="hide-sm">Created</th><th class="hide-sm">Expires</th>
      <th>Views</th><th>Status</th><th></th>
    </tr></thead><tbody>
    ${shares.map(s => `<tr data-slug="${esc(s.slug)}" style="cursor:default">
      <td class="tname">${esc(s.title)}</td>
      <td>${s.itemCount}</td>
      <td class="hide-sm">${shortDate(s.createdAt)}</td>
      <td class="hide-sm">${s.expiresAt ? shortDate(s.expiresAt) : 'Never'}</td>
      <td>${s.viewCount}${s.maxViews ? ` / ${s.maxViews}` : ''}</td>
      <td><span class="status ${s.status}">${STATUS_LABEL[s.status]}</span></td>
      <td>
        <div class="rowactions">
          <button class="btn btn-sm" data-copy>Copy link</button>
          ${s.status === 'active' && ['gallery', 'artist'].includes(state.user?.accountType) ? '<button class="btn btn-sm" data-send>Send to a client</button>' : ''}
          <button class="btn btn-sm" data-edit>Edit</button>
          <button class="btn btn-sm" data-passcode>Change passcode</button>
          ${s.revokedAt ? '' : '<button class="btn btn-sm btn-danger" data-revoke>Revoke</button>'}
          <button class="btn btn-sm" data-log>Access log</button>
          <button class="btn btn-sm btn-danger" data-delete>Delete</button>
        </div>
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function bindRows() {
  document.querySelectorAll('#main tbody tr').forEach(row => {
    const slug = row.dataset.slug;
    const share = state.shares.find(s => s.slug === slug);
    const on = (attr, fn) => {
      const btn = row.querySelector(`[data-${attr}]`);
      if (btn) btn.onclick = fn;
    };

    on('send', () => hooks.sendLink?.(slug));
    on('copy', async () =>
      toast(await copyToClipboard(shareUrl(slug)) ? 'Link copied.' : 'Could not copy — select it manually.'));
    on('edit', () => openEditModal(slug));
    on('passcode', () => openPasscodeModal(share));
    on('log', () => openAccessLog(share));

    on('revoke', async () => {
      const ok = await confirmDialog({
        title: 'Revoke this link?',
        message: `“${esc(share.title)}” will stop working immediately, including for anyone who has already entered the passcode.`,
        confirmLabel: 'Revoke', danger: true
      });
      if (!ok) return;
      await api.post(`/api/shares/${slug}/revoke`);
      await refresh('Link revoked.');
    });

    on('delete', async () => {
      const ok = await confirmDialog({
        title: 'Delete this shared link?',
        message: 'The link, its item list and its access log will be deleted. Your artworks are not affected.',
        confirmLabel: 'Delete', danger: true
      });
      if (!ok) return;
      await api.del(`/api/shares/${slug}`);
      await refresh('Shared link deleted.');
    });
  });
}

async function refresh(message) {
  await loadShares();
  renderSharedLinks(hooks);
  if (message) toast(message);
}

async function openEditModal(slug) {
  let data;
  try {
    data = await api.get(`/api/shares/${slug}`);
  } catch {
    return toast('Could not load that link.');
  }
  const share = data.share;
  let items = data.items.slice();
  const flags = {
    showPrices: share.showPrices, showDocuments: share.showDocuments,
    showProvenance: share.showProvenance, showLocation: share.showLocation,
    allowDownloads: share.allowDownloads
  };

  const modal = openModal(`
    <div class="modal-head"><h3>Edit shared link</h3><button class="x" data-close>×</button></div>
    <form id="editForm"><div class="modal-body">
      <div class="field">
        <label for="eTitle">Title</label>
        <input class="input" id="eTitle" value="${esc(share.title)}">
      </div>
      <div class="field">
        <label for="eIntro">Intro message <span class="opt">— optional</span></label>
        <textarea class="input" id="eIntro" rows="2">${esc(share.introMessage)}</textarea>
      </div>

      <div class="section">
        <h4>Pieces in this collection (<span id="eCount">${items.length}</span>)</h4>
        <div class="inner"><div class="orderlist" id="eItems"></div></div>
      </div>

      <div class="section">
        <h4>What can viewers see?</h4>
        <div class="inner">
          ${TOGGLES.map(t => toggleRow(t)).join('')}
          <div class="summary-note" id="eSummary"></div>
        </div>
      </div>

      <div class="section">
        <h4>Downloads</h4>
        <div class="inner">${toggleRow({ key: 'allowDownloads', title: 'Allow viewers to download images', desc: 'Off means images cannot be saved from the page.' })}</div>
      </div>

      <div class="row2">
        <div class="field">
          <label for="eExpiry">Link expires</label>
          <select class="select" id="eExpiry">
            <option value="keep">Leave as is (${share.expiresAt ? shortDate(share.expiresAt) : 'never'})</option>
            <option value="never">Never</option>
            <option value="24h">In 24 hours</option>
            <option value="7d">In 7 days</option>
            <option value="30d">In 30 days</option>
            <option value="custom">On a specific date…</option>
          </select>
          <input class="input hidden" id="eExpiryDate" type="date" style="margin-top:8px">
        </div>
        <div class="field">
          <label for="eMaxViews">View limit <span class="opt">— optional</span></label>
          <input class="input" id="eMaxViews" type="number" min="1" step="1" value="${share.maxViews ?? ''}" placeholder="Unlimited">
          <div class="hint">${share.viewCount} view${share.viewCount === 1 ? '' : 's'} so far.</div>
        </div>
      </div>
      <div class="err hidden" id="eErr"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn btn-primary" type="submit">Save changes</button>
    </div></form>`, { size: 'lg' });

  modal.querySelectorAll('.switch').forEach(sw => {
    const key = sw.dataset.key;
    sw.setAttribute('aria-checked', String(!!flags[key]));
    sw.onclick = () => {
      flags[key] = !flags[key];
      sw.setAttribute('aria-checked', String(flags[key]));
      modal.querySelector('#eSummary').textContent = summarise(flags);
    };
  });
  modal.querySelector('#eSummary').textContent = summarise(flags);

  const paintItems = () => {
    modal.querySelector('#eCount').textContent = String(items.length);
    modal.querySelector('#eItems').innerHTML = items.map((item, i) => `
      <div class="orderitem">
        <img src="${esc(item.thumbUrl || '')}" alt="">
        <span class="grow">
          <span class="oi-t">${esc(item.title)}</span>
          <span class="oi-a">${esc(byline(item.artist, item.year))}</span>
        </span>
        <button type="button" class="move" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="move" data-down="${i}" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="move" data-remove="${i}">×</button>
      </div>`).join('') || '<p style="color:var(--muted);margin:0">No pieces left — add some or delete the link.</p>';

    modal.querySelectorAll('[data-up]').forEach(b => b.onclick = () => move(Number(b.dataset.up), -1));
    modal.querySelectorAll('[data-down]').forEach(b => b.onclick = () => move(Number(b.dataset.down), 1));
    modal.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => {
      items.splice(Number(b.dataset.remove), 1); paintItems();
    });
  };
  const move = (i, delta) => {
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    paintItems();
  };
  paintItems();

  const expiry = modal.querySelector('#eExpiry');
  expiry.onchange = () => modal.querySelector('#eExpiryDate').classList.toggle('hidden', expiry.value !== 'custom');

  modal.querySelector('#editForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const err = modal.querySelector('#eErr');
    try {
      const body = {
        title: modal.querySelector('#eTitle').value.trim(),
        introMessage: modal.querySelector('#eIntro').value.trim(),
        artworkIds: items.map(i => i.artworkId),
        ...flags,
        maxViews: modal.querySelector('#eMaxViews').value || null
      };
      if (expiry.value !== 'keep') {
        body.expiresPreset = expiry.value;
        body.expiresAt = modal.querySelector('#eExpiryDate').value || null;
      }
      await api.patch(`/api/shares/${slug}`, body);
      closeModal();
      await refresh('Shared link updated.');
    } catch (e) {
      err.textContent = e instanceof ApiError ? e.message : 'Could not save those changes.';
      err.classList.remove('hidden');
    }
  };
}

function openPasscodeModal(share) {
  const modal = openModal(`
    <div class="modal-head"><h3>Change passcode</h3><button class="x" data-close>×</button></div>
    <form id="pcForm"><div class="modal-body">
      <p style="margin:0 0 14px;color:var(--muted)">Replacing the passcode for “${esc(share.title)}”.
        Anyone who has already entered the old one keeps access until their two-hour session runs out.</p>
      <div class="field">
        <label for="pcInput">New passcode</label>
        <div class="passrow">
          <input class="input mono" id="pcInput" type="text" autocomplete="off" placeholder="at least 6 characters">
          <button class="btn" type="button" id="pcGen">Generate</button>
          <button class="btn" type="button" id="pcCopy">Copy</button>
        </div>
        <div class="hint">The old passcode cannot be recovered — only replaced.</div>
      </div>
      <div class="err hidden" id="pcErr"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn btn-primary" type="submit">Set new passcode</button>
    </div></form>`, { size: 'sm' });

  const input = modal.querySelector('#pcInput');
  modal.querySelector('#pcGen').onclick = () => { input.value = generatePasscode(); };
  modal.querySelector('#pcCopy').onclick = async () => {
    if (input.value) toast(await copyToClipboard(input.value) ? 'Passcode copied.' : 'Could not copy.');
  };

  modal.querySelector('#pcForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const err = modal.querySelector('#pcErr');
    if (input.value.length < 6) {
      err.textContent = 'The passcode needs at least 6 characters.';
      return err.classList.remove('hidden');
    }
    try {
      await api.post(`/api/shares/${share.slug}/passcode`, { passcode: input.value });
      closeModal();
      toast('Passcode changed.');
    } catch (e) {
      err.textContent = e instanceof ApiError ? e.message : 'Could not change the passcode.';
      err.classList.remove('hidden');
    }
  };
}

async function openAccessLog(share) {
  let entries = [];
  try {
    entries = (await api.get(`/api/shares/${share.slug}/access-log`)).entries;
  } catch {
    return toast('Could not load the access log.');
  }

  openModal(`
    <div class="modal-head"><h3>Access log — ${esc(share.title)}</h3><button class="x" data-close>×</button></div>
    <div class="modal-body" style="max-height:60vh;overflow:auto">
      <p style="margin:0 0 14px;color:var(--muted)">Every passcode attempt, successful or not.
        Visitors are identified by a salted hash. ${esc(SITE)} does not store IP addresses.</p>
      ${entries.length ? `<div class="table-wrap"><table class="logtable">
        <thead><tr><th>When</th><th>Visitor</th><th>Result</th><th class="hide-sm">Browser</th></tr></thead>
        <tbody>${entries.map(e => `<tr style="cursor:default">
          <td>${dateTimeLabel(e.accessedAt)}</td>
          <td class="mono">${esc(e.visitor)}</td>
          <td><span class="status ${e.success ? 'active' : 'revoked'}">${e.success ? 'Opened' : 'Refused'}</span></td>
          <td class="hide-sm" style="color:var(--muted)">${esc((e.userAgent || '').slice(0, 60))}</td>
        </tr>`).join('')}</tbody></table></div>`
      : '<p style="color:var(--muted);margin:0">Nobody has opened this link yet.</p>'}
    </div>
    <div class="modal-foot"><button class="btn btn-primary" data-close>Close</button></div>`, { size: 'lg' });
}
