-- 219_search_text.sql: the board's text search, as a column, a trigger and indexes.
--
-- WHY. The board's text box ran title ILIKE '%q%' OR company ILIKE '%q%': a
-- sequential scan of every row (db/117 said so, and named pg_trgm as the fix
-- once the board grew), no ranking, no tolerance for a typo, and it never read
-- a word of the description. docs/search-engine-design.md section 5.1 replaces
-- it with two things Postgres already knows how to do:
--
--   * jobs.search, a weighted tsvector, for matching whole words and ranking
--     them: a word in the title outranks the same word in the description.
--   * trigram indexes on title and company, for what a tsvector cannot do: a
--     half-typed word ("desi" finds "Designer") and a misspelt one ("prodct"
--     finds "Product").
--
-- Nothing reads these yet. The query ticket (E) is the first reader, so this
-- file changes no behaviour, only what a later query is allowed to be fast at.
--
-- WHY A TRIGGER AND NOT A GENERATED COLUMN. The design's first sketch, and the
-- first version of this file, was GENERATED ALWAYS AS (...) STORED, which is the
-- obvious shape and is wrong for this table. Postgres cannot add a stored
-- generated column without rewriting the table, the rewrite takes ACCESS
-- EXCLUSIVE, and ACCESS EXCLUSIVE blocks every read of jobs, not only writes.
-- db/migrate.mjs runs a file inside one transaction and an ALTER TABLE's lock
-- lasts until its transaction ends (checked: a reader stalled 2.41 s behind a
-- 3 s ALTER TABLE that had not yet committed), so the board would have been
-- unreadable for the whole file. Measured on 2026-10-02, local board, 37,765
-- rows: the generated version took 21.3 s to apply, all of it under that lock,
-- and on Neon the rewrite would also have run during a deploy build.
--
-- A plain nullable column with no default is a catalog change and takes the lock
-- for milliseconds. A trigger keeps it current and one UPDATE fills it. The cost
-- of the trade is that a trigger is a rule the database follows only when a
-- write names one of the four source columns, where a generated column could
-- not be skipped:
--   * INSERT, INSERT ... ON CONFLICT DO UPDATE with any of the four in its SET
--     list, and UPDATE ... SET title (or the others) all refresh the column.
--     An UPDATE that sets none of the four leaves it as it was.
--   * An UPDATE that sets only search itself does not fire the trigger. Nothing
--     in this repo writes search; the only writers are the trigger and the fill
--     below, and both call jobs_search_vector().
--   * Changing the definition is a migration that CREATE OR REPLACEs
--     jobs_search_vector() and refills the rows. Nothing refills them by itself.
--
-- ONE DEFINITION. jobs_search_vector() below is the only place the search text
-- is defined. The trigger calls it and so does the fill; a later backfill or a
-- query that needs the same text calls it too. No query, script or test
-- restates the expression.
--
-- WHY THIS FILE ENDS ITS TRANSACTION TWICE. Because the ALTER TABLE's lock lasts
-- until the transaction ends, leaving the file as one transaction would keep
-- ACCESS EXCLUSIVE on jobs through the fill and all three index builds, which is
-- the whole 20 seconds again. So the file is three transactions, with COMMIT;
-- BEGIN; between them (migrate.mjs has already opened the first, and closes and
-- records the last):
--
--   1. The extensions, both functions, ADD COLUMN, the trigger. ACCESS
--      EXCLUSIVE is taken at ADD COLUMN and released at the first COMMIT, a few
--      statements later. Everything slow is done before it, on no table.
--   2. The fill: one UPDATE of every row still NULL. It takes row locks and
--      ROW EXCLUSIVE, which readers do not wait for (MVCC); a reader sees the
--      old row until this commits. A writer of one of the same rows would wait.
--   3. The three indexes. A plain CREATE INDEX takes SHARE, which blocks writes
--      but not reads. CONCURRENTLY would block neither and is refused inside a
--      transaction; with no writer on this table during a deploy build, the
--      write block is the lesser cost.
--
-- The cost is that the file is not atomic. A failure after the first commit
-- leaves the column, the functions and the trigger in place and the migration
-- unrecorded, and migrate.mjs rolls back only the segment that was open. Every
-- statement is written to be run again (IF NOT EXISTS, CREATE OR REPLACE, DROP
-- TRIGGER IF EXISTS, a fill that touches only rows still NULL), so re-running
-- resumes where it stopped.
--
-- THE NIGHTLY REPLACE IS A SEPARATE READ LOCK, AND THIS FILE DOES NOT FIX IT.
-- scripts/ingest-jobs.mjs takes ACCESS EXCLUSIVE on jobs, TRUNCATEs it and
-- inserts every row in one transaction, so readers wait for the whole load. That
-- was already true; this file makes the load longer, because the trigger
-- computes the column for every row inserted. Measured on 2026-10-02 as a bulk
-- insert of all 37,765 rows into a session-local temp table carrying the
-- trigger and every index: 21.4 s, against 1.4 s before this file. The
-- generated column took 20.3 s the same way, so moving to a trigger changes
-- where the work happens and not how much: about 15 s is to_tsvector over about
-- 129 million characters of description once the markup is gone. A follow-up
-- ticket changes the replace from TRUNCATE to DELETE so readers keep reading
-- while the load runs. Until it ships, the board is held shut for the load, and
-- about 20 s of that is this column.
--
-- THE TWO EXTENSIONS. pg_trgm and unaccent both ship with Postgres and are
-- marked trusted (since 13), so installing them does not need superuser. They
-- are pinned to schema public so that the wrapper below, which names
-- public.unaccent, is true wherever the database was built.
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

-- WHY A WRAPPER. unaccent(regdictionary, text) is declared STABLE, because the
-- dictionary it reads can in principle change under a running session. An index
-- expression, and a function declared IMMUTABLE that jobs_search_vector() leans
-- on, both demand IMMUTABLE, so unaccent() cannot be called from it directly.
-- This is the standard answer: pin the dictionary by name, and declare the
-- pinned call IMMUTABLE.
--
-- That declaration is a promise made on Postgres's behalf: the stored values
-- stay right only while unaccent.rules is unchanged. If a Postgres upgrade ever
-- changes a rule, the stored column keeps the old mapping until a row is
-- rewritten. The nightly replace re-inserts every live row, so a changed rule
-- repairs itself on live rows within one crawl.
--
-- What it buys: Vertriebsaussendienst and Vertriebsaußendienst are one word,
-- Zurich and Zürich are one word, and so on across the languages on the board.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- THE DEFINITION. title (A), company (B), department (C), description (D).
--
-- THE 'simple' CONFIG, NOT 'english'. Titles on this board are multilingual:
-- German, Dutch and French appear next to English (Projektingenieur,
-- Magazijnmedewerker, Werkstudent), and 2,601 of 37,765 local titles or
-- company names carry a non-ASCII character. The english config would stem
-- every one of those by English rules and mangle them. simple lowercases and
-- splits on word boundaries and nothing more, so a word is found as it was
-- typed. The cost is that "design" does not find "designing"; the trigram
-- indexes below and the prefix form of the query (design:*) cover that. A
-- trailing prefix over all four weights also reads descriptions: desi:* matched
-- 12,644 live rows, mostly through "desired". Limited to titles and companies
-- ('desi':*AB) it matched 659.
--
-- NOT STRICT, and NULL-SAFE BY coalesce. department and description are
-- nullable on this table; a STRICT function would return NULL for the whole
-- vector when either was, and a NULL search matches nothing, not even the title.
--
-- NAMES ARE QUALIFIED (public.f_unaccent, pg_catalog.simple). A SQL function
-- body is resolved when it is called, with the caller's search_path, so a
-- trigger fired from a session with another path would otherwise look for them
-- somewhere else.
--
-- WHAT THE DESCRIPTION IS. Employer HTML, kept with its markup because it
-- renders verbatim (scripts/ingest-jobs.mjs, cleanDescription). Three choices
-- below guard it, and the title, company and department need none of them
-- (their longest values on file are 186, 72 and 744 characters).
--
--   1. Markup is removed before the cap. A tsvector is limited to 1,048,575
--      bytes and a function that exceeds it does not skip the row, it raises,
--      which fails the INSERT. The nightly replace is one transaction
--      (scripts/ingest-jobs.mjs), so one oversized description would roll back
--      the whole night's load: the board keeps yesterday's rows and stops
--      updating until someone finds the one row. The cap is on the tsvector,
--      not on the text put in: the parser reads a whole <img ...> tag as one
--      token and indexes none of it.
--
--      Measured on 2026-10-02, local board, 37,765 rows, 36,672 with a
--      description: median 4,013 characters, p99 23,841, p99.9 43,340, longest
--      2,993,613. Twelve rows exceed 50,000 characters and four exceed
--      200,000; all four are Teamtailor postings carrying an inline
--      <img src="data:image/...;base64,..."> tag. The parser reads each of
--      those as one tag token, so the 3 MB row is a 2,858 byte tsvector and the
--      largest tsvector on the board, over the whole description and with no
--      guard at all, is 19,978 bytes: 52 times under the limit. Nothing here
--      is close. The guard is for the day an upstream feed sends something the
--      parser does not recognise as a tag.
--
--      Why not simply left(description, N)? Measured with N = 200,000: a cut
--      that lands inside an unclosed <img src="data:... leaves a tag the parser
--      can no longer recognise, so the rest of the base64 is indexed as words.
--      The four Teamtailor rows grew from 0.5 to 6.3 KB each to 218 to 229 KB
--      of random fragments, any of which a prefix search could hit by accident.
--      Removing markup first means a cut can only fall in text.
--
--   2. The tag pattern is '<' followed by a letter, '/' or '!', then quoted
--      strings or anything but '>', closed by '>' or by the end of the text.
--      A letter is required so "pay < 100k" is not a tag. A quoted string is
--      read whole so a '>' inside an attribute does not end the tag early. A
--      tag left open at the end of the text, which is what a feed that
--      truncated its own HTML leaves, is removed to the end. Each tag becomes
--      a space so the words either side of it stay separate. Against the
--      parser's own handling of the same markup, over every row: 139 of
--      37,765 differ, by at most eight lexemes. What differs is a lone ".."
--      token (120 rows), numbers and words that carried a "~" from the
--      neighbouring tag (21), and seven URL-shaped tokens. No ordinary word is
--      lost.
--
--   3. N = 200,000 characters, after the markup is gone. The longest
--      description on the board with its markup removed is 19,265 characters
--      and p99.9 is 14,274, so the cap bites on no row today and is ten times
--      the longest real text. The worst case for the limit is text of distinct
--      tokens, which is what costs bytes. Measured at exactly 200,000
--      characters, across tokens of 3, 6, 10 and accented 6 characters: at most
--      448,162 bytes, so the limit is 2.3 times that worst case (the limit
--      itself is reached by about 800,000 characters of distinct six-character
--      tokens, which raised "string is too long for tsvector" in the same
--      test). The cap comes before f_unaccent so the work unaccent does is
--      bounded as well.
CREATE OR REPLACE FUNCTION jobs_search_vector(title text, company text, department text, description text)
  RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT setweight(to_tsvector('pg_catalog.simple', public.f_unaccent(coalesce(title, ''))),      'A') ||
           setweight(to_tsvector('pg_catalog.simple', public.f_unaccent(coalesce(company, ''))),    'B') ||
           setweight(to_tsvector('pg_catalog.simple', public.f_unaccent(coalesce(department, ''))), 'C') ||
           setweight(to_tsvector('pg_catalog.simple', public.f_unaccent(left(
             regexp_replace(coalesce(description, ''),
                            '<[/!a-zA-Z](?:"[^"]*"|''[^'']*''|[^>"''])*>?', ' ', 'g'),
             200000))), 'D')
  $$;

-- THE TRIGGER FUNCTION. BEFORE, so the value is part of the row as written and
-- costs no second write. It sets the column from the NEW row's own four fields,
-- so on an ON CONFLICT DO UPDATE it sees the values the update is about to
-- store, not the ones it replaces.
CREATE OR REPLACE FUNCTION jobs_search_refresh() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    NEW.search := public.jobs_search_vector(NEW.title, NEW.company, NEW.department, NEW.description);
    RETURN NEW;
  END
  $$;

-- SEGMENT 1 ENDS HERE. ADD COLUMN takes ACCESS EXCLUSIVE on jobs; the trigger
-- takes SHARE ROW EXCLUSIVE, which readers do not wait for; the COMMIT below
-- releases both. Nothing slow is between the lock and the commit.
--
-- No default and no GENERATED clause, so nothing is rewritten and no row is
-- touched: every existing row reads NULL until the fill below.
--
-- A BOUNDED WAIT. ADD COLUMN must wait for every read already in flight on
-- jobs, and every read that arrives after it queues behind it, so an unbounded
-- wait behind one slow query freezes the live board for as long as that query
-- runs. Five seconds, then the migration fails, the build fails, and the
-- deployment already serving keeps serving. A failed deploy is retried; a
-- frozen board is what a reader sees.
SET LOCAL lock_timeout = '5s';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS search tsvector;

COMMENT ON COLUMN jobs.search IS
  'Weighted full-text vector: title A, company B, department C, description D (markup removed, first 200,000 characters). simple config, unaccented. Written only by trigger jobs_search_refresh_trg and the fill in db/219, both through jobs_search_vector().';

-- UPDATE OF names the four source columns, so a write that touches none of them
-- (the crawl's last_seen bump, a kill) does not pay for the vector.
DROP TRIGGER IF EXISTS jobs_search_refresh_trg ON jobs;
CREATE TRIGGER jobs_search_refresh_trg
  BEFORE INSERT OR UPDATE OF title, company, department, description ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_search_refresh();

COMMIT;
BEGIN;

-- SEGMENT 2: THE FILL. Row locks only, so readers keep reading while it runs.
-- WHERE search IS NULL so a re-run after a failure, and rows a concurrent writer
-- already filled through the trigger, are not rewritten. jobs_search_vector()
-- never returns NULL (every part is coalesced and an empty tsvector is not
-- NULL), so no row is left behind. This UPDATE names only search, so the
-- trigger, which fires on the four source columns, does not run a second time.
--
-- It rewrites every row once, which leaves a dead version of each in the heap
-- and in the 14 existing indexes until autovacuum reclaims them. Autovacuum had
-- run and left 0 dead tuples by the time I looked; the space is reusable but the
-- file does not shrink (the heap measured 78.8 MB afterwards, against 40.9 MB
-- when a table rewrite had just compacted it).
UPDATE jobs
   SET search = jobs_search_vector(title, company, department, description)
 WHERE search IS NULL;

COMMIT;
BEGIN;

-- SEGMENT 3: THE INDEXES. A plain CREATE INDEX takes SHARE, which blocks writes
-- to jobs while each builds and never blocks a read. They are not CONCURRENTLY
-- because that cannot run inside a transaction block and this file is run by
-- db/migrate.mjs inside one. migrate.mjs commits this segment and records the
-- file.
--
-- PARTIAL ON THE LIVE ROWS, as in db/207: every query the board makes carries
-- "status <> 'killed'" literally, so Postgres can match this predicate. A query
-- that leaves it out will not use this index.
CREATE INDEX IF NOT EXISTS jobs_search_idx ON jobs USING gin (search) WHERE status <> 'killed';

-- NOT PARTIAL. The board reads killed rows too (the base CTE in
-- src/lib/job-store.ts joins board_kills and dates a killed row from its kill),
-- so a title or company lookup must be able to reach them. The cost is the
-- minority of rows that are killed (479 of 37,765 locally).
--
-- gin_trgm_ops serves %, <% (word_similarity), LIKE and ILIKE, so it also
-- takes the legacy ILIKE path off a sequential scan until that path goes. It
-- cannot order by similarity: a query sorts the rows the index returns.
CREATE INDEX IF NOT EXISTS jobs_title_trgm_idx   ON jobs USING gin (title   gin_trgm_ops);
CREATE INDEX IF NOT EXISTS jobs_company_trgm_idx ON jobs USING gin (company gin_trgm_ops);

-- WHAT IT COSTS, measured on 2026-10-02 against the local board (37,765 rows,
-- 37,286 live):
--
--   * npm run db:migrate took 27.3 s wall for this file: about 23 s the fill,
--     4 s the three index builds, and under 10 ms the one step that holds
--     ACCESS EXCLUSIVE.
--   * Reads: a probe selecting one row ran every 15 ms through the whole
--     migration, 1,812 times. Its median was 0.3 ms and its maximum 11 ms. No
--     read waited.
--   * The ACCESS EXCLUSIVE window, from ALTER TABLE to COMMIT, measured 1.3 ms
--     median and 6.6 ms maximum over 8 runs; ADD COLUMN alone was 0.3 ms median
--     and 0.9 ms maximum. It waits for any read already running on jobs, and
--     while it waits, new reads queue behind it.
--   * Writes: a probe taking ROW EXCLUSIVE, the lock an INSERT takes, stalled
--     once, for 4.0 s, while the indexes built, and not at all during the fill.
--   * Storage: the search values total 162 MB (4,488 bytes on average, 20,012
--     at most). jobs_search_idx is 35.8 MB, the title trigram index 5.1 MB, the
--     company one 2.0 MB. The table file measured 190.7 MB before and 619.7 MB
--     after; that figure is inflated on this database by space left from having
--     carried and then dropped the generated version, and by the dead versions
--     the fill leaves. A database that never had the generated column lands
--     lower, and none of it shrinks without VACUUM FULL, which takes the lock
--     this file exists to avoid.
--   * Queries: a one-word tsquery on live rows (designer, 385 rows) uses
--     jobs_search_idx in 0.5 to 1.2 ms. A typo query (title % 'prodct
--     desiner') uses jobs_title_trgm_idx in 14 to 20 ms, and its best matches
--     are all "Product Designer".
--   * Every stored value equals what the generated version computed: 0 of
--     37,765 rows differ.
