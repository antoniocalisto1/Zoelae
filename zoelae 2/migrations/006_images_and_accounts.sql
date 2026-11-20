-- 006_images_and_accounts.sql — what a real site needs before strangers use it.

-- Every uploaded image gets two smaller copies: a thumbnail for the grid and a display size for
-- the detail page and shared links. The original is kept for downloads and documents. All three
-- are re-encoded on upload, which strips location data and other metadata from phone photos.
ALTER TABLE artwork_images ADD COLUMN display_path TEXT;
ALTER TABLE artwork_images ADD COLUMN thumb_path   TEXT;
ALTER TABLE artwork_images ADD COLUMN width        INTEGER;
ALTER TABLE artwork_images ADD COLUMN height       INTEGER;

-- Sessions are signed tokens with no server-side record, so a version number on the user is
-- how a password change signs out every other device: old tokens carry the old number.
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;

-- Password reset links. Only a hash of the token is stored; the link itself exists only in the email.
CREATE TABLE password_resets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL UNIQUE,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  used_at     TEXT
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);
