-- 001_init.sql — collectors, artworks, and the files attached to an artwork.
-- Timestamps are ISO-8601 UTC strings, e.g. 2026-08-17T05:00:00.000Z.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id     TEXT    NOT NULL UNIQUE,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  display_name  TEXT,
  timezone      TEXT,
  login_count   INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE artworks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id          TEXT    NOT NULL UNIQUE,
  owner_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- always visible to a permitted viewer
  title              TEXT    NOT NULL,
  artist             TEXT    NOT NULL,
  year_created       INTEGER NOT NULL,
  type               TEXT    NOT NULL DEFAULT 'Painting',
  medium             TEXT,
  dimensions         TEXT,

  -- gated behind show_prices
  purchase_price     REAL,
  currency           TEXT    NOT NULL DEFAULT 'EUR',
  current_valuation  REAL,
  insured_value      REAL,
  valuation_date     TEXT,

  -- gated behind show_provenance
  acquired_at        TEXT,
  acquired_from      TEXT,
  provenance         TEXT,
  prior_owners       TEXT,
  exhibition_history TEXT,

  -- gated behind show_location
  storage_location   TEXT,

  notes              TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

CREATE INDEX idx_artworks_owner ON artworks(owner_id);
CREATE INDEX idx_artworks_owner_created ON artworks(owner_id, created_at);

CREATE TABLE artwork_images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id  TEXT    NOT NULL UNIQUE,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  file_path  TEXT    NOT NULL,          -- relative to the uploads root; never served statically
  mime_type  TEXT    NOT NULL,
  byte_size  INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);

CREATE INDEX idx_artwork_images_artwork ON artwork_images(artwork_id, sort_order);

CREATE TABLE artwork_documents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id  TEXT    NOT NULL UNIQUE,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL DEFAULT 'other',   -- certificate | appraisal | invoice | condition_report | other
  label      TEXT    NOT NULL,
  file_path  TEXT    NOT NULL,
  mime_type  TEXT    NOT NULL,
  byte_size  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);

CREATE INDEX idx_artwork_documents_artwork ON artwork_documents(artwork_id);
