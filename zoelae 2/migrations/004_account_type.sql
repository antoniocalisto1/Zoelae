-- 004_account_type.sql — remembers which account type and tier someone chose on the way in.
-- Nothing is gated on these yet; they record the choice so it survives signup and can be
-- shown back to the collector while the plans themselves are still being decided.

ALTER TABLE users ADD COLUMN account_type TEXT;   -- artist | collector | gallery
ALTER TABLE users ADD COLUMN plan_tier    TEXT;   -- lite | normal | pro
