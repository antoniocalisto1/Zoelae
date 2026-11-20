-- 002_shared_collections.sql — view-only shared collections behind a passcode.

CREATE TABLE shared_collections (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug            TEXT    NOT NULL UNIQUE,   -- >= 22 chars, crypto.randomBytes, never sequential
  title           TEXT    NOT NULL,
  intro_message   TEXT,
  passcode_hash   TEXT    NOT NULL,          -- bcrypt; never returned by any API response

  show_prices     INTEGER NOT NULL DEFAULT 0,
  show_documents  INTEGER NOT NULL DEFAULT 0,
  show_provenance INTEGER NOT NULL DEFAULT 0,
  show_location   INTEGER NOT NULL DEFAULT 0,
  allow_downloads INTEGER NOT NULL DEFAULT 0,

  expires_at      TEXT,
  max_views       INTEGER,
  view_count      INTEGER NOT NULL DEFAULT 0,
  revoked_at      TEXT,

  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE INDEX idx_shared_collections_owner ON shared_collections(owner_id, created_at);

CREATE TABLE shared_collection_items (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id            TEXT    NOT NULL UNIQUE,  -- what the viewer sees; internal artwork ids stay private
  shared_collection_id INTEGER NOT NULL REFERENCES shared_collections(id) ON DELETE CASCADE,
  artwork_id           INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (shared_collection_id, artwork_id)
);

CREATE INDEX idx_shared_items_collection ON shared_collection_items(shared_collection_id, sort_order);

CREATE TABLE shared_collection_access_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  shared_collection_id INTEGER NOT NULL REFERENCES shared_collections(id) ON DELETE CASCADE,
  accessed_at          TEXT    NOT NULL,
  ip_hash              TEXT,                     -- sha256(ip + IP_HASH_SALT); the raw IP is never stored
  user_agent           TEXT,
  success              INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_access_log_collection ON shared_collection_access_log(shared_collection_id, accessed_at);
