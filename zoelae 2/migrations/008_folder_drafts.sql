-- 008 — works that arrive as a photograph first and get their details afterwards.
-- Adding a folder of images creates one work per image with only a provisional title taken from
-- the file name and no artist. needs_details marks those works until someone fills them in.
ALTER TABLE artworks ADD COLUMN needs_details INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_artworks_owner_needs ON artworks(owner_id, needs_details);
