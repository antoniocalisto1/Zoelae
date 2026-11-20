-- 007 — where a work stands, who the gallery sells to, and bulk import from a spreadsheet.

-- A gallery's (or artist's) clients. Private to the account; never shown to viewers.
CREATE TABLE clients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id    TEXT    NOT NULL UNIQUE,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  email        TEXT,
  phone        TEXT,
  company      TEXT,
  city         TEXT,
  country      TEXT,
  interests    TEXT,             -- artists, media, budget: free text
  notes        TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
CREATE INDEX idx_clients_owner ON clients(owner_id);

-- Every work is in one of three states. Existing works are in the owner's collection.
ALTER TABLE artworks ADD COLUMN status TEXT NOT NULL DEFAULT 'collection'
  CHECK (status IN ('collection', 'for_sale', 'sold'));
ALTER TABLE artworks ADD COLUMN asking_price     REAL;      -- when for sale
ALTER TABLE artworks ADD COLUMN sold_price       REAL;      -- when sold
ALTER TABLE artworks ADD COLUMN sold_at          TEXT;      -- date, YYYY-MM-DD
ALTER TABLE artworks ADD COLUMN sold_to_client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;
-- The stock or reference number galleries and studios write on the back of a work.
ALTER TABLE artworks ADD COLUMN inventory_number TEXT;
CREATE INDEX idx_artworks_owner_status ON artworks(owner_id, status);

-- Everything sent to a client from ArtCave: a shared link or a PDF of chosen works.
CREATE TABLE client_messages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id            TEXT    NOT NULL UNIQUE,
  owner_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id            INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind                 TEXT    NOT NULL CHECK (kind IN ('link', 'pdf')),
  subject              TEXT    NOT NULL,
  body                 TEXT,
  shared_collection_id INTEGER REFERENCES shared_collections(id) ON DELETE SET NULL,
  artwork_count        INTEGER NOT NULL DEFAULT 0,
  delivery             TEXT    NOT NULL,   -- sent | outbox | failed
  created_at           TEXT    NOT NULL
);
CREATE INDEX idx_client_messages_client ON client_messages(client_id);
CREATE INDEX idx_client_messages_owner ON client_messages(owner_id, created_at);
