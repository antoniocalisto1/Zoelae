-- 003_optional_year.sql — a collector often owns a piece without knowing when it was made.
-- Makes artworks.year_created nullable rather than forcing an invented date.
--
-- SQLite cannot relax a NOT NULL in place, so this is the documented table rebuild.
-- The migration runner disables foreign keys around each migration, so dropping the old
-- table here does not cascade into artwork_images, artwork_documents or shared_collection_items.

CREATE TABLE artworks_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id          TEXT    NOT NULL UNIQUE,
  owner_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  title              TEXT    NOT NULL,
  artist             TEXT    NOT NULL,
  year_created       INTEGER,               -- was NOT NULL
  type               TEXT    NOT NULL DEFAULT 'Painting',
  medium             TEXT,
  dimensions         TEXT,

  purchase_price     REAL,
  currency           TEXT    NOT NULL DEFAULT 'EUR',
  current_valuation  REAL,
  insured_value      REAL,
  valuation_date     TEXT,

  acquired_at        TEXT,
  acquired_from      TEXT,
  provenance         TEXT,
  prior_owners       TEXT,
  exhibition_history TEXT,

  storage_location   TEXT,

  notes              TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

INSERT INTO artworks_new SELECT
  id, public_id, owner_id, title, artist, year_created, type, medium, dimensions,
  purchase_price, currency, current_valuation, insured_value, valuation_date,
  acquired_at, acquired_from, provenance, prior_owners, exhibition_history,
  storage_location, notes, created_at, updated_at
FROM artworks;

DROP TABLE artworks;
ALTER TABLE artworks_new RENAME TO artworks;

CREATE INDEX idx_artworks_owner ON artworks(owner_id);
CREATE INDEX idx_artworks_owner_created ON artworks(owner_id, created_at);
