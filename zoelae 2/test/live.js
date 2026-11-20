'use strict';
/* The site in a real browser, as a brand-new visitor would meet it.
 *
 *   npm run live
 *
 * Starts its own server on an empty, throwaway database (port 3990), then walks through: the
 * front door, the legal pages, sign-up with an account type, the first upload (a phone photo with
 * GPS in it), a folder of photographs described one by one, sharing, the viewer, a spreadsheet
 * import, clients, a forgotten password via the outbox, and every page at phone width.
 * Screenshots land in data/live-shots/. Needs Playwright with a Chromium it can launch
 * (set CHROMIUM_PATH if it isn't on the default path).
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.LIVE_PORT || 3990);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, 'data', 'live');
const OUT = process.env.SHOTS || path.join(ROOT, 'data', 'live-shots');

const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), BCRYPT_ROUNDS: '6',
  DATABASE_FILE: path.join(DATA, 'live.db'), UPLOADS_DIR: path.join(DATA, 'uploads'),
  OUTBOX_DIR: path.join(DATA, 'outbox'), POSTMARK_SERVER_TOKEN: '',
  SESSION_SECRET: 'live-secret-live-secret-live-secret', IP_HASH_SALT: 'live-salt'
};

const results = [];
const errors = [];
const check = (name, ok, extra) => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? `  (${extra})` : ''}`);
};

function startServer() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', d => { if (String(d).includes('running at')) { clearTimeout(t); resolve(proc); } });
    proc.stderr.on('data', d => process.stderr.write(`  [server] ${d}`));
  });
}

function watch(page, label) {
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // expected: the signed-out probe on boot, a wrong passcode, the 404 page's own status
    if (/\b(401|404)\b/.test(t)) return;
    // the sandbox this was written in blocks web fonts; not the site's fault
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/.test(t)) return;
    errors.push(`${label}: ${t}`);
  });
}

const shot = (page, name, fullPage = false) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });

async function run() {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH || fs.existsSync('/opt/pw-browsers/chromium')
    ? { executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  watch(page, 'collector');

  console.log('\nThe front door');
  await page.goto(BASE + '/');
  await page.waitForTimeout(1500);
  check('the landing page loads with the wordmark', await page.isVisible('#brandLink .wordmark'));
  check('the first call to action is "Create an account"', (await page.getAttribute('.lp-cta .btn-primary', 'href')) === '/app?mode=signup');
  const text = await page.textContent('body');
  check('nothing on the page mentions a demo', !/demo/i.test(text));
  check('there are no prices or plans on the page', !/€\s?\d|per month|\/month/i.test(text) && !(await page.$('a[href="/plans"]')));
  check('three account types are offered', (await page.$$('.lp-type')).length === 3);
  for (const id of ['#how', '#sharing', '#trust', '#accounts', '#faq', '#about']) check(`the page has ${id}`, !!(await page.$(id)));
  const examples = await page.$$eval('.pv-example img', els => els.filter(i => i.complete && i.naturalWidth > 0).length);
  check('every sample artwork is labelled as an example and loads', examples === 4, `${examples} labelled`);
  check('the name comes from one setting', (await page.textContent('#brandLink .wordmark')).trim() === 'Zoelae');
  await shot(page, '01-landing', true);

  await page.goto(BASE + '/plans');
  check('/plans leads to the account types', page.url().endsWith('/#accounts'), page.url());
  for (const [url, name] of [['/privacy', '03-privacy'], ['/terms', '04-terms'], ['/no-such-page', '05-not-found']]) {
    const res = await page.goto(BASE + url);
    await page.waitForTimeout(700);
    check(`${url} answers ${url === '/no-such-page' ? 404 : 200}`, res.status() === (url === '/no-such-page' ? 404 : 200));
    await shot(page, name, true);
  }
  check('the legal pages say they are drafts', /Draft for review/.test(await (await page.goto(BASE + '/privacy')).text()));

  console.log('\nSigning up');
  await page.goto(BASE + '/app?mode=signup');
  await page.waitForTimeout(900);
  check('the door has no demo button', !(await page.$('#demoBtn')));
  await shot(page, '06-signup');
  const email = `new-visitor-${Date.now()}@example.test`;
  await page.fill('#fName', 'Marta Quental');
  await page.fill('#fEmail', email);
  await page.fill('#fPass', 'short');
  await page.click('#authSubmit');
  check('sign-up asks for an account type first', /account type/.test(await page.textContent('#authErr')));
  await page.click('.type-opt:has-text("Collector")');
  await page.click('#authSubmit');
  check('a short password is refused before it leaves the page', /8 characters/.test(await page.textContent('#authErr')));
  await page.fill('#fPass', 'a room of my own');
  await page.click('#authSubmit');
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForTimeout(1000);
  check('a new account opens on an empty collection with the first step', await page.isVisible('.firstrun-slip'));
  await shot(page, '07-first-run');

  console.log('\nThe first upload');
  const photo = await sharp({ create: { width: 3024, height: 4032, channels: 3, background: '#e8e1d3' } })
    .composite([{ input: Buffer.from('<svg width="3024" height="4032"><rect x="500" y="700" width="2024" height="2600" fill="#2b45c4"/><circle cx="1512" cy="1800" r="600" fill="#cf3a24"/></svg>') }])
    .jpeg().withExif({ IFD0: { Make: 'Phone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '38/1 42/1 49/1', GPSLongitudeRef: 'W', GPSLongitude: '9/1 8/1 21/1' } })
    .toBuffer();
  const photoPath = path.join(DATA, 'IMG_2041.jpg');
  fs.writeFileSync(photoPath, photo);
  await page.click('#results [data-add]');
  await page.waitForTimeout(600);
  await page.setInputFiles('#imageInput', photoPath);
  await page.fill('#wTitle', 'Blue Field with Red Sun');
  await page.fill('#wArtist', 'Teodora Lisle');
  await page.fill('#wYear', '2021');
  await shot(page, '08-add-work');
  await page.click('#workForm button[type=submit]');
  await page.waitForSelector('.card');
  await page.waitForTimeout(900);
  const thumb = await page.$eval('.card img', i => i.getAttribute('src'));
  check('the grid loads the thumbnail, not the original', /size=thumb/.test(thumb), thumb);
  await shot(page, '09-collection');
  await page.click('.card');
  await page.waitForTimeout(1400);
  check('the detail image appears after the transition', await page.$eval('#detailImage', i => i.complete && i.naturalWidth > 0 && getComputedStyle(i).visibility === 'visible'));
  await shot(page, '10-detail');
  const metaOk = await page.evaluate(async () => {
    const a = (await (await fetch('/api/artworks')).json()).artworks[0];
    const b = new Uint8Array(await (await fetch(a.images[0].originalUrl)).arrayBuffer());
    // look for the GPS IFD tag in either byte order
    for (let i = 0; i < b.length - 1; i++) if ((b[i] === 0x25 && b[i + 1] === 0x88) || (b[i] === 0x88 && b[i + 1] === 0x25)) return false;
    return true;
  });
  check('the stored photo carries no GPS tag', metaOk);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  console.log('\nA folder of photographs');
  {
    const dir = path.join(DATA, 'Studio 2026');
    fs.mkdirSync(path.join(dir, 'older'), { recursive: true });
    const plate = (c) => sharp({ create: { width: 1600, height: 2000, channels: 3, background: c } }).jpeg().withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '38/1 42/1 0/1' } }).toBuffer();
    fs.writeFileSync(path.join(dir, 'Harbour_at_Six.jpg'), await plate('#2f7a5f'));
    fs.writeFileSync(path.join(dir, 'IMG_3001.JPG'), await plate('#c9962e'));
    fs.writeFileSync(path.join(dir, 'older', 'Night Ferry - 1983.png'), await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#14213d' } }).png().toBuffer());
    fs.writeFileSync(path.join(dir, 'price list.txt'), 'not a photograph');
    await page.click('#folderBtn');
    await page.waitForTimeout(600);
    await shot(page, '10b-folder-pick');
    await page.setInputFiles('#fuFolderInput', dir);
    await page.waitForSelector('#fuGo');
    check('a folder brings in its photographs, sub-folders included, and leaves the rest', /Add 3 works/.test(await page.textContent('#fuGo')));
    await shot(page, '10c-folder-review');
    await page.click('#fuGo');
    await page.waitForSelector('#fuDescribe', { timeout: 30000 });
    check('every photograph becomes a work', /^3$/.test((await page.textContent('.imp-done .imp-big')).trim()));
    await page.click('#fuDescribe');
    await page.waitForSelector('#dTitle');
    await page.waitForTimeout(700);
    check('the describer opens on the first photograph with its name as the title', (await page.inputValue('#dTitle')) === 'Harbour at Six');
    await page.fill('#dArtist', 'Teodora Lisle');
    await page.fill('#dYear', '2022');
    await shot(page, '10d-describe');
    await page.click('#dSave');
    await page.waitForTimeout(700);
    check('a camera file name leaves the title empty', (await page.inputValue('#dTitle')) === '');
    await page.click('#dSave');
    check('a title is asked for before saving', /title/.test(await page.textContent('#dErr')));
    await page.fill('#dTitle', 'Small Study (Ochre)');
    await page.click('#dSame');
    check('"same as the last one" fills the artist', (await page.inputValue('#dArtist')) === 'Teodora Lisle');
    await page.click('#dSave');
    await page.waitForTimeout(700);
    await page.click('#dSkip');
    await page.waitForTimeout(1200);
    check('a skipped work waits in the collection', /1 work is/.test(await page.textContent('#todoBanner')));
    check('it is marked on its card', (await page.$$('.card .a.needs')).length === 1);
    await shot(page, '10e-waiting');
    const clean = await page.evaluate(async () => {
      const works = (await (await fetch('/api/artworks')).json()).artworks.filter(a => a.title === 'Harbour at Six');
      const b = new Uint8Array(await (await fetch(works[0].images[0].originalUrl)).arrayBuffer());
      for (let i = 0; i < b.length - 1; i++) if ((b[i] === 0x25 && b[i + 1] === 0x88) || (b[i] === 0x88 && b[i + 1] === 0x25)) return false;
      return true;
    });
    check('photographs from a folder carry no GPS tag', clean);
  }

  console.log('\nSharing');
  const share = await page.evaluate(async () => {
    const ids = (await (await fetch('/api/artworks')).json()).artworks.map(a => a.id);
    const r = await fetch('/api/shares', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'For the framer', passcode: 'linen-and-oak-9', artworkIds: ids, introMessage: 'The one for the hallway.' }) });
    return r.json();
  });
  check('a shared link is created', !!share.share?.slug);
  await page.click('[data-nav="shared-links"]');
  await page.waitForTimeout(800);
  await shot(page, '11-shared-links');

  const viewer = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  watch(viewer, 'viewer');
  await viewer.goto(`${BASE}/s/${share.share.slug}`);
  await viewer.waitForTimeout(1200);
  check('the viewer meets the passcode door first', await viewer.isVisible('#gatePass'));
  check('the door shows no artwork', !(await viewer.$('.piece')));
  await shot(viewer, '12-viewer-gate');
  await viewer.fill('#gatePass', 'linen-and-oak-9');
  await viewer.click('#gateSubmit');
  await viewer.waitForSelector('.piece');
  await viewer.waitForTimeout(800);
  await shot(viewer, '13-viewer-gallery');
  await viewer.click('.piece');
  await viewer.waitForTimeout(900);
  await shot(viewer, '14-viewer-piece');
  await viewer.goto(`${BASE}/s/not-a-real-link`);
  await viewer.waitForTimeout(900);
  check('a dead link says the view has closed', /closed/.test(await viewer.textContent('body')));
  await shot(viewer, '15-viewer-closed');

  console.log('\nImporting a spreadsheet, statuses and clients');
  {
    const ExcelJS = require('exceljs');
    const { zipSync } = require('fflate');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Stock');
    ws.addRow(['Inv. No.', 'Artist', 'Title', 'Year', 'Medium', 'Retail price', 'Status', 'Image']);
    ws.addRow(['ML-01', 'Teodora Lisle', 'Harbour at Six', 2022, 'Oil on linen', '€9.800', 'Sold', 'ml01.jpg']);
    ws.addRow(['ML-02', 'Teodora Lisle', 'Small Study (Ochre)', 2023, 'Gouache on paper', '€2.400', 'Available', 'ml02.jpg']);
    ws.addRow(['ML-03', 'Mira Oduya', 'Night Ferry', 1983, 'Oil on canvas', '', 'NFS', '']);
    const sheetPath = path.join(DATA, 'stock.xlsx');
    fs.writeFileSync(sheetPath, Buffer.from(await wb.xlsx.writeBuffer()));
    const plate = (c) => sharp({ create: { width: 1200, height: 900, channels: 3, background: c } }).jpeg().toBuffer();
    const zipPath = path.join(DATA, 'photos.zip');
    fs.writeFileSync(zipPath, Buffer.from(zipSync({ 'ml01.jpg': new Uint8Array(await plate('#2f7a5f')), 'ml02.jpg': new Uint8Array(await plate('#c9962e')) })));

    await page.click('[data-nav="collection"]');
    await page.waitForTimeout(600);
    await page.click('#importBtn');
    await page.setInputFiles('#sheetInput', sheetPath);
    await page.waitForSelector('#impCheck .imp-summary', { timeout: 15000 });
    check('the sheet’s columns are matched without help', (await page.$$eval('.imp-map-row.off', r => r.length)) === 0);
    await shot(page, '19a-import-match');
    await page.setInputFiles('#photoInput', zipPath);
    await page.click('#runBtn');
    await page.waitForSelector('.imp-done', { timeout: 60000 });
    check('three works are imported', /^3$/.test((await page.textContent('.imp-done .imp-big')).trim()));
    await shot(page, '19b-import-done');
    await page.click('.modal-foot [data-close]');
    await page.waitForTimeout(1200);
    check('the status tabs count for sale and sold', /For sale\s*1/.test(await page.textContent('#statusTabs')) && /Sold\s*1/.test(await page.textContent('#statusTabs')));
    check('a sold work carries the red dot', (await page.$$('.card .sold-dot')).length === 1);
    await shot(page, '19c-collection-status');

    // become a gallery, which brings the client list
    await page.click('#avatarBtn');
    await page.click('#settingsBtn');
    await page.click('label.seg:has-text("Gallery")');
    await page.click('#nameForm button[type=submit]');
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    check('a gallery account gets a Clients page', await page.isVisible('[data-nav="clients"]'));
    await page.click('[data-nav="clients"]');
    await page.waitForTimeout(700);
    await shot(page, '19d-clients-empty');
    await page.click('#addClient');
    await page.fill('#cName', 'Inês Marlow');
    await page.fill('#cEmail', 'ines@example.test');
    await page.fill('#cInterests', 'Large abstract painting');
    await page.click('#clientForm button[type=submit]');
    await page.waitForTimeout(900);
    check('a client is added', /Inês Marlow/.test(await page.textContent('#main')));
    await page.click('#sendWorksBtn');
    await page.waitForTimeout(700);
    await page.click('#toSearch');
    await page.click('[data-recipient]');
    await page.click('label.seg:has-text("A PDF of works")');
    for (const cb of (await page.$$('[data-work]')).slice(0, 2)) await cb.check();
    await shot(page, '19e-send');
    await page.click('#sendForm button[type=submit]');
    await page.waitForTimeout(2500);
    const mails = fs.readdirSync(env.OUTBOX_DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(env.OUTBOX_DIR, f), 'utf8')));
    const toClient = mails.find(m => m.to === 'ines@example.test');
    check('the client gets an email with the PDF attached', !!toClient && toClient.attachments.length === 1);
    await page.click('tr[data-id]');
    await page.waitForTimeout(700);
    check('the client remembers what was sent', /PDF/.test(await page.textContent('.client-log')));
    await shot(page, '19f-client');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  console.log('\nA forgotten password');
  const other = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  watch(other, 'reset');
  await other.goto(BASE + '/app');
  await other.waitForTimeout(700);
  await other.click('#forgotBtn');
  await other.fill('#fEmail', email);
  await other.click('#authSubmit');
  await other.waitForTimeout(700);
  check('the page says to check your email and points at the local outbox', /outbox/.test(await other.textContent('#authOk')));
  await shot(other, '16-reset-sent');
  await other.goto(BASE + '/dev/outbox');
  await other.click('li a');
  await other.waitForTimeout(500);
  await shot(other, '17-reset-email');
  const link = await other.$eval('a[href*="token="]', a => a.href);
  check('the email links to the site\'s own address', link.startsWith(BASE.replace('127.0.0.1', 'localhost')) || link.startsWith(BASE), link);
  await other.goto(link.replace('localhost', '127.0.0.1'));
  await other.waitForTimeout(900);
  check('the reset form opens', (await other.textContent('#authTitle')).includes('new password'));
  await shot(other, '18-reset-form');
  await other.fill('#fPass', 'a different room');
  await other.click('#authSubmit');
  await other.waitForSelector('#app:not(.hidden)');
  check('choosing a new password signs in', true);
  await page.reload();
  await page.waitForTimeout(1000);
  check('the first browser was signed out by the reset', await page.isVisible('#authScreen'));

  console.log('\nPhone width');
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true })).newPage();
  watch(phone, 'phone');
  for (const [url, name] of [['/', '20-phone-landing'], ['/app', '22-phone-signin'], [`/s/${share.share.slug}`, '23-phone-viewer']]) {
    await phone.goto(BASE + url);
    await phone.waitForTimeout(1000);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${url} has no sideways scroll on a phone`, overflow <= 1, `${overflow}px`);
    await shot(phone, name, url === '/');
  }
  // signed in, where the top bar has the most in it
  await phone.goto(BASE + '/app');
  await phone.waitForTimeout(800);
  await phone.fill('#fEmail', email);
  await phone.fill('#fPass', 'a different room');
  await phone.click('#authSubmit');
  await phone.waitForSelector('#app:not(.hidden)');
  for (const view of ['collection', 'clients']) {
    await phone.evaluate((v) => document.querySelector(`[data-nav="${v}"]`).click(), view);
    await phone.waitForTimeout(900);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`the ${view} page has no sideways scroll on a phone`, overflow <= 1, `${overflow}px`);
    await shot(phone, `24-phone-${view}`);
  }

  await browser.close();
}

(async () => {
  const server = await startServer();
  let ok = false;
  try {
    await run();
    check('no errors in any page', errors.length === 0, errors.slice(0, 3).join(' | '));
    ok = results.every(r => r.ok);
  } catch (err) {
    console.error('\nWalk-through stopped:', err);
  } finally {
    server.kill();
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots in ${OUT}\n`);
  process.exit(ok ? 0 : 1);
})();
