'use strict';
/**
 * End-to-end verification of the shared-collections security model.
 * Runs against a throwaway database on its own port: `npm run verify`.
 *
 * Covers the six checks from the feature brief, plus a few adjacent ones worth pinning down.
 */
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(ROOT, 'data', 'verify.db');
const UPLOADS = path.join(ROOT, 'data', 'verify-uploads');
const OUTBOX = path.join(ROOT, 'data', 'verify-outbox');

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(PORT),
  DATABASE_FILE: DB_FILE,
  UPLOADS_DIR: UPLOADS,
  OUTBOX_DIR: OUTBOX,
  POSTMARK_SERVER_TOKEN: '',
  BCRYPT_ROUNDS: '6',              // keeps the suite quick; production uses the configured cost
  SESSION_SECRET: 'verify-secret-verify-secret-verify',
  IP_HASH_SALT: 'verify-salt'
};

/* ---------- tiny test harness ---------- */
let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* ---------- fetch with a per-client cookie jar ---------- */
function client() {
  const jar = new Map();
  return {
    jar,
    async fetch(pathname, { method = 'GET', body, headers = {} } = {}) {
      const h = { ...headers };
      if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body !== undefined) h['content-type'] = 'application/json';

      const res = await fetch(BASE + pathname, {
        method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual'
      });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        jar.set(pair.slice(0, idx), pair.slice(idx + 1));
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      return { status: res.status, text, json, headers: res.headers };
    }
  };
}

/* ---------- setup ---------- */
function reset() {
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) if (fs.existsSync(f)) fs.rmSync(f);
  for (const d of [UPLOADS, OUTBOX]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  execFileSync(process.execPath, ['server/migrate.js'], { cwd: ROOT, env, stdio: 'ignore' });
  execFileSync(process.execPath, ['test/fixtures.js'], { cwd: ROOT, env, stdio: 'ignore' });
}

function startServer() {
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('running at')) { clearTimeout(timer); resolve(proc); }
    });
    proc.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));
  });
}

/* ---------- helpers ---------- */
const OWNER = { email: 'owner@fixture.test', password: 'fixture-owner-pw' };
const OTHER = { email: 'other@fixture.test', password: 'fixture-other-pw' };

async function signIn(creds) {
  const c = client();
  const res = await c.fetch('/api/auth/login', { method: 'POST', body: creds });
  assert(res.status === 200, `sign-in failed: ${res.status} ${res.text}`);
  return c;
}

async function createShare(collector, overrides = {}) {
  const { json } = await collector.fetch('/api/artworks');
  const artworkIds = json.artworks.slice(0, 3).map(a => a.id);
  const res = await collector.fetch('/api/shares', {
    method: 'POST',
    body: {
      title: 'Verification share',
      artworkIds,
      passcode: 'correct-horse-42',
      showPrices: false, showDocuments: false, showProvenance: false, showLocation: false,
      ...overrides
    }
  });
  assert(res.status === 201, `share creation failed: ${res.status} ${res.text}`);
  return { share: res.json.share, shareUrl: res.json.shareUrl, artworkIds, all: json.artworks };
}

async function unlock(viewer, slug, passcode = 'correct-horse-42') {
  return viewer.fetch(`/api/s/${slug}/unlock`, { method: 'POST', body: { passcode } });
}

/* ---------- the checks ---------- */
async function run() {
  console.log('\nZoelae — shared collection verification\n');

  const owner = await signIn(OWNER);

  console.log('1. A viewer with no passcode receives no artwork data');
  {
    const { share, all } = await createShare(owner);
    const viewer = client();

    const collection = await viewer.fetch(`/api/s/${share.slug}/collection`);
    await check('collection endpoint refuses an unauthenticated viewer', () => {
      assert(collection.status === 401, `expected 401, got ${collection.status}`);
    });
    await check('refusal body carries no artwork data', () => {
      const titles = all.map(a => a.title);
      assert(!titles.some(t => collection.text.includes(t)), 'a title leaked into the refusal body');
      assert(!/artist|images|medium/i.test(collection.text), 'artwork fields leaked into the refusal body');
    });

    const meta = await viewer.fetch(`/api/s/${share.slug}/meta`);
    await check('gate metadata exposes only the title and owner name', () => {
      assert(meta.status === 200, `expected 200, got ${meta.status}`);
      assert(JSON.stringify(Object.keys(meta.json).sort()) === '["ownerName","title"]',
        `unexpected keys: ${Object.keys(meta.json)}`);
      assert(meta.json.itemCount === undefined, 'item count leaked');
    });

    const item = await viewer.fetch(`/api/s/${share.slug}/items/itm_anything`);
    await check('item endpoint refuses without a session', () => {
      assert(item.status === 401, `expected 401, got ${item.status}`);
    });

    const page = await viewer.fetch(`/s/${share.slug}`);
    await check('the gate page HTML contains no artwork data', () => {
      assert(page.status === 200, `expected 200, got ${page.status}`);
      const titles = all.map(a => a.title);
      assert(!titles.some(t => page.text.includes(t)), 'a title was server-rendered into the page');
      assert(!page.text.includes('/api/images/'), 'an image URL was embedded in the page');
    });

    const image = await viewer.fetch(`/api/s/${share.slug}/images/img_whatever`);
    await check('image route refuses without a session', () => {
      assert(image.status === 401, `expected 401, got ${image.status}`);
    });
  }

  console.log('\n2. Toggling prices off removes every price field from the payload');
  {
    // The title is echoed back in the payload, so it deliberately avoids the words being searched for.
    const { share, all } = await createShare(owner, { title: 'Everything hidden' });
    const viewer = client();
    assert((await unlock(viewer, share.slug)).status === 200, 'unlock failed');

    const res = await viewer.fetch(`/api/s/${share.slug}/collection`);
    await check('no price-shaped key appears anywhere in the JSON', () => {
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(!/price|valuation|insured|currency/i.test(res.text), 'a price-related key survived');
    });
    await check('no price value appears anywhere in the JSON', () => {
      const values = all.filter(a => a.purchasePrice).map(a => String(a.purchasePrice));
      const leaked = values.filter(v => res.text.includes(v));
      assert(leaked.length === 0, `price values leaked: ${leaked.join(', ')}`);
    });
    await check('provenance, documents and location are absent too', () => {
      assert(!/provenance|priorOwners|exhibition|storageLocation|documents/i.test(res.text),
        'a gated section survived');
    });
    await check('permitted fields are still present', () => {
      assert(/"title"/.test(res.text) && /"artist"/.test(res.text) && /"images"/.test(res.text),
        'the always-visible fields are missing');
    });

    const withPrices = await createShare(owner, { title: 'With prices', showPrices: true });
    const viewer2 = client();
    await unlock(viewer2, withPrices.share.slug);
    const res2 = await viewer2.fetch(`/api/s/${withPrices.share.slug}/collection`);
    await check('turning the toggle on does add the price block', () => {
      assert(/"prices"/.test(res2.text), 'prices did not appear when permitted');
    });
  }

  console.log('\n3. Revoking a link stops it immediately, including for a live session');
  {
    const { share } = await createShare(owner, { title: 'To be revoked' });
    const viewer = client();
    await unlock(viewer, share.slug);
    const before = await viewer.fetch(`/api/s/${share.slug}/collection`);
    assert(before.status === 200, 'viewer could not read before revoking');

    await owner.fetch(`/api/shares/${share.slug}/revoke`, { method: 'POST' });

    const after = await viewer.fetch(`/api/s/${share.slug}/collection`);
    await check('an already-admitted viewer is cut off on the next request', () => {
      assert(after.status === 410, `expected 410, got ${after.status}`);
      assert(/no longer available/i.test(after.text), 'the polite message is missing');
    });
    await check('images stop being served too', async () => {
      const img = await viewer.fetch(`/api/s/${share.slug}/images/anything`);
      assert(img.status === 410, `expected 410, got ${img.status}`);
    });
    await check('a fresh unlock attempt is refused', async () => {
      const res = await unlock(client(), share.slug);
      assert(res.status === 410, `expected 410, got ${res.status}`);
    });
  }

  console.log('\n4. An expired link is rejected server-side, whatever the client believes');
  {
    const { share } = await createShare(owner, { title: 'To expire' });
    const viewer = client();
    await unlock(viewer, share.slug);
    assert((await viewer.fetch(`/api/s/${share.slug}/collection`)).status === 200, 'viewer blocked too early');

    // Simulate the clock moving past the expiry.
    const db = new Database(DB_FILE);
    db.prepare('UPDATE shared_collections SET expires_at = ? WHERE slug = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), share.slug);
    db.close();

    await check('expiry is enforced even with a client claiming an earlier date', async () => {
      const res = await viewer.fetch(`/api/s/${share.slug}/collection`, {
        headers: { 'x-client-date': new Date(Date.now() - 86_400_000).toUTCString() }
      });
      assert(res.status === 410, `expected 410, got ${res.status}`);
    });
    await check('the expired link cannot be unlocked again', async () => {
      const res = await unlock(client(), share.slug);
      assert(res.status === 410, `expected 410, got ${res.status}`);
    });
  }

  console.log('\n5. A collector cannot share another collector’s artwork');
  {
    const other = await signIn(OTHER);
    const theirs = (await other.fetch('/api/artworks')).json.artworks;
    assert(theirs.length > 0, 'the second collector has no artworks to test with');

    const mine = (await owner.fetch('/api/artworks')).json.artworks;

    await check('a foreign artwork id is refused outright', async () => {
      const res = await owner.fetch('/api/shares', {
        method: 'POST',
        body: { title: 'Cross-owner attempt', artworkIds: [theirs[0].id], passcode: 'correct-horse-42' }
      });
      assert(res.status === 403, `expected 403, got ${res.status} ${res.text}`);
    });

    await check('mixing a foreign id into a valid list is refused, and nothing is written', async () => {
      const before = (await owner.fetch('/api/shares')).json.shares.length;
      const res = await owner.fetch('/api/shares', {
        method: 'POST',
        body: { title: 'Mixed attempt', artworkIds: [mine[0].id, theirs[0].id], passcode: 'correct-horse-42' }
      });
      assert(res.status === 403, `expected 403, got ${res.status}`);
      const after = (await owner.fetch('/api/shares')).json.shares.length;
      assert(before === after, 'a share row was created despite the rejection');
    });

    await check('the same rule applies when editing an existing share', async () => {
      const { share } = await createShare(owner, { title: 'Edit target' });
      const res = await owner.fetch(`/api/shares/${share.slug}`, {
        method: 'PATCH', body: { artworkIds: [theirs[0].id] }
      });
      assert(res.status === 403, `expected 403, got ${res.status}`);
    });

    await check('another collector cannot read or revoke a share they do not own', async () => {
      const { share } = await createShare(owner, { title: 'Not yours' });
      const read = await other.fetch(`/api/shares/${share.slug}`);
      const revoke = await other.fetch(`/api/shares/${share.slug}/revoke`, { method: 'POST' });
      assert(read.status === 404 && revoke.status === 404, `expected 404s, got ${read.status}/${revoke.status}`);
    });
  }

  console.log('\n6. Rate limiting blocks the sixth wrong passcode');
  {
    const { share } = await createShare(owner, { title: 'Rate limited' });
    const attacker = client();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await unlock(attacker, share.slug, `wrong-${i}`)).status);

    await check('the first five attempts are refused with 401', () => {
      assert(codes.slice(0, 5).every(c => c === 401), `expected five 401s, got ${codes.join(',')}`);
    });
    await check('the sixth attempt is blocked with 429', () => {
      assert(codes[5] === 429, `expected 429, got ${codes[5]}`);
    });
    await check('the correct passcode is refused too while locked out', async () => {
      const res = await unlock(attacker, share.slug);
      assert(res.status === 429, `expected 429, got ${res.status}`);
    });
    await check('every attempt was written to the access log', async () => {
      const log = (await owner.fetch(`/api/shares/${share.slug}/access-log`)).json.entries;
      assert(log.length >= 7, `expected at least 7 entries, got ${log.length}`);
      assert(log.every(e => e.success === false), 'a failed attempt was logged as a success');
      assert(!log.some(e => /\d+\.\d+\.\d+\.\d+/.test(e.visitor)), 'a raw IP address was stored');
    });
  }

  console.log('\n7. Everything else worth pinning down');
  {
    const { share } = await createShare(owner, { title: 'Assorted', showPrices: true, showDocuments: true });

    await check('no API response ever contains the passcode hash', async () => {
      const list = await owner.fetch('/api/shares');
      const detail = await owner.fetch(`/api/shares/${share.slug}`);
      assert(!/passcode_hash|passcodeHash|\$2[aby]\$/.test(list.text + detail.text), 'a hash leaked');
    });

    await check('the slug is long and not sequential', () => {
      assert(share.slug.length >= 22, `slug is only ${share.slug.length} characters`);
    });

    await check('viewer payloads never contain internal or artwork ids', async () => {
      const viewer = client();
      await unlock(viewer, share.slug);
      const res = await viewer.fetch(`/api/s/${share.slug}/collection`);
      assert(!/"art_/.test(res.text), 'an artwork public id reached the viewer');
      assert(!/ownerId|owner_id|"artworkId"/.test(res.text), 'an internal identifier reached the viewer');
    });

    await check('a session for one share does not open another', async () => {
      const a = await createShare(owner, { title: 'Share A' });
      const b = await createShare(owner, { title: 'Share B' });
      const viewer = client();
      await unlock(viewer, a.share.slug);
      const res = await viewer.fetch(`/api/s/${b.share.slug}/collection`);
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });

    await check('view count rises once per unlock, not per page render', async () => {
      const { share: s } = await createShare(owner, { title: 'Counting' });
      const viewer = client();
      await unlock(viewer, s.slug);
      for (let i = 0; i < 4; i++) await viewer.fetch(`/api/s/${s.slug}/collection`);
      const after = (await owner.fetch(`/api/shares/${s.slug}`)).json.share.viewCount;
      assert(after === 1, `expected 1 view, got ${after}`);
    });

    await check('a view limit closes the link to new viewers', async () => {
      const { share: s } = await createShare(owner, { title: 'Limited', maxViews: 1 });
      const first = client();
      assert((await unlock(first, s.slug)).status === 200, 'the first viewer was blocked');
      assert((await first.fetch(`/api/s/${s.slug}/collection`)).status === 200, 'the counted viewer lost access');
      const second = await unlock(client(), s.slug);
      assert(second.status === 410, `expected 410 for the second viewer, got ${second.status}`);
    });

    await check('downloads are refused when the owner disallowed them', async () => {
      const viewer = client();
      await unlock(viewer, share.slug);
      const collection = (await viewer.fetch(`/api/s/${share.slug}/collection`)).json;
      const imageUrl = collection.items[0].images[0].url;
      const inline = await viewer.fetch(imageUrl);
      const download = await viewer.fetch(`${imageUrl}?download=1`);
      assert(inline.status === 200, `inline image failed: ${inline.status}`);
      assert(download.status === 403, `expected 403 for download, got ${download.status}`);
    });

    await check('uploaded files have no static URL', async () => {
      const res = await client().fetch('/data/uploads/');
      assert(res.status === 404, `uploads directory is reachable: ${res.status}`);
    });

    await check('a passcode under six characters is refused', async () => {
      const res = await owner.fetch('/api/shares', {
        method: 'POST',
        body: { title: 'Weak', artworkIds: [(await owner.fetch('/api/artworks')).json.artworks[0].id], passcode: 'abc' }
      });
      assert(res.status === 422, `expected 422, got ${res.status}`);
    });
  }

  await accountChecks();
  await imageChecks(owner);
  await salesChecks();
  await operationsChecks();
  await launchChecks();

  console.log(`\n${passed} checks passed, ${failures.length} failed.\n`);
  return failures.length === 0;
}

/* ---------- 3.0: Zoelae — account types, no pricing, a folder of photographs ---------- */
async function launchChecks() {
  console.log('\n12. Account types, no pricing, a folder of photographs');
  const sharp = require('sharp');
  // Earlier sections used up this connection's sign-ups for the hour; these arrive through the
  // trusted proxy from addresses of their own, as visitors behind a host's load balancer would.
  let n = 0;
  const fresh = () => ({ 'x-forwarded-for': `198.51.100.${++n}` });
  const signUp = (email, password = 'long-enough-pw', accountType = 'collector') => signUpAs(email, password, accountType, fresh());

  await check('sign-up without an account type is refused', async () => {
    const res = await client().fetch('/api/auth/signup', { method: 'POST', headers: fresh(), body: { email: newEmail('notype'), password: 'long-enough-pw', displayName: 'No Type' } });
    assert(res.status === 422 && res.json.error === 'invalid_account_type', `expected 422 invalid_account_type, got ${res.status} ${res.text}`);
  });

  await check('sign-up with an unknown account type is refused', async () => {
    const res = await client().fetch('/api/auth/signup', { method: 'POST', headers: fresh(), body: { email: newEmail('badtype'), password: 'long-enough-pw', displayName: 'Bad', accountType: 'museum' } });
    assert(res.status === 422, `expected 422, got ${res.status}`);
  });

  for (const type of ['collector', 'artist', 'gallery']) {
    await check(`${type === 'artist' ? 'an' : 'a'} ${type} account is created as ${type === 'artist' ? 'an' : 'a'} ${type}, with no plan`, async () => {
      const c = await signUp(newEmail(type), 'long-enough-pw', type);
      const me = (await c.fetch('/api/auth/me')).json.user;
      assert(me.accountType === type, `accountType is ${me.accountType}`);
      assert(!me.planTier, `planTier is ${me.planTier}`);
    });
  }

  await check('the front page names Zoelae, offers three account types and shows no prices', async () => {
    const res = await client().fetch('/');
    assert(res.status === 200, `front page answered ${res.status}`);
    assert(res.text.includes('Zoelae'), 'the name is missing');
    assert(!/ArtCave/i.test(res.text), 'the old name is still on the page');
    assert(!/€\s?\d|\/month|per month|href="\/plans"/i.test(res.text), 'a price or a plans link is still on the page');
    assert(res.text.includes('id="typeCards"'), 'the account types are missing');
  });

  await check('the old plans page sends visitors to the account types', async () => {
    const res = await fetch(BASE + '/plans', { redirect: 'manual' });
    assert(res.status === 301 && res.headers.get('location') === '/#accounts', `got ${res.status} ${res.headers.get('location')}`);
  });

  const owner = await signUp(newEmail('folder'));
  const other = await signUp(newEmail('folder-other'));
  const photo = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#8a3a2a' } })
    .jpeg().withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '38/1 42/1 0/1' } }).toBuffer();
  let draft;

  await check('a photograph from a folder becomes a work waiting for its details', async () => {
    const res = await multipartFiles(owner, '/api/artworks/drafts', { name: 'IMG_2041.JPG' }, [{ field: 'image', data: photo, type: 'image/jpeg', name: 'IMG_2041.JPG' }]);
    assert(res.status === 201, `draft upload answered ${res.status} ${JSON.stringify(res.json)}`);
    draft = res.json.artwork;
    assert(draft.needsDetails === true, 'needsDetails is not set');
    assert(draft.title === 'IMG 2041', `title is ${draft.title}`);
    assert(draft.artist === '', `artist is ${draft.artist}`);
    assert(draft.images.length === 1 && draft.images[0].thumbUrl, 'no image sizes');
  });

  await check('the folder photograph keeps no location data', async () => {
    const cookie = [...owner.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const buf = Buffer.from(await (await fetch(BASE + draft.images[0].originalUrl, { headers: { cookie } })).arrayBuffer());
    const meta = await sharp(buf).metadata();
    assert(!meta.exif, 'the stored original still has EXIF');
  });

  await check('a file that is not an image is refused', async () => {
    const res = await multipartFiles(owner, '/api/artworks/drafts', { name: 'notes.txt' }, [{ field: 'image', data: Buffer.from('hello'), type: 'text/plain', name: 'notes.txt' }]);
    assert(res.status === 422, `expected 422, got ${res.status}`);
  });

  await check('folder uploads need a signed-in account', async () => {
    const res = await multipartFiles(client(), '/api/artworks/drafts', {}, [{ field: 'image', data: photo, type: 'image/jpeg', name: 'a.jpg' }]);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check('saving details without an artist keeps the work waiting', async () => {
    const res = await owner.fetch(`/api/artworks/${draft.id}`, { method: 'PATCH', body: { title: 'Red Field' } });
    assert(res.status === 422, `expected 422, got ${res.status}`);
    const again = (await owner.fetch(`/api/artworks/${draft.id}`)).json.artwork;
    assert(again.needsDetails === true, 'the flag was cleared by a failed save');
  });

  await check('someone else cannot fill in another account’s work', async () => {
    const res = await other.fetch(`/api/artworks/${draft.id}`, { method: 'PATCH', body: { title: 'Mine now', artist: 'Thief' } });
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await check('saving a title and an artist completes the work', async () => {
    const res = await owner.fetch(`/api/artworks/${draft.id}`, { method: 'PATCH', body: { title: 'Red Field', artist: 'Ana Vale', year: '2019', medium: 'Oil on linen', status: 'for_sale', askingPrice: '9000' } });
    assert(res.status === 200, `save answered ${res.status} ${res.text}`);
    const w = res.json.artwork;
    assert(w.needsDetails === false && w.title === 'Red Field' && w.artist === 'Ana Vale' && w.askingPrice === 9000, JSON.stringify(w).slice(0, 200));
  });
}

const signUpAs = (...args) => signUp(...args);

/* ---------- 2.4: accounts ---------- */
const newEmail = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;

async function signUp(email, password = 'long-enough-pw', accountType = 'collector', headers = {}) {
  const c = client();
  const res = await c.fetch('/api/auth/signup', { method: 'POST', body: { email, password, displayName: 'Test Person', accountType }, headers });
  assert(res.status === 201, `sign-up failed: ${res.status} ${res.text}`);
  return c;
}

function latestMail(to) {
  if (!fs.existsSync(OUTBOX)) return null;
  const all = fs.readdirSync(OUTBOX).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')));
  return all.filter(m => m.to === to).pop() || null;
}

async function accountChecks() {
  console.log('\n8. Accounts: sign-in limits, password reset, signing out everywhere');

  await check('the sixth wrong password for an account is refused with 429, even when correct', async () => {
    const email = newEmail('limit');
    await signUp(email);
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await client().fetch('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password' } })).status);
    assert(codes.slice(0, 5).every(c => c === 401), `first five should be 401: ${codes}`);
    assert(codes[5] === 429, `sixth should be 429: ${codes}`);
    const right = await client().fetch('/api/auth/login', { method: 'POST', body: { email, password: 'long-enough-pw' } });
    assert(right.status === 429, `correct password during lockout should be 429, got ${right.status}`);
    assert(right.headers.get('retry-after'), 'no Retry-After header');
  });

  await check('a reset request answers the same for known and unknown addresses', async () => {
    const email = newEmail('known');
    await signUp(email);
    const known = await client().fetch('/api/auth/forgot', { method: 'POST', body: { email } });
    const unknown = await client().fetch('/api/auth/forgot', { method: 'POST', body: { email: newEmail('nobody') } });
    assert(known.status === 200 && unknown.status === 200, `statuses ${known.status} ${unknown.status}`);
    assert(known.json.message === unknown.json.message, 'the messages differ');
    assert(latestMail(email), 'no email was written for the known address');
  });

  await check('a reset link works once, signs out other sessions, and the old password stops working', async () => {
    const email = newEmail('reset');
    const first = await signUp(email);
    assert((await first.fetch('/api/auth/me')).status === 200, 'first session not signed in');
    await client().fetch('/api/auth/forgot', { method: 'POST', body: { email } });
    const mail = latestMail(email);
    const token = mail.text.match(/token=([\w-]+)/)[1];
    const stored = [DB_FILE, DB_FILE + '-wal'].filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f));
    assert(!stored.some(b => b.includes(token)), 'the raw reset token is stored in the database');
    const resetter = client();
    const done = await resetter.fetch('/api/auth/reset', { method: 'POST', body: { token, password: 'brand-new-pw' } });
    assert(done.status === 200, `reset failed: ${done.status} ${done.text}`);
    assert((await resetter.fetch('/api/auth/me')).status === 200, 'the reset did not sign in');
    assert((await first.fetch('/api/auth/me')).status === 401, 'the other session survived the reset');
    const again = await client().fetch('/api/auth/reset', { method: 'POST', body: { token, password: 'another-pw-1' } });
    assert(again.status === 410, `a used link should be 410, got ${again.status}`);
    const oldPw = await client().fetch('/api/auth/login', { method: 'POST', body: { email, password: 'long-enough-pw' } });
    assert(oldPw.status === 401, `old password should fail, got ${oldPw.status}`);
    assert(latestMail(email).subject.includes('changed'), 'no password-changed email');
  });

  await check('an expired reset link is refused', async () => {
    const email = newEmail('expired');
    await signUp(email);
    await client().fetch('/api/auth/forgot', { method: 'POST', body: { email } });
    const token = latestMail(email).text.match(/token=([\w-]+)/)[1];
    const db = new Database(DB_FILE);
    db.prepare("UPDATE password_resets SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    db.close();
    const res = await client().fetch('/api/auth/reset', { method: 'POST', body: { token, password: 'brand-new-pw' } });
    assert(res.status === 410, `expected 410, got ${res.status}`);
  });

  await check('reset links are built from PUBLIC_ORIGIN, not the Host header', async () => {
    const email = newEmail('host');
    await signUp(email);
    await client().fetch('/api/auth/forgot', { method: 'POST', body: { email }, headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
    assert(!latestMail(email).text.includes('evil.example'), 'the reset link used the request host');
  });

  await check('changing the password needs the current one and signs out other devices', async () => {
    const email = newEmail('change');
    const a = await signUp(email);
    const b = client();
    await b.fetch('/api/auth/login', { method: 'POST', body: { email, password: 'long-enough-pw' } });
    const wrong = await a.fetch('/api/auth/password', { method: 'POST', body: { currentPassword: 'nope-nope', newPassword: 'changed-pw-1' } });
    assert(wrong.status === 401, `wrong current password should be 401, got ${wrong.status}`);
    const ok = await a.fetch('/api/auth/password', { method: 'POST', body: { currentPassword: 'long-enough-pw', newPassword: 'changed-pw-1' } });
    assert(ok.status === 200, `change failed: ${ok.status}`);
    assert((await a.fetch('/api/auth/me')).status === 200, 'this device was signed out');
    assert((await b.fetch('/api/auth/me')).status === 401, 'the other device stayed signed in');
  });

  await check('a new account starts with nothing in it', async () => {
    const c = await signUp(newEmail('empty'));
    const res = await c.fetch('/api/artworks');
    assert(res.json.artworks.length === 0, 'a new account has artworks');
  });

  await check('there is no demo account', async () => {
    const res = await client().fetch('/api/auth/login', { method: 'POST', body: { email: 'demo@artcave.io', password: 'demo1234' } });
    assert(res.status === 401, `demo sign-in answered ${res.status}`);
  });
}

/* ---------- 2.4: images ---------- */
async function multipart(c, pathname, fields, files) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append(f.field, new Blob([f.data], { type: f.type }), f.name);
  const h = {};
  if (c.jar.size) h.cookie = [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(BASE + pathname, { method: 'POST', headers: h, body: fd });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const hasGpsTag = (exif) => !!exif && (exif.includes(Buffer.from([0x25, 0x88])) || exif.includes(Buffer.from([0x88, 0x25])));

async function imageChecks(owner) {
  console.log('\n9. Uploads: location data removed, sizes made, nothing executable');
  const sharp = require('sharp');
  const photo = await sharp({ create: { width: 3200, height: 2400, channels: 3, background: '#2b45c4' } })
    .jpeg().withExif({ IFD0: { Make: 'VerifyPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '38/1 42/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '9/1 8/1 0/1' } })
    .toBuffer();
  const c = await signUp(newEmail('images'));

  let artwork;
  await check('the test photo really carries GPS coordinates', async () => {
    assert(hasGpsTag((await sharp(photo).metadata()).exif), 'the fixture has no GPS tag, so the next check would prove nothing');
  });

  await check('an uploaded photo keeps no metadata in any of its sizes', async () => {
    const res = await multipart(c, '/api/artworks', { title: 'Located', artist: 'Someone' }, [{ field: 'images', data: photo, type: 'image/jpeg', name: 'p.jpg' }]);
    assert(res.status === 201, `upload failed: ${res.status}`);
    artwork = res.json.artwork;
    const img = artwork.images[0];
    for (const url of [img.thumbUrl, img.url, img.originalUrl]) {
      const r = await c.fetch(url);
      const buf = Buffer.from(await (await fetch(BASE + url, { headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } })).arrayBuffer());
      const meta = await sharp(buf).metadata();
      assert(r.status === 200, `${url} answered ${r.status}`);
      assert(!meta.exif && !hasGpsTag(meta.exif), `${url} still has EXIF`);
    }
  });

  await check('thumbnail and display copies are made at the right sizes', async () => {
    const img = artwork.images[0];
    const size = async (url) => sharp(Buffer.from(await (await fetch(BASE + url, { headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } })).arrayBuffer())).metadata();
    const [t, d, o] = await Promise.all([size(img.thumbUrl), size(img.url), size(img.originalUrl)]);
    assert(Math.max(t.width, t.height) === 480 && t.format === 'webp', `thumb ${t.width}x${t.height} ${t.format}`);
    assert(Math.max(d.width, d.height) === 1600 && d.format === 'webp', `display ${d.width}x${d.height} ${d.format}`);
    assert(o.width === 3200 && o.format === 'jpeg', `original ${o.width} ${o.format}`);
  });

  await check('a file that is not an image is refused with a clear message', async () => {
    const res = await multipart(c, '/api/artworks', { title: 'Fake', artist: 'Someone' }, [{ field: 'images', data: Buffer.from('<html><script>alert(1)</script>'), type: 'image/png', name: 'x.png' }]);
    assert(res.status === 422 && /image/i.test(res.json.message), `expected 422, got ${res.status}`);
    const list = await c.fetch('/api/artworks');
    assert(!list.json.artworks.some(a => a.title === 'Fake'), 'a half-saved work was left behind');
  });

  await check('an SVG upload is stored and served as a PNG', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><script>alert(1)</script><rect width="200" height="100" fill="red"/></svg>');
    const res = await multipart(c, '/api/artworks', { title: 'Vector', artist: 'Someone' }, [{ field: 'images', data: svg, type: 'image/svg+xml', name: 'v.svg' }]);
    assert(res.status === 201, `svg upload failed: ${res.status}`);
    const r = await c.fetch(res.json.artwork.images[0].originalUrl);
    assert(r.headers.get('content-type') === 'image/png', `served as ${r.headers.get('content-type')}`);
    assert(!r.text.includes('<script'), 'script survived');
  });

  await check('stored files are served with nosniff and a sandboxing policy', async () => {
    const r = await c.fetch(artwork.images[0].url);
    assert(r.headers.get('x-content-type-options') === 'nosniff', 'no nosniff');
    assert(/sandbox/.test(r.headers.get('content-security-policy') || ''), 'no sandbox CSP');
  });

  await check('deleting a work removes every size from disk', async () => {
    const db = new Database(DB_FILE, { readonly: true });
    const row = db.prepare('SELECT file_path, display_path, thumb_path FROM artwork_images WHERE public_id = ?').get(artwork.images[0].id);
    db.close();
    const files = Object.values(row).map(f => path.join(UPLOADS, f));
    assert(files.every(f => fs.existsSync(f)), 'not all sizes were on disk');
    await c.fetch(`/api/artworks/${artwork.id}`, { method: 'DELETE' });
    assert(files.every(f => !fs.existsSync(f)), 'a size was left on disk');
  });

  await check('the export includes a catalogue spreadsheet', async () => {
    const res = await owner.fetch('/api/account/export');
    assert(res.status === 200 && res.text.includes('catalogue.csv'), 'no catalogue.csv in the export');
  });
}

/* ---------- 2.5: status, spreadsheet import, clients ---------- */
async function multipartFiles(c, pathname, fields, files) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append(f.field, new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name);
  const h = {};
  if (c.jar.size) h.cookie = [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(BASE + pathname, { method: 'POST', headers: h, body: fd });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json };
}

async function salesChecks() {
  console.log('\n10. For sale, sold, spreadsheet import and clients');
  const sharp = require('sharp');
  const ExcelJS = require('exceljs');
  const { zipSync } = require('fflate');
  const gallery = await signUp(newEmail('gallery'));
  const rival = await signUp(newEmail('rival'));
  await gallery.fetch('/api/auth/me', { method: 'PATCH', body: { accountType: 'gallery' } });

  // a sheet with a title row, European prices, a sold work and a photo by file name
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Stock');
  ws.addRow(['Stock list']);
  ws.addRow(['Inv. No.', 'Artist', 'Title', 'Date', 'Medium', 'Retail price', 'Status', 'Image']);
  ws.addRow(['V-1', 'Ana Vale', 'Field I', 'c. 2019', 'Oil on linen', '€12.500', 'Available', 'v1.jpg']);
  ws.addRow(['V-2', 'Ana Vale', 'Field II', 2020, 'Oil on linen', '€9.800', 'Sold', '']);
  ws.addRow(['V-3', '', 'No artist', 2021, '', '', '', '']);
  const sheetBuf = Buffer.from(await wb.xlsx.writeBuffer());
  const photo = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#2b45c4' } })
    .jpeg().withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '38/1 42/1 0/1' } }).toBuffer();

  let imp;
  await check('a spreadsheet is read and its columns matched by name', async () => {
    const res = await multipartFiles(gallery, '/api/imports', { kind: 'artworks' }, [{ field: 'sheet', data: sheetBuf, name: 'stock.xlsx' }]);
    assert(res.status === 201, `upload ${res.status} ${JSON.stringify(res.json)}`);
    imp = res.json.import;
    assert(imp.rowCount === 3, `rows ${imp.rowCount}`);
    assert(JSON.stringify(imp.mapping) === JSON.stringify(['inventoryNumber', 'artist', 'title', 'year', 'medium', 'askingPrice', 'status', 'image']), `mapping ${imp.mapping}`);
  });

  await check('another account cannot see or run that import', async () => {
    const a = await rival.fetch(`/api/imports/${imp.id}/check`, { method: 'POST', body: { mapping: imp.mapping } });
    const b = await multipartFiles(rival, `/api/imports/${imp.id}/run`, { mapping: JSON.stringify(imp.mapping) }, []);
    assert(a.status === 404 && b.status === 404, `rival got ${a.status} / ${b.status}`);
  });

  await check('the check names the row that can’t be imported, by its spreadsheet row number', async () => {
    const r = await gallery.fetch(`/api/imports/${imp.id}/check`, { method: 'POST', body: { mapping: imp.mapping } });
    assert(r.json.ready === 2, `ready ${r.json.ready}`);
    assert(r.json.problems.length === 1 && r.json.problems[0].line === 5, JSON.stringify(r.json.problems));
  });

  let works;
  await check('importing creates the works, with photos from a zip, stripped of location', async () => {
    const zip = zipSync({ 'photos/v1.jpg': new Uint8Array(photo) });
    const run = await multipartFiles(gallery, `/api/imports/${imp.id}/run`, { mapping: JSON.stringify(imp.mapping) }, [{ field: 'photos', data: Buffer.from(zip), name: 'photos.zip' }]);
    assert(run.status === 202, `run ${run.status}`);
    let job;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 200));
      job = (await gallery.fetch(`/api/imports/${imp.id}`)).json.job;
      if (job && job.state !== 'running') break;
    }
    assert(job.state === 'done' && job.created === 2 && job.skipped.length === 1, JSON.stringify(job));
    works = (await gallery.fetch('/api/artworks')).json.artworks;
    const v1 = works.find(w => w.inventoryNumber === 'V-1');
    const v2 = works.find(w => w.inventoryNumber === 'V-2');
    assert(v1.status === 'for_sale' && v1.askingPrice === 12500 && v1.year === 2019 && v1.images.length === 1, JSON.stringify(v1));
    assert(v2.status === 'sold' && v2.soldPrice === 9800 && v2.images.length === 0, JSON.stringify(v2));
    const buf = Buffer.from(await (await fetch(BASE + v1.images[0].originalUrl, { headers: { cookie: [...gallery.jar].map(([k, v]) => `${k}=${v}`).join('; ') } })).arrayBuffer());
    assert(!(await sharp(buf).metadata()).exif, 'imported photo kept its EXIF');
  });

  await check('importing the same sheet again skips works already there', async () => {
    const res = await multipartFiles(gallery, '/api/imports', { kind: 'artworks' }, [{ field: 'sheet', data: sheetBuf, name: 'stock.xlsx' }]);
    const r = await gallery.fetch(`/api/imports/${res.json.import.id}/check`, { method: 'POST', body: { mapping: res.json.import.mapping } });
    assert(r.json.duplicates === 2, `duplicates ${r.json.duplicates}`);
  });

  await check('an old .xls file is refused with instructions', async () => {
    const res = await multipartFiles(gallery, '/api/imports', { kind: 'artworks' }, [{ field: 'sheet', data: Buffer.from('xx'), name: 'old.xls' }]);
    assert(res.status === 422 && /Save As|xlsx/i.test(res.json.message), `${res.status} ${res.json && res.json.message}`);
  });

  let client;
  await check('clients can be added, and a duplicate email is refused', async () => {
    const a = await gallery.fetch('/api/clients', { method: 'POST', body: { name: 'Rui Faria', email: 'rui@example.test' } });
    const b = await gallery.fetch('/api/clients', { method: 'POST', body: { name: 'Rui again', email: 'RUI@example.test' } });
    assert(a.status === 201 && b.status === 409, `${a.status} ${b.status}`);
    client = a.json.client;
  });

  await check('another account sees none of those clients and can’t open one', async () => {
    const list = await rival.fetch('/api/clients');
    const one = await rival.fetch(`/api/clients/${client.id}`);
    assert(list.json.clients.length === 0 && one.status === 404, `${list.json.clients.length} ${one.status}`);
  });

  await check('a sold work can name its buyer, but only from the owner’s own clients', async () => {
    const v1 = works.find(w => w.inventoryNumber === 'V-1');
    const theirs = await rival.fetch('/api/clients', { method: 'POST', body: { name: 'Rival client' } });
    const bad = await gallery.fetch(`/api/artworks/${v1.id}`, { method: 'PATCH', body: { status: 'sold', soldTo: theirs.json.client.id } });
    assert(bad.json.artwork.soldTo === null, 'another account’s client was accepted as buyer');
    const good = await gallery.fetch(`/api/artworks/${v1.id}`, { method: 'PATCH', body: { status: 'sold', soldPrice: '12000', soldTo: client.id } });
    assert(good.json.artwork.soldTo && good.json.artwork.soldTo.id === client.id, JSON.stringify(good.json.artwork.soldTo));
    assert(good.json.artwork.askingPrice === null, 'asking price kept after sale');
    const detail = await gallery.fetch(`/api/clients/${client.id}`);
    assert(detail.json.bought.length === 1, 'the purchase is not on the client');
  });

  await check('viewers see “sold” but never the sold price or the buyer', async () => {
    const ids = works.map(w => w.id);
    const sh = await gallery.fetch('/api/shares', { method: 'POST', body: { title: 'Sale', artworkIds: ids, passcode: 'correct-horse-42', showPrices: true } });
    const viewer = client2();
    await unlock(viewer, sh.json.share.slug);
    const res = await viewer.fetch(`/api/s/${sh.json.share.slug}/collection`);
    assert(res.json.items.every(i => i.availability === 'sold'), JSON.stringify(res.json.items.map(i => i.availability)));
    assert(!/Rui|soldPrice|sold_price|soldTo|12000|9800/.test(res.text), 'sale details reached the viewer');
  });

  await check('a PDF of chosen works is made, and only from the owner’s works', async () => {
    const ids = works.map(w => w.id).join(',');
    const own = await gallery.fetch(`/api/clients/send/preview.pdf?works=${ids}&prices=1`);
    const other = await rival.fetch(`/api/clients/send/preview.pdf?works=${ids}`);
    assert(own.status === 200 && own.text.startsWith('%PDF'), `own ${own.status}`);
    assert(other.status === 422, `rival got ${other.status}`);
  });

  await check('sending a PDF emails the client from the gallery, with replies to the gallery', async () => {
    const res = await gallery.fetch('/api/clients/send', { method: 'POST', body: {
      kind: 'pdf', clientIds: [client.id], artworkIds: works.map(w => w.id), subject: 'Two works', message: 'Dear {name}, here they are.'
    } });
    assert(res.status === 200 && res.json.sent === 1, `${res.status} ${JSON.stringify(res.json)}`);
    const mail = latestMail('rui@example.test');
    assert(mail && mail.attachments.length === 1 && mail.attachments[0].name.endsWith('.pdf'), 'no PDF attached');
    assert(/Dear Rui,/.test(mail.text), 'the {name} placeholder was not filled');
    assert(mail.replyTo && mail.replyTo.endsWith('@example.test') && /via Zoelae/.test(mail.from), `${mail.from} / ${mail.replyTo}`);
    const detail = await gallery.fetch(`/api/clients/${client.id}`);
    assert(detail.json.messages.length === 1, 'the send was not recorded');
  });

  await check('nobody can send another account’s link or works, or to another account’s clients', async () => {
    const sh = (await gallery.fetch('/api/shares')).json.shares[0];
    const theirClient = (await rival.fetch('/api/clients')).json.clients[0];
    const a = await rival.fetch('/api/clients/send', { method: 'POST', body: { kind: 'link', clientIds: [theirClient.id], shareSlug: sh.slug, subject: 'x' } });
    const b = await rival.fetch('/api/clients/send', { method: 'POST', body: { kind: 'pdf', clientIds: [theirClient.id], artworkIds: works.map(w => w.id), subject: 'x' } });
    const c = await rival.fetch('/api/clients/send', { method: 'POST', body: { kind: 'pdf', clientIds: [client.id], artworkIds: [], subject: 'x' } });
    assert(a.status === 422 && b.status === 422 && [404, 422].includes(c.status), `${a.status} ${b.status} ${c.status}`);
  });

  await check('client emails are limited per day', async () => {
    const db = new Database(DB_FILE);
    const owner = db.prepare('SELECT id FROM clients WHERE public_id = ?').get(client.id);
    const row = db.prepare('SELECT owner_id FROM clients WHERE public_id = ?').get(client.id);
    const ins = db.prepare(`INSERT INTO client_messages (public_id, owner_id, client_id, kind, subject, delivery, created_at) VALUES (?, ?, ?, 'pdf', 'x', 'outbox', ?)`);
    for (let i = 0; i < 100; i++) ins.run(`msg_fill${i}`, row.owner_id, owner.id, new Date().toISOString());
    db.close();
    const res = await gallery.fetch('/api/clients/send', { method: 'POST', body: { kind: 'pdf', clientIds: [client.id], artworkIds: [works[0].id], subject: 'x' } });
    assert(res.status === 429, `expected 429, got ${res.status}`);
  });

  await check('the export includes the client list', async () => {
    const res = await gallery.fetch('/api/account/export');
    assert(res.text.includes('clients.csv') && res.text.includes('rui@example.test'), 'clients missing from export');
  });
}

const client2 = () => client();

/* ---------- 2.4: operations ---------- */
async function operationsChecks() {
  console.log('\n11. Operations: health check and production guards');
  const prod = { ...env, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://example.test' };
  const runs = (script, extra = {}, args = []) => {
    try { execFileSync(process.execPath, [script, ...args], { cwd: ROOT, env: { ...prod, ...extra }, stdio: 'pipe' }); return 0; }
    catch (e) { return e.status; }
  };

  await check('/healthz answers ok', async () => {
    const r = await client().fetch('/healthz');
    assert(r.status === 200 && r.json.ok === true, `healthz ${r.status} ${r.text}`);
  });

  await check('npm run reset refuses in production', () => {
    assert(runs('server/reset.js', {}, ['--yes']) === 1, 'reset ran in production');
    assert(fs.existsSync(DB_FILE), 'the database was deleted');
  });

  await check('npm run reset refuses to delete accounts without --yes', () => {
    assert(runs('server/reset.js', { NODE_ENV: 'test' }) === 1, 'reset ran without --yes');
    assert(fs.existsSync(DB_FILE), 'the database was deleted');
  });

  await check('test fixtures refuse to load in production', () => {
    assert(runs('test/fixtures.js') === 1, 'fixtures ran in production');
  });

  await check('the server refuses to start in production without real secrets', () => {
    const code = runs('server/index.js', { SESSION_SECRET: '', IP_HASH_SALT: '', PORT: '3998' });
    assert(code !== 0, 'the server started with development secrets');
  });

  await check('in production the outbox page does not exist and health still answers', async () => {
    const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...prod, PORT: '3997' }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('production server did not start')), 15000);
        proc.stdout.on('data', d => { if (String(d).includes('running at')) { clearTimeout(t); resolve(); } });
      });
      const outbox = await fetch('http://127.0.0.1:3997/dev/outbox');
      const health = await fetch('http://127.0.0.1:3997/healthz');
      assert(outbox.status === 404, `outbox answered ${outbox.status} in production`);
      assert(health.status === 200, `healthz answered ${health.status}`);
    } finally { proc.kill(); }
  });

  await check('a backup copies the database and the uploads', () => {
    const dir = path.join(ROOT, 'data', 'verify-backups');
    fs.rmSync(dir, { recursive: true, force: true });
    execFileSync(process.execPath, ['server/backup.js'], { cwd: ROOT, env: { ...env, BACKUP_DIR: dir }, stdio: 'pipe' });
    const made = fs.readdirSync(dir);
    assert(made.length === 1, `expected one backup, found ${made.length}`);
    const inside = fs.readdirSync(path.join(dir, made[0]));
    assert(inside.includes('zoelae.db') && inside.includes('uploads') && inside.includes('backup.json'), `backup holds ${inside}`);
    const copy = new Database(path.join(dir, made[0], 'zoelae.db'), { readonly: true });
    const n = copy.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    copy.close();
    fs.rmSync(dir, { recursive: true, force: true });
    assert(n > 0, 'the copied database is empty');
  });
}

(async () => {
  reset();
  const server = await startServer();
  let ok = false;
  try {
    ok = await run();
  } catch (err) {
    console.error('\nSuite aborted:', err);
  } finally {
    server.kill();
  }
  process.exit(ok ? 0 : 1);
})();
