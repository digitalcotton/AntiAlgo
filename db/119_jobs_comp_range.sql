-- 019_jobs_comp_range.sql: the structured pay range on a tracked posting.
--
-- The board's Comp filter buckets a row by the floor of its posted range, read
-- from a structured field the ATS handed the tracker, never parsed out of the
-- employer's prose (comp_posted stays the employer's own words). Without this
-- column every tracked row bucketed as "not listed" and the filter did nothing.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS comp_range JSONB;
