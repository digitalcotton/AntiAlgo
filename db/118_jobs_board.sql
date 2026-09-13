-- 018_jobs_board.sql: the columns the unified board needs on top of the raw
-- tracker record in 017_jobs.sql.
--
-- The board sorts by fit and links each row to its own page, the same two things
-- the design board already does for its verified rows. A tracker row carries
-- neither, so they are derived once at ingest and stored here, rather than
-- recomputed on every request or, worse, in SQL: fit is a small rubric best kept
-- in one place in TypeScript (src/lib/board-jobs.ts), and the board only needs
-- the total to page in order, so the total is stored and the component split
-- travels beside it for the row's own "why".
--
--   slug           the row's own page under /board/<slug>, unique, derived from
--                  company + title + the tracker id so it is stable across nights
--   fit_total      0-100 general opportunity score; thinner records score lower
--   fit_components the five rubric parts behind that total, as the site's own
--                  keys, so the row can draw its fit bars without rescoring
--   source         'tracked' for a crawl row; leaves room for other provenance
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fit_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fit_components JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tracked';

-- The board's default order is fit, highest first, and the slug lookup backs the
-- per-row page. A partial-safe unique index would reject two rows that derived
-- the same slug; the ingest already makes the slug unique by folding the id into
-- it, so a plain index is enough for the lookup and the ordering.
CREATE INDEX IF NOT EXISTS jobs_fit_total_idx ON jobs (fit_total DESC, last_seen DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS jobs_slug_idx ON jobs (slug);
