// Boot, navigation and the wiring between the collector's screens.
import { $, $$, esc, initials } from './format.js';
import { api, ApiError } from './api.js';
import { state, loadArtworks, loadShares, loadSummary, resetFilters } from './store.js';
import { initAuth, showAuthScreen } from './auth.js';
import { SITE, ACCOUNT_TYPES, wordmark, setFavicon } from './brand.js';
import { renderWelcome } from './welcome.js';
import { renderCollection, teardownSelectBar } from './collection.js';
import { openDetail, closeDetail, refreshDetail, isDetailOpen } from './artworkDetail.js';
import { openArtworkForm } from './artworkForm.js';
import { openImport } from './importer.js';
import { openFolderUpload, openDescriber } from './folderUpload.js';
import { renderClients } from './clients.js';
import { openSendModal } from './sendModal.js';
import { openShareModal } from './shareModal.js';
import { renderSharedLinks } from './sharedLinks.js';
import { renderReports } from './reports.js';
import { toast, confirmDialog, openModal } from './ui.js';
import { resetFigures } from './motion.js';

async function refreshAll() {
  await Promise.all([loadArtworks(), loadShares(), loadSummary()]);
}

/** The detail is a layer over the collection, so opening one doesn't unmount
 *  the other — that is what the swipe-back gesture reveals underneath. */
function navigate(view, param, srcImg) {
  if (view === 'detail') {
    if (state.view !== 'collection') { state.view = 'collection'; render(); }
    return openDetail(param, srcImg, detailHooks);
  }
  if (isDetailOpen()) closeDetail(true);
  state.view = view;
  if (view !== 'collection') teardownSelectBar();
  render();
}

/** Galleries and artists sell, so they get a client list. Anyone can switch it on in settings. */
const sells = () => ['gallery', 'artist'].includes(state.user?.accountType);
function paintNav() {
  $('#navClients').classList.toggle('hidden', !sells());
}

const detailHooks = {
  sells,
  sendToClient: (artwork) => openSendModal({ artworkIds: [artwork.id] }),
  openForm: (artwork) => openArtworkForm(artwork, { onSaved: afterArtworkSaved }),
  openShareModal: (ids) => openShareModal(ids, { onSaved: afterShareSaved }),
  remove: removeArtwork,
  afterClose: () => { state.view = 'collection'; render(); }
};

function render() {
  $$('.nav button').forEach(b => {
    const on = b.dataset.nav === state.view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });

  if (isDetailOpen()) refreshDetail();

  if (state.view === 'welcome') return renderWelcome(onQuickAction);
  if (state.view === 'reports') return renderReports({ goToCollection: () => navigate('collection') });
  if (state.view === 'shared-links') return renderSharedLinks({ startSelection, sendLink: (slug) => openSendModal({ shareSlug: slug }) });
  if (state.view === 'clients') return renderClients();
  renderCollection({
    rerender: render,
    openDetail: (id, srcImg) => navigate('detail', id, srcImg),
    openForm: () => openArtworkForm(null, { onSaved: afterArtworkSaved }),
    openImport: () => openImport({ kind: 'artworks', onFinished: afterImport }),
    openFolder: () => openFolderUpload({ onFinished: afterImport, onDescribe: describe }),
    describe: (ids) => describe(ids),
    openShareModal: (ids) => openShareModal(ids, { onSaved: afterShareSaved })
  });
}

async function afterImport() {
  await refreshAll();
  if (state.view === 'collection' || state.view === 'welcome') { state.view = 'collection'; render(); }
}

/** Step through works that came in as bare photographs, filling in each one's details. */
function describe(ids) {
  return openDescriber({ ids, onChanged: afterImport });
}

function onQuickAction(action) {
  if (action === 'add') return openArtworkForm(null, { onSaved: afterArtworkSaved });
  if (action === 'folder') return openFolderUpload({ onFinished: afterImport, onDescribe: describe });
  if (action === 'import') return openImport({ kind: 'artworks', onFinished: afterImport });
  if (action === 'collection') return navigate('collection');
  if (action === 'share') return startSelection();
  if (action === 'reports') return navigate('reports');
}

/** "Create a shared link" from anywhere drops the collector into selection mode on the grid. */
function startSelection() {
  resetFilters();
  state.selecting = true;
  navigate('collection');
  toast('Pick the pieces you want to share.');
}

async function afterArtworkSaved(_artwork, opts = {}) {
  await refreshAll();
  if (!opts.silent) render();
}

async function afterShareSaved() {
  await Promise.all([loadShares(), loadSummary()]);
  state.selecting = false;
  state.selected.clear();
}

async function removeArtwork(artwork) {
  const ok = await confirmDialog({
    title: 'Remove this work?',
    message: `“${artwork.title}” will be removed from your collection, along with its images and documents.`,
    confirmLabel: 'Remove', danger: true
  });
  if (!ok) return;
  await api.del(`/api/artworks/${artwork.id}`);
  await refreshAll();
  state.view = 'collection';
  render();
  closeDetail();
  toast(`Removed “${artwork.title}”.`);
}

async function enterApp({ notice } = {}) {
  document.title = `${SITE} — your collection`;
  $('#authScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  paintUser();
  state.clients = null;
  paintNav();
  resetFilters();
  resetFigures();
  await refreshAll();
  // A brand-new, empty account starts on the collection, where the first step is waiting.
  navigate(state.artworks.length ? 'welcome' : 'collection');
  window.scrollTo(0, 0);
  if (notice) toast(notice);
}

function paintBranding() {
  $('#appBrand').innerHTML = wordmark();
  setFavicon();
}

/** The person at the foot of the side menu: initials, name and account type. */
function paintUser() {
  const u = state.user;
  $('#avatarInitials').textContent = initials(u.displayName);
  $('#sideName').textContent = u.displayName || u.email;
  $('#sideType').textContent = ACCOUNT_TYPES.find(t => t.key === u.accountType)?.name || '';
  $('#menuName').textContent = u.displayName || u.email;
  $('#menuEmail').textContent = u.email;
}

function wireShell() {
  paintBranding();
  $$('.nav button').forEach(btn => { btn.onclick = () => navigate(btn.dataset.nav); });

  const menu = $('#userMenu');
  const setMenu = (open) => { menu.classList.toggle('hidden', !open); $('#avatarBtn').setAttribute('aria-expanded', String(open)); };
  $('#avatarBtn').onclick = (e) => { e.stopPropagation(); setMenu(menu.classList.contains('hidden')); };
  menu.onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => setMenu(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  $('#deleteAccountBtn').onclick = () => { $('#userMenu').classList.add('hidden'); openDeleteAccount(); };
  $('#settingsBtn').onclick = () => { $('#userMenu').classList.add('hidden'); openSettings(); };

  // Signing out returns to the front door rather than parking on a bare sign-in form.
  $('#logoutBtn').onclick = async () => {
    await api.post('/api/auth/logout');
    state.user = null;
    state.artworks = [];
    state.shares = [];
    teardownSelectBar();
    closeDetail(true);
    location.href = '/';
  };
}

/** Name, and a password change that signs out every other device. */
function openSettings() {
  const u = state.user;
  const modal = openModal(`
    <div class="modal-head"><h3>Account settings</h3><button class="x" data-close aria-label="Close">×</button></div>
    <div class="modal-body">
      <form id="nameForm" class="settings-block">
        <div class="field">
          <label for="setName">Your name</label>
          <input class="input" id="setName" type="text" autocomplete="name" maxlength="120" value="${esc(u.displayName || '')}">
          <div class="hint">Shown to people you share a link with, as “shared by”.</div>
        </div>
        <div class="field"><label>Email</label><div class="static">${esc(u.email)}</div></div>
        <div class="field">
          <label>Account type</label>
          <div class="segmented" role="radiogroup" aria-label="Account type">
            ${ACCOUNT_TYPES.map(t =>
              `<label class="seg"><input type="radio" name="setType" value="${t.key}"${(u.accountType || 'collector') === t.key ? ' checked' : ''}><span>${t.name}</span></label>`).join('')}
          </div>
          <div class="hint">Artists and galleries get a client list, for sending works by email.</div>
        </div>
        <div class="err hidden" id="nameErr"></div>
        <button class="btn btn-sm" type="submit">Save</button>
      </form>
      <form id="pwForm" class="settings-block">
        <h4>Change password</h4>
        <div class="field">
          <label for="pwCurrent">Current password</label>
          <input class="input" id="pwCurrent" type="password" autocomplete="current-password" required>
        </div>
        <div class="field">
          <label for="pwNew">New password</label>
          <input class="input" id="pwNew" type="password" autocomplete="new-password" minlength="8" required>
          <div class="hint">At least 8 characters. Every other device will be signed out.</div>
        </div>
        <div class="err hidden" id="pwErr"></div>
        <button class="btn btn-primary btn-sm" type="submit">Change password</button>
      </form>
    </div>`, { size: 'sm' });

  const showErr = (sel, ex) => {
    const el = modal.querySelector(sel);
    el.textContent = ex instanceof ApiError ? ex.message : 'That didn’t work. Please try again.';
    el.classList.remove('hidden');
  };
  modal.querySelector('#nameForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await api.patch('/api/auth/me', {
        displayName: modal.querySelector('#setName').value.trim(),
        accountType: modal.querySelector('input[name="setType"]:checked')?.value
      });
      state.user = res.user;
      paintUser();
      paintNav();
      if (state.view === 'collection') render();
      if (state.view === 'clients' && !sells()) navigate('welcome');
      toast('Saved.');
    } catch (ex) { showErr('#nameErr', ex); }
  };
  modal.querySelector('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post('/api/auth/password', {
        currentPassword: modal.querySelector('#pwCurrent').value,
        newPassword: modal.querySelector('#pwNew').value
      });
      modal.querySelector('#pwForm').reset();
      modal.querySelector('#pwErr').classList.add('hidden');
      toast(res.message);
    } catch (ex) { showErr('#pwErr', ex); }
  };
}

/** Deleting is permanent, so it asks for the password rather than a second click. */
function openDeleteAccount() {
  const n = state.artworks.length;
  const modal = openModal(`
    <div class="modal-head"><h3>Delete your account</h3><button class="x" data-close aria-label="Close">×</button></div>
    <form id="deleteForm">
      <div class="modal-body">
        <p style="margin:0;color:var(--muted)">This removes, permanently:</p>
        <ul class="delete-list">
          <li>${n} catalogued work${n === 1 ? '' : 's'}, with their images and documents</li>
          <li>every shared link, which stops working for anyone who has it</li>
          <li>every insurance schedule and inventory you generated</li>
        </ul>
        <p style="margin:0 0 14px;color:var(--muted)">If you want a copy first, <a href="/api/account/export" download>download all your data</a>.</p>
        <div class="field">
          <label for="deletePass">Enter your password to confirm</label>
          <input class="input" id="deletePass" type="password" autocomplete="current-password" required>
        </div>
        <div class="err hidden" id="deleteErr"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" type="button" data-close>Keep my account</button>
        <button class="btn btn-danger" type="submit">Delete everything</button>
      </div>
    </form>`, { size: 'sm' });

  modal.querySelector('#deletePass').focus();
  modal.querySelector('#deleteForm').onsubmit = async (e) => {
    e.preventDefault();
    const err = modal.querySelector('#deleteErr');
    try {
      await api.post('/api/account/delete', { password: modal.querySelector('#deletePass').value });
      teardownSelectBar();
      location.href = '/?deleted=1';
    } catch (ex) {
      err.textContent = ex instanceof ApiError ? ex.message : 'Could not delete the account. Please try again.';
      err.classList.remove('hidden');
    }
  };
}

(async function boot() {
  wireShell();
  initAuth({ onSignedIn: enterApp });

  // A reset link always opens the reset form, even in a browser that is already signed in.
  if (location.pathname === '/reset') return showAuthScreen();

  try {
    const me = await api.get('/api/auth/me');
    state.user = me.user;
    state.firstSignIn = false;
    if (location.pathname === '/app' && location.search) history.replaceState({}, '', '/app');
    await enterApp();
  } catch {
    showAuthScreen();
  }
})();
