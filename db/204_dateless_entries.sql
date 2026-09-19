-- 204_dateless_entries.sql
--
-- A skill, an artifact or a recognition may carry no start date.
--
-- WHY. db/104 made start_year NOT NULL on the reasoning that "every entry
-- happened in some year the person can name". That is true of a role, a degree
-- and a project, and it is not true of the other three kinds as a resume
-- actually writes them: a skills line ("Figma, TypeScript, Postgres"), a
-- certification with no year, an award with no date. The resume parser
-- (src/lib/resume-parse.ts) could only honour the schema by dropping every
-- such entry, and it did, silently, behind "N entries were left out". The
-- owner wants skills read off a resume like everything else, so the column
-- has to be able to hold "no date" for the kinds where no date is honest.
--
-- WHAT CHANGES, AND WHAT DOES NOT. start_year becomes nullable at the column
-- level, and a CHECK keyed on kind keeps it mandatory for role_held, education
-- and project, the same shape db/104 already uses for employer_or_institution
-- (nullable column, required by CHECK for the kinds where its absence would be
-- a claim nobody could verify). Two companion CHECKs keep the partial-date
-- rules coherent when the start is absent: a start month with no start year
-- identifies nothing (the mirror of db/104's end_month rule), and an end with
-- no start is not a range this record can print. A NULL start_year on a
-- skill means "this fact has no date", the same way a NULL end_year means
-- "still there": a real state, not a gap to chase down. Every reader that
-- prints a date range treats it as "print no range" (src/lib/entry-dates.ts).
--
-- HOW THIS REACHES EACH DATABASE. A production build applies it on its own:
-- scripts/ingest-on-build.mjs runs db/migrate.mjs on every production build,
-- before the deploy goes live, so production is never running code that
-- writes a NULL start_year against a column that refuses one. Preview builds
-- and local builds apply nothing (the same script leaves every non-production
-- database alone), so a preview or local database needs
--
--   npm run db:migrate
--
-- by hand. Until it is applied there, an undated skill fails the insert with a
-- not-null violation and the parser's apply step counts it as failed rather
-- than created.
--
-- ADDITIVE, AND RE-RUNNABLE. Dropping NOT NULL and adding CHECKs that every
-- existing row already satisfies (they all have a start_year) touches no data.
-- The DROP CONSTRAINT IF EXISTS before each ADD makes a second run a no-op,
-- the same posture the migrations before this take with IF NOT EXISTS.
--
-- REVERSIBLE. To undo, first give every undated row a year or remove it
-- (UPDATE record_entry SET start_year = ... WHERE start_year IS NULL, or
-- DELETE those rows), then:
--
--   ALTER TABLE record_entry DROP CONSTRAINT IF EXISTS record_entry_start_year_by_kind;
--   ALTER TABLE record_entry DROP CONSTRAINT IF EXISTS record_entry_start_month_needs_year;
--   ALTER TABLE record_entry DROP CONSTRAINT IF EXISTS record_entry_end_needs_start;
--   ALTER TABLE record_entry ALTER COLUMN start_year SET NOT NULL;

ALTER TABLE record_entry ALTER COLUMN start_year DROP NOT NULL;

ALTER TABLE record_entry DROP CONSTRAINT IF EXISTS record_entry_start_year_by_kind;
ALTER TABLE record_entry ADD CONSTRAINT record_entry_start_year_by_kind
  CHECK (kind IN ('skill', 'artifact', 'recognition') OR start_year IS NOT NULL);

ALTER TABLE record_entry DROP CONSTRAINT IF EXISTS record_entry_start_month_needs_year;
ALTER TABLE record_entry ADD CONSTRAINT record_entry_start_month_needs_year
  CHECK (start_month IS NULL OR start_year IS NOT NULL);

ALTER TABLE record_entry DROP CONSTRAINT IF EXISTS record_entry_end_needs_start;
ALTER TABLE record_entry ADD CONSTRAINT record_entry_end_needs_start
  CHECK (end_year IS NULL OR start_year IS NOT NULL);
