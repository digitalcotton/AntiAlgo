-- 013_provider_key_label.sql
--
-- A friendly name for a stored provider key. Optional. db/007's key rows are
-- keyed by (user_id, provider), one key per provider per person, and worked
-- with no name at all. The Settings page now lets a person name the key they
-- add ("work Anthropic", "personal"), so a row in the keys table reads as
-- something they recognise rather than only a provider and a last four.
--
-- Nullable, because a name is a convenience and every existing row has none.
-- Capped so a label stays a label, not a place to paste more text than a table
-- cell can hold: the Settings endpoint (src/pages/settings/keys/save.ts) trims
-- and truncates to the same 60 before it ever reaches here, and this CHECK is
-- the database's own floor under that, not a substitute for it.
ALTER TABLE user_provider_key
  ADD COLUMN IF NOT EXISTS label text
    CHECK (label IS NULL OR char_length(label) <= 60);
