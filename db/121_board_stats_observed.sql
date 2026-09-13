-- 021_board_stats_observed.sql: how many postings the crawl read in total.
--
-- The scope banner's one job is the funnel: the crawl reads every posting these
-- companies put up, and only some are design, AI or research roles. That needs
-- the total read, not just the count kept, so the board can say "we read this
-- many, this many are in scope" without a hand-typed number.
ALTER TABLE board_stats ADD COLUMN IF NOT EXISTS postings_observed INTEGER NOT NULL DEFAULT 0;
