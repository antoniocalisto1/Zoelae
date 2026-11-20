// Create or edit a shared collection: which pieces, what a viewer may see, and the passcode.
import { $, esc, byline } from './format.js';
import { api, ApiError } from './api.js';
import { state } from './store.js';
import { openModal, closeModal, toast, copyToClipboard } from './ui.js';
import { SITE } from './brand.js';

const PASSCODE_WORDS = [
  'amber', 'atlas', 'basalt', 'cedar', 'cobalt', 'copper', 'crimson', 'delta', 'ember', 'fresco',
  'gallery', 'granite', 'harbour', 'indigo', 'ivory', 'lantern', 'linen', 'marble', 'meadow', 'mosaic',
  'onyx', 'opal', 'pigment', 'quartz', 'russet', 'sable', 'saffron', 'sienna', 'slate', 'studio',
  'terra', 'umber', 'vault', 'velvet', 'walnut', 'willow'
];

/** crypto.getRandomValues, never Math.random — the same rule the server follows. */
function generatePasscode() {
  const bytes = new Uint32Array(3);
  crypto.getRandomValues(bytes);
  const a = PASSCODE_WORDS[bytes[0] % PASSCODE_WORDS.length];
  let b = PASSCODE_WORDS[bytes[1] % PASSCODE_WORDS.length];
  if (b === a) b = PASSCODE_WORDS[(bytes[1] + 1) % PASSCODE_WORDS.length];
  return `${a}-${b}-${1000 + (bytes[2] % 9000)}`;
}

const TOGGLES = [
  { key: 'showPrices', title: 'Prices & valuations', desc: 'Purchase price, current valuation and insured value.' },
  { key: 'showDocuments', title: 'Certificates & documents', desc: 'Certificates of authenticity, appraisals, invoices and condition reports.' },
  { key: 'showProvenance', title: 'Provenance & ownership history', desc: 'Prior owners, exhibition history and acquisition details.' },
  { key: 'showLocation', title: 'Storage location', desc: 'Where the piece physically is.' }
];

/** Plain-language summary of exactly what the toggles add up to, updated as they change. */
function summarise(flags) {
  const always = 'photos, titles, artists, years, mediums and dimensions';
  const on = [];
  const off = [];
  const label = { showPrices: 'prices', showDocuments: 'documents', showProvenance: 'provenance', showLocation: 'location' };
  for (const { key } of TOGGLES) (flags[key] ? on : off).push(label[key]);

  const list = (arr) => arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} or ${arr[arr.length - 1]}`;
  const seen = `Viewers will see ${always}${on.length ? `, plus ${list(on).replace(' or ', ' and ')}` : ''}.`;
  const unseen = off.length ? ` They will not see ${list(off)}.` : ' Every optional field is switched on.';
  return seen + unseen;
}

export function openShareModal(artworkIds, { onSaved } = {}) {
  // Keep the collector's chosen order, and hold it in a local array so it can be reordered.
  let items = artworkIds
    .map(id => state.artworks.find(w => w.id === id))
    .filter(Boolean);

  const flags = { showPrices: false, showDocuments: false, showProvenance: false, showLocation: false, allowDownloads: false };

  const modal = openModal(`
    <div class="modal-head">
      <h3>Create a shared link</h3>
      <button class="x" data-close>×</button>
    </div>
    <form id="shareForm"><div class="modal-body">
      <div class="field">
        <label for="sTitle">Title</label>
        <input class="input" id="sTitle" placeholder="For Sotheby’s — Spring Review">
      </div>
      <div class="field">
        <label for="sIntro">Intro message <span class="opt">— optional</span></label>
        <textarea class="input" id="sIntro" rows="2" placeholder="A short note shown at the top of the page."></textarea>
      </div>

      <div class="section">
        <h4>Pieces in this collection (<span id="sCount">${items.length}</span>)</h4>
        <div class="inner"><div class="orderlist" id="sItems"></div></div>
      </div>

      <div class="section">
        <h4>What can viewers see?</h4>
        <div class="inner">
          ${TOGGLES.map(t => toggleRow(t)).join('')}
          <div class="summary-note" id="sSummary"></div>
        </div>
      </div>

      <div class="section">
        <h4>Downloads</h4>
        <div class="inner">
          ${toggleRow({ key: 'allowDownloads', title: 'Allow viewers to download images', desc: 'Off means images are streamed through a protected route and cannot be saved from the page.' })}
        </div>
      </div>

      <div class="field">
        <label for="sPasscode">Passcode</label>
        <div class="passrow">
          <input class="input mono" id="sPasscode" type="text" autocomplete="off" placeholder="at least 6 characters">
          <button class="btn" type="button" id="sGenerate">Generate</button>
          <button class="btn" type="button" id="sCopyPass">Copy</button>
        </div>
        <div class="hint">Shown in plain text so you can read it out. Send it to the viewer separately from the link.</div>
      </div>

      <div class="row2">
        <div class="field">
          <label for="sExpiry">Link expires</label>
          <select class="select" id="sExpiry">
            <option value="never">Never</option>
            <option value="24h">In 24 hours</option>
            <option value="7d">In 7 days</option>
            <option value="30d">In 30 days</option>
            <option value="custom">On a specific date…</option>
          </select>
          <input class="input hidden" id="sExpiryDate" type="date" style="margin-top:8px">
        </div>
        <div class="field">
          <label for="sMaxViews">View limit <span class="opt">— optional</span></label>
          <input class="input" id="sMaxViews" type="number" min="1" step="1" placeholder="Unlimited">
          <div class="hint">Counts one view per successful passcode entry.</div>
        </div>
      </div>

      <div class="err hidden" id="sErr"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn btn-primary" type="submit">Create shared link</button>
    </div></form>`, { size: 'lg' });

  const summaryEl = modal.querySelector('#sSummary');
  const paintSummary = () => { summaryEl.textContent = summarise(flags); };

  modal.querySelectorAll('.switch').forEach(sw => {
    sw.onclick = () => {
      const key = sw.dataset.key;
      flags[key] = !flags[key];
      sw.setAttribute('aria-checked', String(flags[key]));
      paintSummary();
    };
  });
  paintSummary();

  const paintItems = () => {
    modal.querySelector('#sCount').textContent = String(items.length);
    modal.querySelector('#sItems').innerHTML = items.map((w, i) => `
      <div class="orderitem">
        ${w.images.length ? `<img src="${esc(w.images[0].thumbUrl || w.images[0].url)}" alt="">` : '<span class="mini placeholder" style="width:44px;height:36px"></span>'}
        <span class="grow">
          <span class="oi-t">${esc(w.title)}</span>
          <span class="oi-a">${esc(byline(w.artist, w.year))}</span>
        </span>
        <button type="button" class="move" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button type="button" class="move" data-down="${i}" ${i === items.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button type="button" class="move" data-remove="${i}" title="Remove">×</button>
      </div>`).join('') || '<p style="color:var(--muted);margin:0">No pieces selected.</p>';

    modal.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { swap(Number(b.dataset.up), -1); });
    modal.querySelectorAll('[data-down]').forEach(b => b.onclick = () => { swap(Number(b.dataset.down), 1); });
    modal.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => {
      items.splice(Number(b.dataset.remove), 1);
      paintItems();
    });
  };
  const swap = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    [items[index], items[target]] = [items[target], items[index]];
    paintItems();
  };
  paintItems();

  const passInput = modal.querySelector('#sPasscode');
  modal.querySelector('#sGenerate').onclick = () => { passInput.value = generatePasscode(); };
  modal.querySelector('#sCopyPass').onclick = async () => {
    if (!passInput.value) return;
    toast(await copyToClipboard(passInput.value) ? 'Passcode copied.' : 'Could not copy — select it manually.');
  };

  const expiry = modal.querySelector('#sExpiry');
  expiry.onchange = () => modal.querySelector('#sExpiryDate').classList.toggle('hidden', expiry.value !== 'custom');

  modal.querySelector('#shareForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const showError = (msg) => {
      const el = modal.querySelector('#sErr');
      el.textContent = msg;
      el.classList.remove('hidden');
    };

    const title = modal.querySelector('#sTitle').value.trim();
    if (!title) return showError('Please give the shared collection a title.');
    if (!items.length) return showError('Choose at least one piece to share.');
    if (passInput.value.length < 6) return showError('The passcode needs at least 6 characters.');

    try {
      const res = await api.post('/api/shares', {
        title,
        introMessage: modal.querySelector('#sIntro').value.trim(),
        artworkIds: items.map(w => w.id),
        passcode: passInput.value,
        ...flags,
        expiresPreset: expiry.value,
        expiresAt: modal.querySelector('#sExpiryDate').value || null,
        maxViews: modal.querySelector('#sMaxViews').value || null
      });
      showConfirmation(res.shareUrl, passInput.value);
      onSaved?.(res.share);
    } catch (err) {
      showError(err instanceof ApiError ? err.message : 'Could not create that link.');
    }
  };
}

function showConfirmation(shareUrl, passcode) {
  const modal = openModal(`
    <div class="modal-head"><h3>Your shared link is ready</h3><button class="x" data-close>×</button></div>
    <div class="modal-body">
      <div class="field">
        <label>Share URL</label>
        <div class="urlbox"><span class="u mono" id="cUrl">${esc(shareUrl)}</span>
          <button class="btn btn-sm" id="cCopyUrl">Copy</button></div>
      </div>
      <div class="field">
        <label>Passcode</label>
        <div class="urlbox"><span class="u mono">${esc(passcode)}</span>
          <button class="btn btn-sm" id="cCopyPass">Copy</button></div>
        <div class="hint">Send this through a different channel than the link — a call or a text, not the same email.</div>
      </div>
      <div class="warn-note">
        <b>The passcode can't be recovered later.</b> ${esc(SITE)} stores only a hash of it, so if you forget it
        you can replace it from the Shared links page, but nobody — including us — can read it back.
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-primary" data-close>Done</button></div>`, { size: 'sm' });

  modal.querySelector('#cCopyUrl').onclick = async () =>
    toast(await copyToClipboard(shareUrl) ? 'Link copied.' : 'Could not copy — select it manually.');
  modal.querySelector('#cCopyPass').onclick = async () =>
    toast(await copyToClipboard(passcode) ? 'Passcode copied.' : 'Could not copy — select it manually.');
}

const toggleRow = ({ key, title, desc }) => `
  <div class="toggle-row">
    <button type="button" class="switch" role="switch" aria-checked="false" data-key="${key}" aria-label="${esc(title)}"></button>
    <div><div class="tt">${esc(title)}</div><div class="td">${esc(desc)}</div></div>
  </div>`;

export { generatePasscode, summarise, toggleRow, TOGGLES, showConfirmation };
