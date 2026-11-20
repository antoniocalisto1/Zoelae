import { paintChrome, reflectSession } from './site-chrome.js';
import { ACCOUNT_TYPES } from './brand.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const $ = (sel) => document.querySelector(sel);

paintChrome({ current: '' });
reflectSession();

/* A collector who has just deleted their account lands here; say plainly that it happened. */
if (new URLSearchParams(location.search).get('deleted') === '1') {
  $('#deletedNotice').hidden = false;
  history.replaceState({}, '', '/');
}

/* Three ways in. Each card opens sign-up with that account type already chosen. */
$('#typeCards').innerHTML = ACCOUNT_TYPES.map((t, i) => `
  <a class="lp-type${i === ACCOUNT_TYPES.length - 1 ? ' dark' : ''}" href="/app?mode=signup&type=${esc(t.key)}">
    <span class="k">${esc(t.name)}</span>
    <span class="n">${esc(t.line)}</span>
    <span class="d">${esc(t.blurb)}</span>
    <span class="go">Start as ${t.key === 'artist' ? 'an' : 'a'} ${esc(t.name.toLowerCase())}</span>
  </a>`).join('');
