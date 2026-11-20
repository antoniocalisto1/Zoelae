// The page a collector lands on after signing in. Calm and typographic — no dashboard chrome.
import { $, esc, money } from './format.js';
import { state } from './store.js';

/** Time of day is resolved from the collector's own clock, so it matches the room they're in. */
function timeOfDay(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function greeting() {
  const first = (state.user?.displayName || '').trim().split(/\s+/)[0];
  const stem = state.firstSignIn ? 'Welcome' : 'Welcome back';
  return first ? `${stem}, ${esc(first)}` : 'Welcome back';
}

const QUICK_ACTIONS = [
  { icon: 'I', title: 'Add a work', desc: 'Photograph, artist, year and what you paid.', action: 'add' },
  { icon: 'II', title: 'Add a folder', desc: 'Every photograph in it, then the details one by one.', action: 'folder' },
  { icon: 'III', title: 'Create a shared link', desc: 'Pick works, choose what a viewer may see.', action: 'share' },
  { icon: 'IV', title: 'Import a spreadsheet', desc: 'Many works at once, from Excel or CSV.', action: 'import' },
  { icon: 'V', title: 'Insurance schedule', desc: 'A formatted PDF for your broker or solicitor.', action: 'reports' }
];

function figuresHtml(summary) {
  const figures = [
    { n: summary.totalPieces, l: summary.totalPieces === 1 ? 'piece' : 'pieces' }
  ];
  // The valuation figure only appears once at least one piece has a valuation recorded.
  if (summary.totalValuation !== null) {
    figures.push({ n: money(summary.totalValuation), l: `valued across ${summary.valuedPieces} pieces` });
  }
  if (summary.forSale) figures.push({ n: summary.forSale, l: 'for sale' });
  if (summary.sold) figures.push({ n: summary.sold, l: 'sold' });
  figures.push({ n: summary.addedThisMonth, l: 'added this month' });
  figures.push({ n: summary.activeSharedLinks, l: summary.activeSharedLinks === 1 ? 'active shared link' : 'active shared links' });

  return `<div class="figures">${figures.map(f => `
    <div class="figure"><div class="n">${esc(f.n)}</div><div class="l">${esc(f.l)}</div></div>`).join('')}</div>`;
}

/** The first step, for an empty catalogue. Shared with the collection page, which a new account opens on. */
export function firstRunHtml(attr = 'data-action="add"') {
  const folderAttr = attr === 'data-add' ? 'data-folder' : 'data-action="folder"';
  return `<div class="firstrun">
    <div class="firstrun-slip">
      <p class="pv-kicker">The first step</p>
      <h2>Begin with one work, or a whole folder.</h2>
      <p>Nothing here is seen by anyone until you make a shared link.</p>
      <ol>
        <li><b>Photograph it.</b> One clear, straight-on shot is plenty. Location data is removed when you upload.</li>
        <li><b>Record what you know.</b> Title and artist are all that's required. Year, medium, size and price can wait.</li>
        <li><b>Attach the paperwork.</b> Certificates, appraisals and invoices live with the work, not in a drawer.</li>
        <li><b>Share when you're ready.</b> Choose the works, set a passcode, and decide what a viewer may see.</li>
      </ol>
      <div class="go">
        <button class="btn btn-primary pill" ${attr}>Add your first work</button>
        <button class="btn pill" ${folderAttr}>Add a folder of photographs</button>
      </div>
      <p class="firstrun-alt">Already keep a list in Excel? <button type="button" class="linkish" data-import>Import it from a spreadsheet</button>, photos and all.</p>
    </div>
  </div>`;
}

export function renderWelcome(onAction) {
  const summary = state.summary || { totalPieces: 0, totalValuation: null, valuedPieces: 0, addedThisMonth: 0, activeSharedLinks: 0 };
  const empty = summary.totalPieces === 0;

  $('#main').innerHTML = `<section class="welcome">
    <div class="timeofday">${timeOfDay()}</div>
    <h1>${greeting()}</h1>
    <p class="lede">${empty
      ? 'This is where your collection will live. Private by default, and yours to share a piece at a time.'
      : 'Everything is where you left it. Here is the shape of the collection today.'}</p>
    ${empty ? firstRunHtml() : figuresHtml(summary) + `
      <div class="quick">${QUICK_ACTIONS.map(a => `
        <button data-action="${a.action}">
          <div class="qi">${a.icon}</div>
          <div class="qt">${esc(a.title)}</div>
          <div class="qd">${esc(a.desc)}</div>
        </button>`).join('')}
      </div>`}
  </section>`;

  $('#main').querySelectorAll('[data-action]').forEach(el => {
    el.onclick = () => onAction(el.dataset.action);
  });
  $('#main').querySelectorAll('[data-import]').forEach(el => { el.onclick = () => onAction('import'); });
}
