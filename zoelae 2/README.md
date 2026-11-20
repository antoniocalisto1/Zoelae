# Zoelae

**Build 3.0.2 — `zoelae-v3.0.2-launch`.** The launch build, packed into 97 files so the whole site can be dragged onto GitHub's website in one upload (GitHub's limit is 100 per upload). 3.0.2 changes no behaviour: four stylesheets instead of ten, three variable font files instead of eighteen, and unused sample images removed.

- **The name is Zoelae** (`SITE_NAME`, default `Zoelae`), at zoelae.com.
- **The Atelier design** on every page: warm white walls, near-black ink, hairline rules, square
  corners, Cormorant Garamond with Inter (both served from this site). The app has a side menu; the
  collection is a wall of works with a strip of figures, filter chips and a red dot on what has sold.
- **Free, with no pricing.** There is no plans page (`/plans` redirects to the account types). Sign-up
  asks for an **account type** — collector, artist or gallery — and refuses without one.
- **A folder of photographs.** Choose or drag in a folder (sub-folders included); every image
  becomes a work *waiting for its details*. Then a describer steps through them one by one: the
  photograph beside the fields, "Save and next", "Same as the last one", skip, remove. Anything
  skipped waits in the collection behind a "Describe them" banner.

2.5 (still included): in the collection / for sale / sold, spreadsheet import with photos, clients
and emailing links or PDFs. 2.4: sign-in limits, password reset, cleaned and resized uploads,
backups, a health check.

A private catalogue for art. Each person logs the pieces they make, own or place (images, title,
artist, year, medium, dimensions, prices, valuations, certificates, provenance, location) and can
share a chosen selection behind a passcode, deciding field by field what a viewer may see.

Plain Node, Express, SQLite and vanilla ES modules. No framework, no UI library, no build step.

## Running it on your computer

```bash
npm install
npm start           # http://localhost:3000 — migrations run on their own
```

The site starts empty. Create the first account at <http://localhost:3000/app?mode=signup>.

Emails are not sent from your computer. Password-reset and password-changed emails are written to
`data/outbox/` and can be read at <http://localhost:3000/dev/outbox> (only when not in production).

| script | what it does |
| --- | --- |
| `npm start` | applies pending migrations, then serves the site |
| `npm run migrate` | applies pending migrations without starting |
| `npm run backup` | copies the database and every uploaded file into a dated folder |
| `npm run reset` | deletes the local database, uploads and outbox. Refuses in production; asks for `-- --yes` if accounts exist |
| `npm run import -- …` | bulk-imports folders of images as artworks (see below) |
| `npm run verify` | the security suite, against its own throwaway database on port 3999 |
| `npm run live` | the browser walk-through as a brand-new visitor (Playwright) |

### Importing folders of images

One artwork per image, with the folder's name as the artist:

```bash
npm run import -- --name "Your Name" --email you@example.com --password "a-password" \
  ~/Downloads/Yunizar "~/Downloads/Georgina Gratrix"
```

The account is created if it doesn't exist. Images go through the same pipeline as uploads (turned
upright, location data removed, thumbnail and display copies made). Where a filename carries
catalogue data (`YUN199, Yunizar, Benda-Benda, 2020, acrylic on canvas, 200 x 150cm.jpg`) the title,
year, medium and dimensions are read from it. A PDF whose filename starts with the same reference as
an image is attached to that piece. `--dry-run`, `--fresh` and `--type` work as before.

## Putting it online

Everything is configured with environment variables. With `NODE_ENV=production` the server refuses
to start until the first three are real.

| variable | what it is |
| --- | --- |
| `SESSION_SECRET` | signs session cookies. 32+ random bytes: `openssl rand -hex 32` |
| `IP_HASH_SALT` | salts the hash of viewer addresses in the access log. Another random string |
| `PUBLIC_ORIGIN` | the site's address: `https://zoelae.com`. Reset links are built from this, never from the request |
| `DATABASE_FILE` | where the SQLite file lives. On a host, a path on a persistent volume, e.g. `/data/zoelae.db` |
| `UPLOADS_DIR` | where images and documents live. Same volume, e.g. `/data/uploads` |
| `POSTMARK_SERVER_TOKEN` | turns on real email through Postmark. Without it, emails go to the outbox folder and nobody receives them |
| `MAIL_FROM` | the sender, e.g. `Zoelae <hello@zoelae.com>`. Must be a sender confirmed in Postmark |
| `BACKUP_DIR`, `BACKUP_KEEP` | where `npm run backup` writes, and how many to keep (14) |
| `SITE_NAME`, `SITE_PLACE` | the name and town shown everywhere, including emails. Renaming is this one setting |
| `BILLING` | leave unset: everything is free. The dormant billing code only wakes with `on` |
| `IMPORT_DIR`, `IMPORT_ZIP_MAX_MB` | where uploaded sheets wait while columns are matched (deleted after a day), and the largest photo zip (300) |
| `CLIENT_MAIL_PER_DAY` | emails one account can send to its clients in a day (100) |

On a host with a persistent volume (Railway, Render, Fly), mount one volume and point
`DATABASE_FILE`, `UPLOADS_DIR`, `OUTBOX_DIR` and `BACKUP_DIR` into it. Use `/healthz` as the health
check: it answers `{"ok":true}` when the database is reachable and 503 when it isn't. Run
`npm run backup` on a daily schedule and copy the newest folder off the host now and then; a backup
on the same disk protects against mistakes, not against losing the disk.

To restore a backup: stop the server, copy `zoelae.db` over `DATABASE_FILE` and `uploads/` over
`UPLOADS_DIR`, start again.

## Accounts

- **Sign-up** asks for a name, email and a password of at least 8 characters. Ten new accounts per
  connection per hour.
- **Sign-in** allows five wrong passwords per account in 15 minutes, and twenty per connection
  across accounts, then answers 429 with a wait time. A correct password resets the account's count.
- **Password reset.** `/app?mode=forgot` sends a single-use link valid for an hour. Only a SHA-256
  of the token is stored. The answer is identical whether or not the address has an account. Using
  the link sets the password, retires any other outstanding links, emails a "password changed"
  notice and signs the person in.
- **Signing out everywhere.** Sessions are signed tokens carrying the account's `session_version`.
  Resetting or changing the password bumps the version, so every other device's cookie stops
  working on its next request.
- **Account settings** (avatar menu): change name, change password.
- **Export and delete** (avatar menu): a zip with every record, every image at full size, every
  document and a `catalogue.csv`; or delete the account and every file on disk.

These limits live in `server/config.js` (`accountLimits`). They are in memory, which is right for
one server process.

## For sale, sold, and the client list (2.5)

**Status.** Every work is *In the collection*, *For sale* (with an asking price) or *Sold* (with the
price, the date and, optionally, the buyer from the client list). The collection page has a tab for
each, and a red dot marks a sold work, as on a gallery wall. Galleries and artists see "For sale"
and "Sold" totals instead of spend and valuation. Viewers of a shared link see *Available* (with the
asking price only if the link shows prices) or *Sold*; the sold price and the buyer never leave the
owner's account. Every work can also carry an inventory number.

**Spreadsheet import** (`server/lib/sheetImport.js`, `server/routes/imports.js`, `public/js/importer.js`).
*Collection → Import from a spreadsheet.* Accepts .xlsx and CSV (comma, semicolon or tab; UTF-8 or
Windows-1252), up to 2,000 rows. It finds the heading row even under a title, matches columns by
name in English, Portuguese, French and Spanish, and shows the match with sample values so it can be
corrected. Values are read forgivingly: `€12.400,50`, `R 85,000`, `c. 1975`, `NFS`, real Excel dates.
The type is guessed from the medium when there's no type column. Photos come as files or a zip
(up to 300 MB, `IMPORT_ZIP_MAX_MB`), matched by the file name in an image column, or by inventory
number or title; pictures placed inside the Excel sheet are used when nothing else matches. Every
photo goes through the normal pipeline (location data removed, sizes made). Rows without a photo
come in marked "No image yet". Works already in the account (same inventory number, or same title
and artist) are skipped unless you say otherwise. A template is at `/api/imports/template.xlsx`.
Clients import the same way.

**Clients** (`server/routes/clients.js`, `public/js/clients.js`). For accounts set to Gallery or
Artist (*Account settings → What you do with art*). Name, email, phone, company, city, country,
interests, notes; search; import; what each client has bought and everything sent to them.

**Sending** (`public/js/sendModal.js`, `server/lib/pdfSelection.js`). From the client list, a
client, a work or a shared link: email one or more clients either a shared link (optionally with
its passcode, typed in, since passcodes are stored hashed) or a PDF of chosen works, one to a page,
with availability and, if chosen, asking prices. `{name}` in the message becomes each client's first
name. Mail goes from the site's address as "*Gallery name* via Zoelae", with Reply-To set to the
gallery, so replies reach them directly. Limits: 25 recipients per send, 100 emails per account per
day (`CLIENT_MAIL_PER_DAY`). Every send is logged on the client. The export includes `clients.csv`.

## Images

Every image passes through `server/lib/images.js` before it is stored:

- decoded by `sharp`, so anything that isn't really an image is refused with a clear message;
- turned upright from the phone's orientation flag, then re-encoded, which drops all metadata —
  GPS coordinates, camera, dates. A photo of a painting at home often carries the home's location;
- SVG is rasterised to PNG (an SVG served from our own origin could carry script);
- three copies: the original (JPEG/WebP/PNG, capped at 6000 px), a 1600 px display copy and a 480 px
  thumbnail, both WebP. The grid loads thumbnails, detail pages the display copy, and the original
  leaves only through the owner's export or a permitted download on a shared link.

Images attached as documents are cleaned the same way; PDFs are stored as uploaded. Every file is
served with `nosniff` and a sandboxing Content-Security-Policy. Images uploaded before 2.4 get their
smaller copies made in the background the first time the server starts.

## How the sharing model works

A shared collection is a slug, a bcrypt passcode hash, a list of artworks and five booleans.

**The slug** is 28 characters from `crypto.randomBytes` over a 56-character alphabet — about 162
bits. It is the only public handle; internal row ids never leave the server.

**The gate.** `GET /api/s/:slug/meta` returns the title and the owner's display name and nothing
else — not the item count, not a thumbnail. Everything else requires a session, which is only
issued by `POST /api/s/:slug/unlock` after the passcode verifies. `share.html` is a static shell,
so there is no server-rendered data to read from the page source either.

**Sessions** are HMAC-signed tokens in an httpOnly cookie, valid for two hours, carrying the slug,
the share's row id and the view number they were issued against. A session for one collection is
worthless on another. Expiry is checked against the server clock only.

**Every data endpoint re-verifies** — slug resolves, not revoked, not expired, view allowance not
exceeded, session matches this slug and this row — by re-reading the row on each request. Revoking
a link therefore cuts off viewers who are already inside, on their next request.

**Visibility.** Gated fields are assembled in `server/lib/serialize.js`, field by field. When a
toggle is off, the field is *absent* from the JSON — not null, not empty. The viewer client is told
one thing about permissions, `downloads`, and infers the rest from what arrived; that way no
response carries even the name of a field the collector didn't permit.

**Files** are written outside `public/`, have no static URL, and are streamed only through routes
that have already checked ownership or viewer permission. With downloads off, `?download=1` is
refused server-side; the page additionally blocks right-click and drag, which is a courtesy
deterrent and nothing more.

**Rate limiting** allows 5 passcode attempts per IP per link, then locks that pair out for 15
minutes — the correct passcode included. Every attempt, successful or not, is written to
`shared_collection_access_log` with a salted SHA-256 of the IP; raw addresses are never stored.

## Reports

Two PDFs generated on the server from the collection, with images embedded: an **insurance
schedule** and an **estate inventory**. Both are free to everyone and no price is shown. With `BILLING=on`
they become included on Normal and Pro and priced as one-offs (€60, €90) on other plans; at that
point the confirmation step in `public/js/reports.js` must be replaced with a real checkout
(`server/routes/exports.js` is the only server file that changes). Rules and prices:
`server/lib/entitlements.js`.

## The look: Atelier

Four stylesheets. `public/css/tokens.css` holds the palette, the self-hosted fonts and the shared
materials (square ink buttons, hairline cards, small-caps labels, the wall label, the spaced-capitals
wordmark; the class names still start `pv-` from the earlier design). `site.css` is the public pages
(front page, privacy, terms, 404). `app.css` is the signed-in app in three parts: base layout and
components, the importer/clients/sending components, then the Atelier finish. The viewer loads
`app.css` plus `share.css`. Emails and PDFs use the same palette with Georgia/Times.

Fonts: three variable files in `public/fonts/` (Cormorant Garamond upright and italic, weights
300–500; Inter, 400–600), subset to Latin and Latin Extended. Licences in `public/fonts/LICENSES.txt`.

The sample artworks on the public pages (`public/img/examples/`) are invented and say so: each
carries an "Example" label and the page says nobody's collection is shown.

Pages: `/` front door, `/privacy` and `/terms` (drafts, marked as needing legal review),
`/app` (sign in, sign up, forgot password and the app), `/reset?token=…`, `/s/:slug` (the viewer),
and a 404. `/plans` redirects to `/#accounts`. Page shells are served through `server/index.js`,
which fills in `{{SITE}}` and `{{PLACE}}`.

## A folder of photographs

`public/js/folderUpload.js`. The browser reads the folder (an `<input webkitdirectory>` or a drop,
walked recursively), keeps JPEG/PNG/WebP/GIF/SVG under 25 MB (300 at a time), and posts each image
on its own to `POST /api/artworks/drafts` three at a time. The server cleans and resizes it like any
upload and creates a work with a provisional title from the file name, an empty artist and
`needs_details = 1` (migration 008). Saving the work's details through the usual
`PATCH /api/artworks/:id`, which requires a title and an artist, clears the flag. An account can
hold at most 2,000 works waiting at once.

## Layout

```
migrations/           001 … 008, plain SQL, applied in filename order
server/
  index.js            app, routes, pages, health check, dev outbox
  config.js           every setting in one place
  db.js migrate.js reset.js backup.js import-folder.js
  lib/                images, mailer, emails, throttle, sessions, passcodes, serialize, uploads, …
  middleware/         collectorAuth, viewerAccess, rateLimit
  routes/             auth, artworks, media, summary, shares, sharePublic, exports, account
public/
  landing.html privacy.html terms.html 404.html
  index.html          the app shell, including the sign-in door
  share.html          viewer shell, ships no collection data
  css/                tokens (palette, fonts, materials), site, app, share
  js/                 ES modules, one per screen; brand.js holds the name, account types, wordmark
  img/examples/       the invented sample plates used on public pages
  fonts/              Cormorant Garamond and Inter, variable (SIL Open Font License)
test/
  verify.js           security suite
  live.js             new-visitor walk-through in a real browser
  fixtures.js         test data and placeholder plates for verify.js only (refuses to run in production)
data/                 database, uploads, outbox, backups (never served)
```

## Verification

`npm run verify` runs the security suite against a throwaway database: the sharing guarantees
(no data before the passcode, hidden fields absent, revocation and expiry immediate, cross-owner
checks, passcode lockout), plus sign-in limits, password reset, session versioning, image metadata
stripping and the production guards.

`npm run live` starts a fresh server with an empty database and walks through the site as a new
visitor in Chromium: landing page, sign-up, first upload, sharing, the viewer, password reset via
the outbox, and every page at desktop and phone width.

## Before opening to the public

- Point a domain at the host and set `PUBLIC_ORIGIN`.
- Create a Postmark server, confirm the sending domain, set `POSTMARK_SERVER_TOKEN` and `MAIL_FROM`.
- Have the privacy notice and terms reviewed and fill in the highlighted placeholders.
- Schedule `npm run backup` and keep a copy off the host.
- Replace the "Who's behind it" paragraph on the landing page with your own words.
