-- 222_job_places.sql: jobs.place_keys and jobs.place_leaves: every place a posting lists.
--
-- WHY. db/220 gave a posting ONE place (place_country, place_admin1, place_city,
-- place_label), and a posting that lists several was reduced to one. The reduction
-- took the crawl's country, which is its pick of one place from the list, and the
-- one city the list names: wrong for 24 of the 99 " / " lists that were given a city
-- on the local board ("London, Canada" for London, UK; "New York, Canada"; a city
-- called "Europe"), and a job listing London and Berlin was found under neither
-- city. Owner decision, 2026-10-02 (docs/every-place-plan.md, report decision 8): a
-- posting that lists several places is found under EACH of them, and each place's
-- count includes it. These two arrays hold all of them; place_country and its
-- three siblings stay, and are now the one place the row reduces to.
--
--   place_keys    every key of every place, distinct and sorted. A key is a value
--                 the board's `place=` already accepts (src/lib/place-key.ts):
--                 the country (GB), the country and state (US-MD), the country
--                 and city with the state left open (US/Baltimore, which is
--                 "Baltimore, any state"), and the country, state and city
--                 (US-MD/Baltimore). Every level is a key, so a filter at any
--                 level is one array-contains probe. Empty means "Not stated".
--   place_leaves  the most specific key of each place, one per place, distinct and
--                 sorted: US-MD/Baltimore, GB/London, GB. It is what a place is
--                 counted under when each place is counted once, which is what the
--                 search box's vocabulary needs.
--
-- WRITTEN BY ONE DEFINITION, as db/220's are: placesOf() in
-- src/lib/jobs-derived.mjs, called from derivedFor() by scripts/ingest-jobs.mjs on
-- every row of every crawl and by scripts/backfill-derived.mjs for rows already on
-- file. Nothing restates a place rule in SQL.
--
-- NOT NULL DEFAULT '{}', AND WHY THAT IS SAFE HERE. A NULL array would make
-- `place_keys @> ARRAY[k]` and `cardinality(place_keys) = 0` NULL, and every reader
-- would need a COALESCE to say "Not stated". A constant default is a catalog change
-- from Postgres 11 on (the value is kept in pg_attribute and no row is rewritten),
-- so adding the columns takes the table lock for milliseconds, not the seconds a
-- rewrite takes. See db/219 for why the length of that lock is the whole risk.
--
-- THIS FILE DOES NOT FILL THEM. Every existing row reads '{}' until the ingest or
-- the backfill writes it, and '{}' reads as "Not stated", so a deploy of this file
-- and its readers shows an empty Location list until one of them has run: run
-- `node scripts/backfill-derived.mjs --all` after the migration (the deploy runbook
-- in docs/search-engine-report.md says so), exactly as db/220 needed. The fill is
-- not in the SQL on purpose: the arrays come from the JavaScript reading rule, and a
-- second copy of that rule in plpgsql is the drift this repo is built against.
--
-- TWO TRANSACTIONS, for db/219's reason: ADD COLUMN takes ACCESS EXCLUSIVE until
-- the transaction ends, and a plain CREATE INDEX takes SHARE, so one transaction
-- would hold the table, and every read of it, through the index build. migrate.mjs
-- has already opened the first transaction and closes and records the last.
-- Not atomic, and re-runnable from either point: IF NOT EXISTS on every statement.
--
-- WHAT IT COSTS, measured on 2026-10-02 against the local board (37,765 rows,
-- 37,286 live), Postgres 17:
--
--   * Locks. From the ALTER to the COMMIT, 1 to 4 ms over nine runs rolled back
--     (the ALTER 0.7 to 2.7 ms, median 0.9 ms, the COMMENT a fraction of that).
--     Nothing is rewritten: the two defaults are constants.
--   * The index on the empty arrays: 20 to 39 ms, median 23 ms.
--   * The fill, `backfill-derived.mjs --all`: 26 s for 37,765 rows, 31,105 of them
--     written (a row with no place is already '{}'). It runs under row locks, so a
--     reader keeps reading; it leaves a dead version of each row written until
--     autovacuum reclaims it, and the plan of a statement that follows can be
--     costed from stale statistics until it has run (VACUUM ANALYZE jobs).
--   * Storage: the index is 2.7 MB; the two arrays are 3.6 MB for the live rows
--     (2.9 keys and 0.9 leaves a row on average, 56 and 43 at most); the table with
--     its indexes is 678 MB.
--   * The question it exists to answer, `place_keys @> ARRAY['GB/London']` over the
--     live rows: a bitmap scan of this index, 903 rows, 1.9 ms.

-- SEGMENT 1: THE COLUMNS. ACCESS EXCLUSIVE from the ALTER to the COMMIT below, a
-- COMMENT apart. A BOUNDED WAIT, as in db/219: ADD COLUMN waits for every read in
-- flight on jobs and every read that arrives after it queues behind it, so an
-- unbounded wait behind one slow query freezes the live board for as long as that
-- query runs. Five seconds, then the migration fails, the build fails, and the
-- deployment already serving keeps serving.
SET LOCAL lock_timeout = '5s';
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS place_keys   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS place_leaves text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN jobs.place_keys IS
  'Every key of every place the posting lists, distinct and sorted: GB, US-MD, GB/London, US/Baltimore, US-MD/Baltimore (the board''s place= grammar, src/lib/place-key.ts). Empty = location not stated. Written by placesOf() through derivedFor() (src/lib/jobs-derived.mjs); never by SQL.';
COMMENT ON COLUMN jobs.place_leaves IS
  'The most specific key of each place the posting lists, one per place, distinct and sorted. Written by placesOf() through derivedFor(); never by SQL.';

COMMIT;
BEGIN;

-- SEGMENT 2: THE INDEX. A plain CREATE INDEX takes SHARE, which blocks writes to jobs
-- while it builds and never blocks a read; not CONCURRENTLY, for db/219's reason (it
-- cannot run inside the transaction migrate.mjs wraps this file in). Every row holds
-- '{}' when it is built, so there is nothing to index and it is instant; the fill
-- that follows maintains it row by row.
--
-- PARTIAL ON THE LIVE ROWS, as in db/207: every query the board makes carries
-- "status <> 'killed'" literally, so Postgres can match this predicate, and one that
-- leaves it out will not use this index. GIN, because the question is always
-- "does this posting list THAT place": `place_keys @> ARRAY['GB/London']`, the
-- board's place filter, a suggestion's count, the country list's probe for a
-- country with live rows. A btree on an array could answer only equality.
CREATE INDEX IF NOT EXISTS jobs_live_place_keys_idx ON jobs USING gin (place_keys)
  WHERE status <> 'killed';
