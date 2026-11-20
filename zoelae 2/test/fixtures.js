'use strict';
// Test fixtures, used by `npm run verify` against its own throwaway database. Never part of the site.
//
//   owner@fixture.test / fixture-owner-pw  — 36 works, two shared links
//   other@fixture.test / fixture-other-pw  — 1 work (so cross-owner checks have a subject)
//
// Refuses to run in production, and refuses to touch a database that holds anyone else's account.

const config = require('./../server/config');
if (config.isProd) {
  console.error('Refusing to load test fixtures: NODE_ENV is production.');
  process.exit(1);
}

const { db, migrate } = require('./../server/db');
const tokens = require('./../server/lib/tokens');
const passcodes = require('./../server/lib/passcodes');
const uploads = require('./../server/lib/uploads');
const { storeImage } = require('./../server/lib/images');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

/* ---------- placeholder plates (formerly fixtures/art.js) ---------- */
// Placeholder artwork plates, generated as SVG so the seed needs no binary assets and no network.
// Ported from the v1 prototype; the twelve kinds are the same.

function svgArt(kind, colors) {
  const [a, b, d, e] = colors;
  const shapes = {
    bands: `<rect width="800" height="600" fill="${a}"/>
      <rect y="90" width="800" height="120" fill="${b}"/>
      <rect y="300" width="800" height="70" fill="${d}"/>
      <rect y="430" width="800" height="150" fill="${e}" opacity=".85"/>`,
    circles: `<rect width="800" height="600" fill="${a}"/>
      <circle cx="290" cy="250" r="165" fill="${b}"/>
      <circle cx="520" cy="370" r="120" fill="${d}" opacity=".82"/>
      <circle cx="620" cy="150" r="62" fill="${e}"/>`,
    grid: `<rect width="800" height="600" fill="${a}"/>
      <rect x="70" y="70" width="290" height="200" fill="${b}"/>
      <rect x="400" y="70" width="330" height="90" fill="${d}"/>
      <rect x="400" y="195" width="330" height="335" fill="${e}" opacity=".9"/>
      <rect x="70" y="310" width="290" height="220" fill="${d}" opacity=".7"/>`,
    wash: `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${b}"/><stop offset=".55" stop-color="${d}"/><stop offset="1" stop-color="${e}"/>
      </linearGradient></defs>
      <rect width="800" height="600" fill="${a}"/>
      <rect width="800" height="600" fill="url(#g)" opacity=".9"/>
      <circle cx="600" cy="180" r="230" fill="${a}" opacity=".18"/>`,
    lines: `<rect width="800" height="600" fill="${a}"/>
      <g stroke="${b}" stroke-width="9" stroke-linecap="round">
        <path d="M90 500 L300 110"/><path d="M200 520 L430 90"/><path d="M330 530 L560 130"/>
      </g>
      <g stroke="${d}" stroke-width="16" stroke-linecap="round"><path d="M470 520 L700 160"/></g>
      <circle cx="640" cy="440" r="70" fill="${e}"/>`,
    arch: `<rect width="800" height="600" fill="${a}"/>
      <path d="M180 520 V300 a140 140 0 0 1 280 0 V520 Z" fill="${b}"/>
      <path d="M470 520 V380 a90 90 0 0 1 180 0 V520 Z" fill="${d}"/>
      <rect x="60" y="520" width="700" height="26" fill="${e}"/>`,
    dots: `<rect width="800" height="600" fill="${a}"/>
      <g fill="${b}"><circle cx="150" cy="150" r="46"/><circle cx="330" cy="220" r="70"/><circle cx="560" cy="130" r="34"/></g>
      <g fill="${d}" opacity=".85"><circle cx="230" cy="410" r="88"/><circle cx="640" cy="330" r="56"/></g>
      <g fill="${e}"><circle cx="470" cy="470" r="62"/><circle cx="690" cy="500" r="30"/></g>`,
    wave: `<rect width="800" height="600" fill="${a}"/>
      <path d="M0 380 C160 300 260 460 400 380 S640 300 800 370 V600 H0 Z" fill="${b}"/>
      <path d="M0 450 C180 390 280 530 430 450 S660 390 800 450 V600 H0 Z" fill="${d}" opacity=".9"/>
      <circle cx="600" cy="170" r="78" fill="${e}"/>`,
    split: `<rect width="800" height="600" fill="${a}"/>
      <rect width="400" height="600" fill="${b}"/>
      <rect x="400" width="400" height="300" fill="${d}"/>
      <rect x="400" y="300" width="400" height="300" fill="${e}"/>
      <rect x="370" width="60" height="600" fill="${a}" opacity=".55"/>`,
    halo: `<rect width="800" height="600" fill="${a}"/>
      <circle cx="400" cy="300" r="215" fill="none" stroke="${b}" stroke-width="46"/>
      <circle cx="400" cy="300" r="118" fill="${d}"/>
      <rect x="0" y="285" width="800" height="30" fill="${e}" opacity=".8"/>`,
    hatch: `<rect width="800" height="600" fill="${a}"/>
      <g stroke="${b}" stroke-width="4" opacity=".85">
        ${Array.from({ length: 16 }, (_, i) => `<path d="M${60 + i * 45} 90 V510"/>`).join('')}
      </g>
      <g stroke="${d}" stroke-width="5" opacity=".8">
        ${Array.from({ length: 8 }, (_, i) => `<path d="M60 ${120 + i * 50} H740"/>`).join('')}
      </g>
      <rect x="300" y="230" width="200" height="150" fill="${e}"/>`,
    panels: `<rect width="800" height="600" fill="${a}"/>
      <rect x="60" y="60" width="200" height="480" fill="${b}"/>
      <rect x="290" y="60" width="200" height="480" fill="${d}"/>
      <rect x="520" y="60" width="220" height="480" fill="${e}"/>
      <rect x="290" y="230" width="200" height="140" fill="${a}" opacity=".75"/>`,

    // sculpture plates — an object lit against a studio wall
    plinth: `<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${e}"/></linearGradient></defs>
      <rect width="800" height="600" fill="url(#w)"/>
      <ellipse cx="400" cy="520" rx="185" ry="26" fill="${d}" opacity=".22"/>
      <rect x="330" y="360" width="140" height="150" fill="#f2f0ec"/>
      <path d="M360 360 L400 170 L440 360 Z" fill="${b}"/>
      <circle cx="400" cy="170" r="42" fill="${d}"/>`,
    bronze: `<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${e}"/></linearGradient></defs>
      <rect width="800" height="600" fill="url(#w)"/>
      <ellipse cx="400" cy="518" rx="150" ry="24" fill="${d}" opacity=".25"/>
      <path d="M368 500 C352 420 384 382 374 322 C366 272 394 242 384 194 C377 160 396 138 415 138 C434 138 451 160 444 194 C434 242 462 272 454 322 C444 382 476 420 460 500 Z" fill="${b}"/>
      <circle cx="414" cy="112" r="27" fill="${b}"/>
      <path d="M414 138 C434 138 451 160 444 194 C434 242 462 272 454 322 C444 382 476 420 460 500 L414 500 Z" fill="${d}" opacity=".3"/>
      <rect x="342" y="498" width="145" height="22" rx="4" fill="${d}"/>`,
    torso: `<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${e}"/></linearGradient></defs>
      <rect width="800" height="600" fill="url(#w)"/>
      <ellipse cx="400" cy="524" rx="150" ry="24" fill="${d}" opacity=".25"/>
      <rect x="320" y="486" width="160" height="34" rx="3" fill="${d}" opacity=".45"/>
      <path d="M330 205 C330 175 356 158 400 158 C444 158 470 175 470 205 C470 252 448 286 448 322 C448 362 470 402 468 452 C466 478 440 486 400 486 C360 486 334 478 332 452 C330 402 352 362 352 322 C352 286 330 252 330 205 Z" fill="${b}"/>
      <path d="M400 158 C444 158 470 175 470 205 C470 252 448 286 448 322 C448 362 470 402 468 452 C466 478 440 486 400 486 Z" fill="${d}" opacity=".28"/>
      <path d="M400 200 V470" stroke="${d}" stroke-width="3" opacity=".25" fill="none"/>`,
    mobile: `<rect width="800" height="600" fill="${a}"/>
      <g stroke="${d}" stroke-width="4" fill="none">
        <path d="M400 40 V110"/><path d="M180 110 H620"/><path d="M180 110 V190"/><path d="M620 110 V160"/>
        <path d="M120 190 H300"/><path d="M120 190 V260"/><path d="M300 190 V300"/>
      </g>
      <circle cx="120" cy="285" r="42" fill="${b}"/>
      <circle cx="300" cy="330" r="58" fill="${e}"/>
      <path d="M580 160 L680 160 L630 250 Z" fill="${b}"/>
      <rect x="360" y="110" width="80" height="80" fill="${d}" opacity=".5"/>`,
    vessel: `<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${e}"/></linearGradient></defs>
      <rect width="800" height="600" fill="url(#w)"/>
      <ellipse cx="400" cy="512" rx="145" ry="24" fill="${d}" opacity=".22"/>
      <path d="M330 200 C300 300 290 430 355 500 L445 500 C510 430 500 300 470 200 Z" fill="${b}"/>
      <ellipse cx="400" cy="200" rx="70" ry="20" fill="${d}"/>
      <path d="M470 260 C540 270 545 380 480 400" stroke="${b}" stroke-width="20" fill="none"/>`,
    monolith: `<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${e}"/></linearGradient></defs>
      <rect width="800" height="600" fill="url(#w)"/>
      <ellipse cx="400" cy="514" rx="170" ry="26" fill="${d}" opacity=".2"/>
      <path d="M320 505 L345 120 L470 120 L490 505 Z" fill="${b}"/>
      <circle cx="405" cy="250" r="46" fill="${a}"/>
      <path d="M345 120 L470 120 L480 320 L338 320 Z" fill="${d}" opacity=".25"/>`
  };

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">${shapes[kind]}</svg>`;
}

/**
 * A second and third plate for a piece, so the viewer's carousel has something to page through.
 * Detail shots reuse the palette with the accents rotated.
 */
function variantColors(colors, step) {
  const rotated = colors.slice(1).concat(colors.slice(1, 2));
  return step === 1 ? [colors[0], rotated[1], rotated[0], colors[3]] : [colors[3], colors[2], colors[1], colors[0]];
}

/* ---------- the fixture collection (formerly fixtures/works.js) ---------- */
// The fixture collection: 36 pieces across 16 artists, carried over from the v1 prototype and
// extended with the valuation, provenance, location and document fields v2 added.
//
// W(title, artist, year, type, price, medium, dimensions, acquired, notes, [artKind, palette], extra)

const W = (title, artist, year, type, price, medium, dimensions, acquired, notes, art, extra = {}) => ({
  title, artist, year, type, price, medium, dimensions, acquired, notes, art, ...extra
});

const LOCATIONS = [
  'Drawing room — north wall',
  'Study — above the desk',
  'Hallway, first floor',
  'Crozier vault, Lisbon — rack 14',
  'Dining room — east wall',
  'Storage unit B2 — climate controlled',
  'Guest bedroom',
  'Garden terrace'
];

const demoWorks = [
  /* ---------- paintings ---------- */
  W('Harbour Light, No. 4', 'Mira Oduya', 1978, 'Painting', 12400, 'Oil on canvas', '120 × 90 cm', '2019-05-12',
    'Bought at the Lisbon estate sale. Small restoration to the lower-left corner in 2021.',
    ['bands', ['#f2ede4', '#2f5d7c', '#c8623a', '#e3c98f']],
    {
      valuation: 19500, valuationDate: '2025-03-04', acquiredFrom: 'Cabral Moncada Leilões, Lisbon',
      provenance: 'Painted in Lagos, 1978. Held by the artist until 1984, then by the Ferreira family until the 2019 estate sale.',
      priorOwners: 'The artist; Joaquim Ferreira; Ferreira family estate',
      exhibitions: 'Museu do Chiado, “Atlantic Light”, 2005 (cat. no. 31)',
      location: LOCATIONS[0], extraImages: 2,
      docs: [{ kind: 'certificate', label: 'Certificate of authenticity — Oduya Estate' },
             { kind: 'invoice', label: 'Auction invoice, May 2019' },
             { kind: 'condition_report', label: 'Condition report, 2021 restoration' }]
    }),
  W('Untitled (Red Field)', 'Anders Holm', 2014, 'Painting', 5600, 'Acrylic on linen', '80 × 80 cm', '2021-11-02',
    'From the artist’s second solo show. Certificate held.',
    ['circles', ['#efe9e6', '#b8322c', '#1f1d1c', '#e8a13c']],
    { valuation: 7200, valuationDate: '2025-03-04', acquiredFrom: 'Galleri Nord, Copenhagen',
      location: LOCATIONS[1], docs: [{ kind: 'certificate', label: 'Certificate of authenticity' }] }),
  W('Composition in Grey', 'Mira Oduya', 1965, 'Painting', 21000, 'Oil on board', '60 × 45 cm', '2017-03-30',
    'Earliest Oduya in the collection. Provenance: Galerie Vandel, Antwerp.',
    ['grid', ['#e9e7e2', '#5a5f66', '#22262b', '#a9b0b6']],
    {
      valuation: 34000, valuationDate: '2025-03-04', acquiredFrom: 'Galerie Vandel, Antwerp',
      provenance: 'Galerie Vandel, Antwerp (acquired directly from the artist, 1966); private collection, Ghent; sold 2017.',
      priorOwners: 'Galerie Vandel; Maes family, Ghent',
      exhibitions: 'Galerie Vandel, “Nine Painters”, 1966',
      location: LOCATIONS[1], extraImages: 1,
      docs: [{ kind: 'appraisal', label: 'Appraisal — Dupont & Vale, March 2025' }]
    }),
  W('Arches at Dusk', 'Yuki Tanabe', 1988, 'Painting', 8750, 'Mixed media', '100 × 70 cm', '2023-02-14', '',
    ['arch', ['#f0ebe3', '#7a4b57', '#3c4a5e', '#d8c4a3']],
    { valuation: 9800, valuationDate: '2025-03-04', location: LOCATIONS[2] }),
  W('Night Ferry', 'Mira Oduya', 1983, 'Painting', 15200, 'Oil on canvas', '140 × 100 cm', '2018-10-21',
    'Companion piece to Harbour Light. Exhibited: Museu do Chiado, 2005.',
    ['wave', ['#101b2b', '#1d3a5c', '#2f6f8f', '#e8c96b']],
    { valuation: 23000, valuationDate: '2025-03-04', acquiredFrom: 'Private sale, via Sofia Reis',
      exhibitions: 'Museu do Chiado, “Atlantic Light”, 2005 (cat. no. 32)',
      location: LOCATIONS[0], extraImages: 1,
      docs: [{ kind: 'appraisal', label: 'Appraisal — Dupont & Vale, March 2025' }] }),
  W('Two Windows', 'Anders Holm', 2018, 'Painting', 7400, 'Acrylic on linen', '90 × 120 cm', '2019-04-08', '',
    ['panels', ['#f5f2ec', '#2b4a6f', '#c9573f', '#8ea68c']],
    { valuation: 8100, location: LOCATIONS[4] }),
  W('Blue Interval', 'Ingrid Vasseur', 1971, 'Painting', 18600, 'Oil on canvas', '130 × 110 cm', '2016-07-19',
    'Acquired at Hôtel Drouot. Relined 2016 before shipping.',
    ['split', ['#efeee9', '#28486e', '#7d9ec0', '#d8cdb8']],
    { valuation: 26500, valuationDate: '2024-11-19', acquiredFrom: 'Hôtel Drouot, Paris',
      provenance: 'Collection of the artist’s dealer, Paris, until 1994; private collection, Bordeaux; Drouot, 2016.',
      location: LOCATIONS[4], docs: [{ kind: 'condition_report', label: 'Relining report, 2016' }] }),
  W('The Long Field', 'Elias Brandt', 1957, 'Painting', 26500, 'Oil on board', '75 × 150 cm', '2015-09-02',
    'Provenance: artist’s estate, via Bruun Rasmussen.',
    ['bands', ['#eee8dc', '#6d7c4e', '#b9a45c', '#3f4a35']],
    { valuation: 41000, valuationDate: '2024-11-19', acquiredFrom: 'Bruun Rasmussen, Copenhagen',
      provenance: 'The artist’s estate until 2015.', priorOwners: 'Brandt estate',
      location: LOCATIONS[0], extraImages: 1,
      docs: [{ kind: 'certificate', label: 'Estate certificate' }, { kind: 'invoice', label: 'Auction invoice, September 2015' }] }),
  W('Static No. 9', 'Věra Nowak', 1968, 'Painting', 9800, 'Enamel on board', '70 × 70 cm', '2020-01-27', '',
    ['hatch', ['#f3f1ec', '#1c1c1c', '#a8a49c', '#c94f37']],
    { valuation: 12500, location: LOCATIONS[2] }),
  W('Sunday Chorus', 'Clement Aduba', 2009, 'Painting', 6400, 'Acrylic on canvas', '100 × 100 cm', '2021-05-30',
    'Bought directly from the studio in Accra.',
    ['dots', ['#fdf6e9', '#1f6f6b', '#e4703a', '#3d3a86']],
    { valuation: 11000, valuationDate: '2025-03-04', acquiredFrom: 'The artist’s studio, Accra',
      location: LOCATIONS[4], docs: [{ kind: 'certificate', label: 'Studio certificate, signed' }] }),
  W('Salt Flats', 'Ingrid Vasseur', 1994, 'Painting', 11300, 'Oil on canvas', '110 × 90 cm', '2022-03-11', '',
    ['wash', ['#fbf8f3', '#cfd8dc', '#e6c9b8', '#a8bcc4']],
    { valuation: 12800, location: LOCATIONS[6] }),
  W('Green Room', 'Anders Holm', 2022, 'Painting', 4900, 'Acrylic on linen', '70 × 70 cm', '2022-12-04', '',
    ['halo', ['#f2f4ee', '#2f5d43', '#8fb08a', '#d9d3c1']],
    { valuation: 5400, location: LOCATIONS[6] }),
  W('Portrait of a Stranger', 'Marguerite Lyon', 1932, 'Painting', 34000, 'Oil on canvas', '65 × 50 cm', '2014-06-14',
    'Oldest work in the collection. Condition report from 2014 on file; craquelure across the background is stable.',
    ['arch', ['#e7ded0', '#5c3b32', '#2c2622', '#b08b5e']],
    {
      valuation: 58000, valuationDate: '2025-03-04', acquiredFrom: 'Sotheby’s London, Modern & Post-War',
      provenance: 'Painted in Paris, 1932. Galerie Bernheim, 1933; private collection, Geneva, 1951–2013; Sotheby’s, 2014.',
      priorOwners: 'Galerie Bernheim; Hélène Roux, Geneva; Roux estate',
      exhibitions: 'Salon d’Automne, Paris, 1933; Kunsthalle Basel, “Faces”, 1998',
      location: LOCATIONS[1], extraImages: 2,
      docs: [{ kind: 'certificate', label: 'Certificate — Comité Lyon' },
             { kind: 'condition_report', label: 'Condition report, June 2014' },
             { kind: 'appraisal', label: 'Insurance appraisal, March 2025' }]
    }),
  W('Harvest, Late', 'Elias Brandt', 1962, 'Painting', null, 'Oil on canvas', '90 × 120 cm', '2015-09-02',
    'Came with The Long Field as a pair — no separate price recorded.',
    ['bands', ['#f0e6d2', '#8a5a2b', '#c98f3c', '#4a4030']],
    { valuation: 18000, acquiredFrom: 'Bruun Rasmussen, Copenhagen', location: LOCATIONS[5] }),
  W('Radio Silence', 'Osei Mensah', 2016, 'Painting', 8200, 'Oil and wax on panel', '80 × 60 cm', '2018-02-09', '',
    ['split', ['#f1efe8', '#1b2a3a', '#4c6b82', '#d3775b']],
    { valuation: 14500, valuationDate: '2025-03-04', location: LOCATIONS[2] }),
  W('Small Weather', 'Yuki Tanabe', 2005, 'Painting', 2750, 'Gouache on board', '40 × 30 cm', '2019-08-23', '',
    ['wash', ['#fdfbf7', '#b9cfd8', '#e3cdb4', '#9fb3a2']],
    { valuation: 3100, location: LOCATIONS[6] }),
  W('Interior with Lamp', 'Marguerite Lyon', 1947, 'Painting', 19800, 'Oil on canvas', '85 × 65 cm', '2016-11-28',
    'Provenance: private collection, Lyon. Frame is original.',
    ['grid', ['#efe4d2', '#7a4a35', '#2f2b26', '#c8a56b']],
    { valuation: 29000, valuationDate: '2025-03-04', acquiredFrom: 'Galerie Perrin, Lyon',
      provenance: 'Private collection, Lyon, 1948–2016.', priorOwners: 'Marchand family, Lyon',
      location: LOCATIONS[0], docs: [{ kind: 'certificate', label: 'Certificate — Comité Lyon' }] }),
  W('Cadence', 'Clement Aduba', 2024, 'Painting', 5400, 'Acrylic and sand on canvas', '120 × 90 cm', '2025-01-16',
    'Most recent purchase. Still crated.',
    ['circles', ['#fbf3e6', '#d9542b', '#1f3d5c', '#f0b429']],
    { valuation: 6000, acquiredFrom: 'Gallery 1957, Accra', location: LOCATIONS[5],
      docs: [{ kind: 'invoice', label: 'Gallery invoice, January 2025' }] }),

  /* ---------- works on paper, prints, photography ---------- */
  W('Slow Morning', 'Yuki Tanabe', 2021, 'Work on paper', 3200, 'Watercolour on paper', '50 × 35 cm', '2022-06-18', '',
    ['wash', ['#fbf7f2', '#8fb2c9', '#d9a7b0', '#f0d9a8']],
    { valuation: 3600, location: LOCATIONS[6] }),
  W('Study for Harbour Light', 'Mira Oduya', 1977, 'Work on paper', 3100, 'Charcoal on paper', '42 × 30 cm', '2019-05-12',
    'Bought in the same lot as Harbour Light, No. 4.',
    ['lines', ['#f6f3ec', '#2b2b2b', '#6b6b6b', '#cfc7b8']],
    { valuation: 5200, acquiredFrom: 'Cabral Moncada Leilões, Lisbon', location: LOCATIONS[3] }),
  W('Twelve Lines for a City', 'Rafael Ntumba', 1999, 'Print', null, 'Screenprint, ed. 12/40', '70 × 50 cm', '2020-09-05',
    'Gift from the artist — no purchase price.',
    ['lines', ['#f4f2ee', '#1b1b1b', '#c4462f', '#2e6b53']],
    { valuation: 2400, acquiredFrom: 'Gift from the artist', location: LOCATIONS[2] }),
  W('Six Positions', 'Rafael Ntumba', 2003, 'Print', 1450, 'Screenprint, ed. 7/25', '60 × 45 cm', '2020-09-05', '',
    ['hatch', ['#f7f4ee', '#2e6b53', '#c4462f', '#e8d9b0']],
    { valuation: 1900, location: LOCATIONS[2] }),
  W('Untitled (Folded)', 'Nadia Khoury', 2019, 'Work on paper', 2200, 'Ink and collage on paper', '56 × 38 cm', '2021-02-17', '',
    ['panels', ['#f7f5f0', '#3a3f52', '#c2b8a3', '#8c5a4a']],
    { valuation: 2600, location: LOCATIONS[6] }),
  W('Marseille, 4am', 'Lucia Ferrante', 1998, 'Photography', 3600, 'Gelatin silver print, ed. 2/10', '40 × 50 cm', '2017-10-06',
    'Printed by the artist. Framed with museum glass.',
    ['wash', ['#12140f', '#2a2f2b', '#5c625b', '#9aa094']],
    { valuation: 6800, valuationDate: '2024-11-19', location: LOCATIONS[2],
      docs: [{ kind: 'certificate', label: 'Signed edition certificate' }] }),
  W('The Sea at Nazaré', 'Lucia Ferrante', 2012, 'Photography', 4100, 'Archival pigment print, ed. 5/15', '60 × 90 cm', '2023-07-25', '',
    ['wave', ['#e8eef1', '#3f6f8f', '#7fa8bf', '#cfdde5']],
    { valuation: 4600, location: LOCATIONS[4], extraImages: 1 }),
  W('Alphabet for a Wall', 'Věra Nowak', 1975, 'Print', 980, 'Lithograph, ed. 22/60', '50 × 40 cm', '2020-01-27',
    'Bought with Static No. 9 from the same dealer.',
    ['grid', ['#f4f1ea', '#1c1c1c', '#b5b0a6', '#d8663f']],
    { valuation: 1400, location: LOCATIONS[5] }),
  W('Notes on Blue', 'Priya Raghunathan', 2020, 'Work on paper', 1900, 'Watercolour and pencil', '35 × 25 cm', '2024-04-12', '',
    ['dots', ['#fbfaf6', '#3457a8', '#8fb6e0', '#e0d5c2']],
    { valuation: 2200, location: LOCATIONS[6] }),
  W('Field Recording', 'Jonas Vik', 2023, 'Print', null, 'Cyanotype', '45 × 60 cm', '2024-09-19',
    'Traded with the artist for a framing favour.',
    ['circles', ['#e7eef5', '#1f4f80', '#3d7ab0', '#cfe0ee']],
    { valuation: 1200, acquiredFrom: 'Trade with the artist', location: LOCATIONS[5] }),

  /* ---------- sculpture ---------- */
  W('Standing Figure III', 'Hana Sørensen', 1961, 'Sculpture', 42000, 'Bronze, ed. 3/8', '145 × 40 × 38 cm', '2013-05-08',
    'Cast at Fonderia Battaglia. Foundry mark on the base. Insured separately.',
    ['bronze', ['#efe9df', '#5c4a2e', '#8a7a5c', '#d6cdbc']],
    {
      valuation: 96000, insured: 110000, valuationDate: '2025-03-04', acquiredFrom: 'Christie’s London',
      provenance: 'Cast 1961, Fonderia Battaglia, Milan. Galleria Blu, Milan, 1962; private collection, Zurich, 1970–2012; Christie’s, 2013.',
      priorOwners: 'Galleria Blu, Milan; Hoffmann collection, Zurich',
      exhibitions: 'Venice Biennale, Danish Pavilion, 1962; Louisiana Museum, “Form and Weight”, 1989',
      location: LOCATIONS[0], extraImages: 2,
      docs: [{ kind: 'certificate', label: 'Foundry certificate — Fonderia Battaglia' },
             { kind: 'appraisal', label: 'Insurance appraisal, March 2025' },
             { kind: 'invoice', label: 'Christie’s invoice, May 2013' },
             { kind: 'condition_report', label: 'Patina condition report, 2022' }]
    }),
  W('Torso (Marble)', 'Hana Sørensen', 1958, 'Sculpture', 58000, 'Carrara marble', '68 × 32 × 28 cm', '2018-06-21',
    'Most valuable work in the collection. Requires two people to move — do not lift by the shoulder.',
    ['torso', ['#e9e6df', '#d5cfc2', '#8d8578', '#cbc5b8']],
    {
      valuation: 124000, insured: 140000, valuationDate: '2025-03-04', acquiredFrom: 'Private treaty sale, Copenhagen',
      provenance: 'Carved in Pietrasanta, 1958. The artist’s studio until 1977; Kunstforeningen, Copenhagen; private collection, 1981–2018.',
      priorOwners: 'The artist; Kunstforeningen; Lund family',
      exhibitions: 'Kunstforeningen, Copenhagen, 1977',
      location: LOCATIONS[0], extraImages: 1,
      docs: [{ kind: 'appraisal', label: 'Insurance appraisal, March 2025' },
             { kind: 'certificate', label: 'Certificate — Sørensen Estate' }]
    }),
  W('Small Bronze (Bird)', 'Hana Sørensen', 1974, 'Sculpture', 5200, 'Bronze, ed. 11/12', '22 × 14 × 10 cm', '2019-11-30', '',
    ['plinth', ['#f2eee7', '#6b5334', '#a89574', '#ded7c9']],
    { valuation: 9400, valuationDate: '2025-03-04', location: LOCATIONS[1],
      docs: [{ kind: 'certificate', label: 'Edition certificate' }] }),
  W('Vessel for Nothing', 'Tomás Reyes', 2015, 'Sculpture', 7800, 'Glazed stoneware', '52 × 34 × 34 cm', '2020-08-14',
    'Hairline glaze crack on the reverse, present at purchase — noted on the invoice.',
    ['vessel', ['#f6f2ea', '#3f6b6b', '#7fa39c', '#e2dbcc']],
    { valuation: 11000, location: LOCATIONS[4], extraImages: 1,
      docs: [{ kind: 'invoice', label: 'Gallery invoice, August 2020' },
             { kind: 'condition_report', label: 'Condition note — glaze crack' }] }),
  W('Clay Study for a Head', 'Tomás Reyes', 2021, 'Sculpture', null, 'Terracotta', '34 × 22 × 24 cm', '2022-05-03',
    'Studio gift. Unfired areas are fragile.',
    ['plinth', ['#f5efe6', '#a85f3c', '#c98a63', '#e6dccb']],
    { valuation: 2800, acquiredFrom: 'Gift from the artist', location: LOCATIONS[5] }),
  W('Balance No. 2', 'Jonas Vik', 1996, 'Sculpture', 16400, 'Painted steel and wire', '180 × 120 × 60 cm', '2017-04-27',
    'Hanging work. Needs 2.5 m of clearance; ceiling anchor supplied by the artist.',
    ['mobile', ['#f7f6f2', '#c1392b', '#2c3e70', '#e6a817']],
    { valuation: 22000, valuationDate: '2024-11-19', location: LOCATIONS[2], extraImages: 1,
      docs: [{ kind: 'certificate', label: 'Certificate with installation notes' }] }),
  W('Suspended Yellow', 'Jonas Vik', 2004, 'Sculpture', 9100, 'Aluminium and steel cable', '140 × 90 × 40 cm', '2021-09-09', '',
    ['mobile', ['#f4f6f7', '#e0a815', '#2f4858', '#8aa6b3']],
    { valuation: 10500, location: LOCATIONS[6] }),
  W('Monolith with Aperture', 'Osei Mensah', 2007, 'Sculpture', 23500, 'Basalt', '210 × 70 × 55 cm', '2019-03-15',
    'Sited in the garden. Annual sealing recommended; last treated spring 2025.',
    ['monolith', ['#eceae4', '#3a3d42', '#6d7176', '#c9c5bc']],
    { valuation: 31000, valuationDate: '2025-03-04', location: LOCATIONS[7], extraImages: 1,
      docs: [{ kind: 'appraisal', label: 'Appraisal — Dupont & Vale, March 2025' }] })
];

migrate({ log: () => {} });

const FIXTURE_EMAILS = ['owner@fixture.test', 'other@fixture.test'];
const strangers = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE email NOT IN (${FIXTURE_EMAILS.map(() => '?').join(',')})`)
  .get(...FIXTURE_EMAILS).c;
if (strangers && !process.argv.includes('--force')) {
  console.error(`Refusing to load test fixtures into a database with ${strangers} real account(s): ${config.dbFile}`);
  process.exit(1);
}

const now = () => new Date().toISOString();

/** Deterministic multiplier so seeded valuations are stable between runs. */
function valuationFor(work) {
  if (work.valuation !== undefined) return work.valuation;
  if (work.price === null) return null;
  const seed = [...work.title].reduce((s, c) => s + c.charCodeAt(0), 0);
  return Math.round((work.price * (1.1 + (seed % 90) / 100)) / 50) * 50;
}

async function documentPdf({ label, work, owner }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);                       // A4
  const title = await pdf.embedFont(StandardFonts.HelveticaBold);
  const body = await pdf.embedFont(StandardFonts.Helvetica);

  const draw = (text, y, { font = body, size = 11, color = rgb(0.13, 0.15, 0.18) } = {}) =>
    page.drawText(String(text), { x: 60, y, size, font, color });

  draw('Zoelae — test fixture', 782, { font: title, size: 9, color: rgb(0.55, 0.58, 0.62) });
  draw(label, 748, { font: title, size: 18 });
  page.drawLine({ start: { x: 60, y: 734 }, end: { x: 535, y: 734 }, thickness: 0.7, color: rgb(0.87, 0.88, 0.9) });

  const rows = [
    ['Work', work.title],
    ['Artist', work.artist],
    ['Year', work.year],
    ['Medium', work.medium],
    ['Dimensions', work.dimensions],
    ['Collector', owner]
  ];
  rows.forEach(([k, v], i) => {
    const y = 700 - i * 26;
    draw(k, y, { size: 9, color: rgb(0.45, 0.48, 0.53) });
    draw(v, y - 12, { size: 12 });
  });

  draw('This is placeholder content generated by the Zoelae test fixtures so that document', 470, { size: 10, color: rgb(0.42, 0.45, 0.5) });
  draw('previews and the "Certificates & documents" visibility toggle have something real to show.', 456, { size: 10, color: rgb(0.42, 0.45, 0.5) });

  return Buffer.from(await pdf.save());
}

function createUser({ email, password, displayName, timezone }) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) db.prepare('DELETE FROM users WHERE id = ?').run(existing.id);  // cascades everything
  const t = now();
  const info = db.prepare(`INSERT INTO users (public_id, email, password_hash, display_name, timezone, login_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(tokens.publicId('usr'), email, passcodes.hash(password), displayName, timezone, t, t);
  return info.lastInsertRowid;
}

const insertArtwork = db.prepare(`INSERT INTO artworks
  (public_id, owner_id, title, artist, year_created, type, medium, dimensions,
   purchase_price, currency, current_valuation, insured_value, valuation_date,
   acquired_at, acquired_from, provenance, prior_owners, exhibition_history,
   storage_location, notes, created_at, updated_at)
  VALUES (@public_id, @owner_id, @title, @artist, @year_created, @type, @medium, @dimensions,
   @purchase_price, 'EUR', @current_valuation, @insured_value, @valuation_date,
   @acquired_at, @acquired_from, @provenance, @prior_owners, @exhibition_history,
   @storage_location, @notes, @created_at, @updated_at)`);

const insertImage = db.prepare(`INSERT INTO artwork_images (public_id, artwork_id, file_path, display_path, thumb_path, width, height, mime_type, byte_size, sort_order, created_at)
  VALUES (@public_id, @artwork_id, @file_path, @display_path, @thumb_path, @width, @height, @mime_type, @byte_size, @sort_order, @created_at)`);

const insertDocument = db.prepare(`INSERT INTO artwork_documents (public_id, artwork_id, kind, label, file_path, mime_type, byte_size, created_at)
  VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, ?)`);

async function seedArtwork(ownerId, ownerName, work) {
  // created_at follows the acquisition date so "added this month" and "recently added" mean something.
  const created = work.acquired ? new Date(work.acquired).toISOString() : now();
  const valuation = valuationFor(work);

  const info = insertArtwork.run({
    public_id: tokens.publicId('art'), owner_id: ownerId,
    title: work.title, artist: work.artist, year_created: work.year, type: work.type,
    medium: work.medium, dimensions: work.dimensions,
    purchase_price: work.price, current_valuation: valuation,
    insured_value: work.insured ?? (valuation ? Math.round(valuation * 1.1 / 100) * 100 : null),
    valuation_date: work.valuationDate || null,
    acquired_at: work.acquired || null, acquired_from: work.acquiredFrom || null,
    provenance: work.provenance || null, prior_owners: work.priorOwners || null,
    exhibition_history: work.exhibitions || null,
    storage_location: work.location || null, notes: work.notes || null,
    created_at: created, updated_at: created
  });
  const artworkId = info.lastInsertRowid;

  const plates = [work.art[1], ...Array.from({ length: work.extraImages || 0 }, (_, i) => variantColors(work.art[1], i + 1))];
  // Through the same pipeline as a real upload, so tests see thumbnails and display sizes.
  for (const [i, palette] of plates.entries()) {
    const stored = await storeImage(Buffer.from(svgArt(work.art[0], palette), 'utf8'), 'image/svg+xml');
    insertImage.run({ ...stored, public_id: tokens.publicId('img'), artwork_id: artworkId, sort_order: i, created_at: created });
  }

  for (const doc of work.docs || []) {
    const pdf = await documentPdf({ label: doc.label, work, owner: ownerName });
    insertDocument.run(tokens.publicId('doc'), artworkId, doc.kind, doc.label,
      uploads.writeFile(pdf, 'application/pdf'), pdf.length, created);
  }
  return artworkId;
}

function createShare({ ownerId, title, intro, artworkIds, passcode, flags = {}, expiresAt = null, maxViews = null }) {
  const t = now();
  const slug = tokens.shareSlug();
  const info = db.prepare(`INSERT INTO shared_collections
    (owner_id, slug, title, intro_message, passcode_hash, show_prices, show_documents, show_provenance,
     show_location, allow_downloads, expires_at, max_views, view_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(ownerId, slug, title, intro, passcodes.hash(passcode),
      flags.prices ? 1 : 0, flags.documents ? 1 : 0, flags.provenance ? 1 : 0,
      flags.location ? 1 : 0, flags.downloads ? 1 : 0, expiresAt, maxViews, t, t);

  artworkIds.forEach((id, i) =>
    db.prepare('INSERT INTO shared_collection_items (public_id, shared_collection_id, artwork_id, sort_order) VALUES (?, ?, ?, ?)')
      .run(tokens.publicId('itm'), info.lastInsertRowid, id, i));
  return slug;
}

(async () => {
  const sofia = createUser({
    email: 'owner@fixture.test', password: 'fixture-owner-pw',
    displayName: 'Sofia Almeida', timezone: 'Europe/Lisbon'
  });

  const ids = [];
  for (const work of demoWorks) ids.push(await seedArtwork(sofia, 'Sofia Almeida', work));

  const byTitle = (title) => ids[demoWorks.findIndex(w => w.title === title)];

  const auctionSlug = createShare({
    ownerId: sofia,
    title: 'For Sotheby’s — Spring Review',
    intro: 'Six pieces we discussed on the call. Happy to arrange viewings in Lisbon from the 12th.',
    artworkIds: ['Standing Figure III', 'Torso (Marble)', 'Portrait of a Stranger', 'Composition in Grey',
      'The Long Field', 'Night Ferry'].map(byTitle),
    passcode: 'amber-vault-7412',
    flags: { prices: true, documents: true, provenance: true }
  });

  const friendsSlug = createShare({
    ownerId: sofia,
    title: 'The sculpture room',
    intro: 'What the garden and drawing room look like at the moment.',
    artworkIds: demoWorks.map((w, i) => (w.type === 'Sculpture' ? ids[i] : null)).filter(Boolean),
    passcode: 'granite-studio-2048',
    flags: { downloads: true }
  });

  const marcus = createUser({
    email: 'other@fixture.test', password: 'fixture-other-pw',
    displayName: 'Marcus Reyner', timezone: 'Europe/London'
  });
  await seedArtwork(marcus, 'Marcus Reyner', demoWorks[1]);

  console.log('Test fixtures loaded.');
  console.log(`  owner@fixture.test / fixture-owner-pw  (${demoWorks.length} works)`);
  console.log(`  other@fixture.test / fixture-other-pw  (1 work)`);
  console.log(`  shares    : /s/${auctionSlug} (amber-vault-7412), /s/${friendsSlug} (granite-studio-2048)`);
})().catch(err => { console.error(err); process.exit(1); });
