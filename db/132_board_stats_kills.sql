-- The board's own kill counts, replacing the literal zeros the ingest wrote
-- until 2026-09-08. killed is the count of tonight's feed rows a published kill
-- names; killed_all_time is every non-vacated kill tied to a board row, on the
-- feed or not; kills_by_rule breaks killed down by the site's rule names.
-- kills_exported_at is the second named clock: swept_at is the crawl's instant,
-- this is the kill archive's swept_at_utc, and the two are stated apart.
ALTER TABLE board_stats ADD COLUMN IF NOT EXISTS kills_by_rule JSONB;
ALTER TABLE board_stats ADD COLUMN IF NOT EXISTS killed_all_time INTEGER NOT NULL DEFAULT 0;
ALTER TABLE board_stats ADD COLUMN IF NOT EXISTS kills_exported_at TIMESTAMPTZ;
