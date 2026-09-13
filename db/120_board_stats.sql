-- 020_board_stats.sql: the board's own counts, written by the sweep, read by the
-- tiles, never typed by hand.
--
-- The stat tiles used to read src/data/stats.json, the design sweep's numbers.
-- The board is a different, broader population now (design, AI and UX research
-- across every tracked feed), so those numbers were wrong above it. This single
-- row holds the board's real counts, written by the ingest each time it loads a
-- sweep (scripts/ingest-jobs.mjs), so "verified live" is exactly what the board
-- holds, "boards swept" is exactly what the crawl read, and nobody maintains a
-- number by hand. One row, enforced by the singleton check.
CREATE TABLE IF NOT EXISTS board_stats (
  id             INTEGER PRIMARY KEY DEFAULT 1,
  boards_swept   INTEGER NOT NULL DEFAULT 0,
  verified_live  INTEGER NOT NULL DEFAULT 0,
  killed         INTEGER NOT NULL DEFAULT 0,
  killed_by_rule INTEGER NOT NULL DEFAULT 0,
  swept_at       TIMESTAMPTZ,
  ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT board_stats_singleton CHECK (id = 1)
);
