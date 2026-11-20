// The site's name and home, in one place for the browser. The server fills `data-site` on <html>
// from SITE_NAME (see server/config.js), so renaming is one environment variable.
export const SITE = document.documentElement.dataset.site || 'Zoelae';
export const PLACE = document.documentElement.dataset.place || 'Lisbon';

/** The three kinds of account. Chosen at sign-up, changeable in settings. Everything is free. */
export const ACCOUNT_TYPES = [
  { key: 'collector', name: 'Collector', line: 'For the person who owns the work', blurb: 'Valuations, provenance and paperwork in one place, and a private way to show it.' },
  { key: 'artist', name: 'Artist', line: 'For the person who made it', blurb: 'Your output, where each piece went, and a client list for the people who buy.' },
  { key: 'gallery', name: 'Gallery', line: 'For the people who place it', blurb: 'Stock, clients and private views, imported from the list you already keep.' }
];

/* ---------- the wordmark and the favicon ----------
   The name in spaced capitals, set in Cormorant Garamond. It is text, so it stays sharp at any
   size and screen readers read the name itself. */

const esc = (s) => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/** The name as a wordmark. The link around it carries the accessible name. */
export function wordmark({ small = false } = {}) {
  return `<span class="wordmark${small ? ' sm' : ''}" aria-hidden="true">${esc(SITE)}</span>`;
}

/** The first letter in a square, for the browser tab. */
export function faviconDataUri() {
  const letter = esc(SITE.charAt(0).toUpperCase() || 'Z');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" fill="#141311"/>
    <text x="32" y="46" text-anchor="middle" font-family="'Cormorant Garamond',Garamond,'Times New Roman',serif" font-size="44" fill="#faf9f7">${letter}</text>
  </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

export function setFavicon() {
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.href = faviconDataUri();
  document.head.appendChild(icon);
}
