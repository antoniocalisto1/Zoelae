-- 005_export_orders.sql — the paid one-off documents (insurance schedules, estate inventories).
--
-- A row here is a document that was generated, and how it was paid for. Nothing in this table
-- touches payment instruments: `status` records whether the tier covered it or whether a purchase
-- was confirmed, and `amount_cents` is what it would have cost. Wiring a real payment provider
-- means adding a provider reference column and confirming against their webhook — nothing else
-- in this schema changes.

CREATE TABLE export_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id    TEXT    NOT NULL UNIQUE,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  kind         TEXT    NOT NULL,              -- insurance_schedule | estate_inventory
  title        TEXT    NOT NULL,
  status       TEXT    NOT NULL,              -- included | simulated_paid
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency     TEXT    NOT NULL DEFAULT 'EUR',

  piece_count  INTEGER NOT NULL DEFAULT 0,
  total_value  REAL,                          -- the figure printed on the cover, for later reference
  file_path    TEXT    NOT NULL,              -- under the uploads root; never served statically
  byte_size    INTEGER NOT NULL DEFAULT 0,

  created_at   TEXT    NOT NULL
);

CREATE INDEX idx_export_orders_owner ON export_orders(owner_id, created_at);
