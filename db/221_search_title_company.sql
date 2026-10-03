-- 221_search_title_company.sql: a second, small search vector, for the only weights a prefix may match.
--
-- WHY. db/219 gave the board one weighted vector, jobs.search, and the query
-- ticket wrote each typed word as ('w' | 'w':*AB): the whole word anywhere, or a
-- prefix of a word in the title or company. A GIN index stores a lexeme and the
-- rows that carry it, not the weight each carries it at, so it cannot answer the
-- weights. For `des:*AB` it names every row with ANY word starting "des"
-- (17,775 of 37,286 live rows, nearly all through "description" or "designed" in
-- a posting), and Postgres then reads each of those rows' vectors, 4,487 bytes
-- on average and kept out of line, to keep the 773 whose match is in a title or
-- company and throw the rest away. The index was cheap and the recheck was not.
-- Measured on 2026-10-02, local board, warm: the board for "engineer" took 200
-- ms at the median, "des" 158 ms, "product des" 139 ms, and the suggestion
-- panel's count for a typed "des" 270 ms, cold.
--
-- THE FIX IS A SECOND VECTOR, NOT A SMARTER QUERY. jobs.search_tc holds the title
-- (A) and company (B) of jobs.search and nothing else, so a prefix in it needs no
-- weight to say where it matched, and its index answers the prefix exactly: 108
-- bytes a row on average (326 at most, 4.0 MB for all 37,765 rows, against 162
-- MB for jobs.search) and a 1.9 MB index, against 80 MB for jobs_search_idx. A
-- word is then
--
--     search_tc @@ 'w':*   OR   search @@ 'w'
--
-- which is the same set of rows as search @@ ('w' | 'w':*AB): every position
-- search_tc holds is a position search holds, at the same weight (it is the same
-- function's A and B parts, see below), and OR and AND carry across @@ for a
-- query with no NOT. src/lib/job-store.ts writes the words that way and
-- job-store.db.test.ts holds it to the old form, row for row, over every row of
-- the table. The planner then has an index for each half and can join them: a
-- BitmapOr per word and a BitmapAnd across words.
--
-- ONE DEFINITION. jobs_search_tc_vector() below is the only place the title and
-- company text is defined. jobs_search_vector() (db/219) is replaced here by the
-- same function with its A and B parts calling it, so the column this file adds
-- and the A and B part of jobs.search cannot differ: they are one expression.
-- ts_filter(search, '{a,b}') is the A and B part of any search value, and on
-- every row search_tc is equal to it (0 of 37,765 differ), and search is equal
-- to what the replaced function computes (0 of 37,765 differ), so the 12 s fill
-- below touches only the new column and nothing needs to refill jobs.search.
-- The department and description parts are db/219's, character for character,
-- with the reasoning that is written above them there.
--
-- THE SAME THREE SEGMENTS AS db/219, for the same reasons (ADD COLUMN takes
-- ACCESS EXCLUSIVE until the transaction ends, and a plain CREATE INDEX takes
-- SHARE, so one transaction would hold the table through the fill and the build):
--
--   1. The two functions, the trigger function, ADD COLUMN. The trigger itself is
--      db/219's: it calls jobs_search_refresh() by name, and that function now
--      sets both columns, so the trigger is not recreated and takes no lock. The
--      new function version and the new column become visible together at the
--      COMMIT, so no write can reach a trigger that names a column that is not
--      there yet.
--   2. The fill: one UPDATE of every row still NULL, under row locks.
--   3. The index. migrate.mjs commits it and records the file.
--
-- Not atomic, and re-runnable from any point, as 219 is: CREATE OR REPLACE, IF NOT
-- EXISTS, and a fill that touches only rows still NULL.
--
-- WHAT IT COSTS, measured on 2026-10-02 against the local board (37,765 rows,
-- 37,286 live), with other work on the machine (load average 3 to 7):
--
--   * Locks. ADD COLUMN waits for any read already running on jobs, and a read
--     that arrives meanwhile queues behind it: it waited 173 ms behind a board
--     read once, and up to 1.1 s behind a longer one in the probe below, and the
--     5 s bound is what stops that from being a freeze. Once it has the lock it
--     holds it from ALTER to COMMIT for 0.6 ms at the median and 2.5 ms at the
--     most over 12 runs.
--   * Reads and writes while it ran: a one-row SELECT every 15 ms through the
--     fill (4,386 probes) had a median of 0.3 ms, and its only slow probe was
--     that wait for the lock. A ROW EXCLUSIVE probe (the lock an INSERT takes)
--     every 100 ms stalled once, for 84 ms, while the index built, and not at all
--     during the fill.
--   * Time: the fill took 11.9 s and the index 0.12 s.
--   * Storage: the table, its TOAST and its indexes went from 665 MB to 670 MB.
--     The fill leaves a dead version of every row until autovacuum reclaims it,
--     as 219's did (the heap measured 79 MB before and after).
--   * Queries, through the two indexes, local and warm: the count statement for
--     "engineer" 28 ms and the page 64 ms (the page's time is ranking 6,218 rows
--     against the whole vector, which is unchanged). The whole of "des" went
--     from 158 ms to 35 ms at the median and "product des" from 139 to 20.
--   * THE NIGHTLY LOAD, which is the cost to remember. scripts/ingest-jobs.mjs
--     computes the trigger for every row it inserts, and the trigger now builds a
--     second small vector. Measured as db/219 measured it, a bulk insert of all
--     37,765 rows into a session-local temp table carrying the trigger and every
--     index, alternated before and after in one session so the machine's load is
--     the same for both: 20.3 s at the median for the
--     trigger as 219 had it (no search_tc, no index on it; six runs, 20.2 to
--     20.4 s) and 20.6 s with this file's (five runs, 20.6 to 21.5 s). That is
--     +0.3 s, 1.7%. The new work is two more to_tsvector calls on strings of a few
--     dozen characters and one insert into a 1.9 MB index; the 20 s is still the
--     description, as 219 found. (219 measured 21.4 s on a busier day.)
--
-- THE PLANNER NEEDS TELLING, AND src/lib/job-store.ts TELLS IT. Left to itself it
-- priced `search @@ 'w'` as one cheap operator, when it reads and decompresses a
-- 4.5 KB value per row it does not already reject, and chose a sequential scan
-- of the whole table for any word a sixth of the board carries ("engineer": the
-- bitmap plan was costed 11,786 and the scan 11,730). The scan took 100 to 250
-- ms and the bitmap 12 to 17 ms. Statements that carry words are therefore run
-- under random_page_cost = 1.1, in their own transaction (runStatement, with the
-- measurements). Nothing here sets it, and nothing outside those statements is
-- planned any differently. Whether Neon's planner makes the same near-tie choice
-- was not measured: these are local numbers.

-- THE TITLE AND COMPANY, defined once. Exactly the A and B parts of
-- jobs_search_vector() in db/219: the same simple config, the same f_unaccent,
-- the same coalesce for a NULL, qualified names for the same reason as there.
CREATE OR REPLACE FUNCTION jobs_search_tc_vector(title text, company text)
  RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT setweight(to_tsvector('pg_catalog.simple', public.f_unaccent(coalesce(title, ''))),   'A') ||
           setweight(to_tsvector('pg_catalog.simple', public.f_unaccent(coalesce(company, ''))), 'B')
  $$;

-- THE WHOLE VECTOR, now built from it. db/219's body with its first two terms
-- replaced by the call and nothing else changed: `a || b || c || d` and
-- `(a || b) || c || d` are the same value, because || on tsvectors is associative
-- and the left operand's positions are what the right one is shifted by.
-- department (C) and description (D) are db/219's, with the reasoning there.
CREATE OR REPLACE FUNCTION jobs_search_vector(title text, company text, department text, description text)
  RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT public.jobs_search_tc_vector(title, company) ||
           setweight(to_tsvector('pg_catalog.simple', public.f_unaccent(coalesce(department, ''))), 'C') ||
           setweight(to_tsvector('pg_catalog.simple', public.f_unaccent(left(
             regexp_replace(coalesce(description, ''),
                            '<[/!a-zA-Z](?:"[^"]*"|''[^'']*''|[^>"''])*>?', ' ', 'g'),
             200000))), 'D')
  $$;

-- THE TRIGGER FUNCTION, db/219's with one more line. The trigger that calls it
-- (jobs_search_refresh_trg, BEFORE INSERT OR UPDATE OF title, company,
-- department, description) is unchanged, and a write that touches none of the
-- four still pays for neither vector. search_tc needs only title and company, and
-- is also recomputed when only department or description is written: two short
-- strings, a few microseconds, and one trigger is easier to be right about than two.
CREATE OR REPLACE FUNCTION jobs_search_refresh() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    NEW.search    := public.jobs_search_vector(NEW.title, NEW.company, NEW.department, NEW.description);
    NEW.search_tc := public.jobs_search_tc_vector(NEW.title, NEW.company);
    RETURN NEW;
  END
  $$;

-- SEGMENT 1 ENDS HERE. The lock is ACCESS EXCLUSIVE from ADD COLUMN to the COMMIT
-- below, a COMMENT apart, and a bounded wait for the reasons given in db/219: the
-- lock waits for every read in flight and every later read waits for it.
--
-- No default and no GENERATED clause, so nothing is rewritten: every row reads
-- NULL until the fill. A query that reads search_tc before then (none does: the
-- board's code and this file ship together) would find those rows matching nothing.
SET LOCAL lock_timeout = '5s';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS search_tc tsvector;

COMMENT ON COLUMN jobs.search_tc IS
  'Title (A) and company (B) of jobs.search and nothing else: same simple config, same unaccent, same positions. The only weights a prefix may match, kept apart so a prefix probe reads a few words and not a posting. Written only by trigger jobs_search_refresh_trg and the fill in db/221, both through jobs_search_tc_vector().';

COMMIT;
BEGIN;

-- SEGMENT 2: THE FILL. Row locks only, so readers keep reading while it runs.
-- WHERE search_tc IS NULL so a re-run, and rows a concurrent writer already
-- filled through the trigger, are not rewritten. jobs_search_tc_vector() never
-- returns NULL (both parts are coalesced). This UPDATE names only search_tc, so
-- the trigger, which fires on the four source columns, does not run.
--
-- It rewrites every row once, which leaves a dead version of each until
-- autovacuum reclaims it. 11.9 s here, for 37,765 rows.
UPDATE jobs
   SET search_tc = jobs_search_tc_vector(title, company)
 WHERE search_tc IS NULL;

COMMIT;
BEGIN;

-- SEGMENT 3: THE INDEX. A plain CREATE INDEX takes SHARE, which blocks writes to
-- jobs while it builds (0.12 s here) and never blocks a read. Not CONCURRENTLY,
-- for db/219's reason. migrate.mjs commits this segment and records the file.
--
-- PARTIAL ON THE LIVE ROWS, as jobs_search_idx is and for the same reason: every
-- query the board makes carries "status <> 'killed'" literally, so Postgres can
-- match this predicate, and one that leaves it out will not use this index. The
-- title and company of a killed row are not searched through it.
CREATE INDEX IF NOT EXISTS jobs_search_tc_idx ON jobs USING gin (search_tc) WHERE status <> 'killed';
