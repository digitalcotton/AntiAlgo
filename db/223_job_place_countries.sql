-- 223_job_place_countries.sql: jobs.place_countries: the countries a posting lists, as one short string.
--
-- WHY. db/222 gave the board place_keys, every key of every place a posting lists,
-- and the Location list counts the postings under each country by unnesting them:
-- the per-row facet statement carries place_keys through its materialised flags and
-- turns every row into one row per key (2.87 keys a row on average) to keep the two
-- letter ones. Measured on 2026-10-02 against the local board, that is about 22 ms
-- for the whole board where grouping the old place_country column was 2, and it is
-- the reading of the arrays, not the grouping, that costs it: counting only
-- place_keys[1] was 5 ms cheaper and counted the wrong thing. The board's no-words
-- p95 went from 108.8 to 120 ms for it (docs/search-engine-metrics.md).
--
-- THE FIX IS A COLUMN THE FACET CAN GROUP BY. place_countries holds the distinct two
-- letter country keys of place_keys, sorted and joined by one space, so a posting
-- that lists the United Kingdom and Germany reads 'DE GB' and one that lists no
-- place reads ''. Only 262 different strings cover the live board (1.7 characters a
-- row on average), so the facet groups the rows by this one short value first, and
-- splits each of the groups once. The
-- numbers are exactly the ones the unnest gave: a row is counted once under each
-- country its string names.
--
-- WRITTEN BY ONE DEFINITION, as db/220 and db/222 are: derivedFor() in
-- src/lib/jobs-derived.mjs, called by scripts/ingest-jobs.mjs on every row of every
-- crawl and by scripts/backfill-derived.mjs for rows already on file. It is the
-- country keys of place_keys and nothing else (a test holds the two equal for every
-- live row), and nothing restates it in SQL.
--
-- NOT NULL DEFAULT '', AND WHY THAT IS SAFE HERE. A constant default is a catalog
-- change from Postgres 11 on, so the ADD COLUMN takes the table lock for
-- milliseconds and rewrites nothing, as db/222's did. '' is "lists no place", the
-- same answer an empty place_keys gives.
--
-- THIS FILE DOES NOT FILL IT, for db/222's reason: the string comes from the
-- JavaScript reading rule, and a second copy in SQL is the drift this repo is built
-- against. Every existing row reads '' until the ingest or the backfill writes it,
-- and until then the Location list counts every posting as Not stated: run
-- `node scripts/backfill-derived.mjs --all` after the migration, as for db/222 (the
-- deploy runbook in docs/search-engine-report.md says so).
--
-- ONE TRANSACTION, NO INDEX. db/222 ends its transaction between the columns and the
-- GIN index so the index build does not hold the table. This file has no index and no
-- fill, so nothing slow follows the ALTER and there is nothing to split.
-- migrate.mjs has already opened the transaction and closes and records it.
--
-- WHAT IT COSTS, measured on 2026-10-02 against the local board (37,765 rows, 37,286
-- live), Postgres 17: the ALTER to the COMMIT held the table for 1.4 to 14 ms, median
-- 1.4 (nine runs rolled back); the fill, `backfill-derived.mjs --all`, took 22 s for
-- 37,765 rows, 31,105 of them written, under row locks (readers keep reading), and
-- the column is 119 kB for the live rows. See the db/222 note on dead row versions
-- and on running VACUUM ANALYZE jobs after a bulk fill.

-- A BOUNDED WAIT, as in db/219 and db/222: ADD COLUMN waits for every read in flight
-- on jobs and every read that arrives after it queues behind it, so an unbounded wait
-- behind one slow query freezes the live board for as long as that query runs. Five
-- seconds, then the migration fails, the build fails, and the deployment already
-- serving keeps serving.
SET LOCAL lock_timeout = '5s';
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS place_countries text NOT NULL DEFAULT '';

COMMENT ON COLUMN jobs.place_countries IS
  'The distinct two letter country keys of place_keys, sorted and joined by one space (DE GB); empty = the posting lists no place. What the Location facet groups by. Written by derivedFor() (src/lib/jobs-derived.mjs); never by SQL.';
