-- 210_board_kills_job_slug_not_unique.sql
--
-- board_kills.job_slug stops being UNIQUE. Several kills may name one board
-- row, and the rest of this codebase has always known that.
--
-- WHAT BROKE. The production build of 2026-09-26T10:03Z failed:
--
--   FAILED after staging 37765 row(s); rolled back, the board is unchanged:
--   duplicate key value violates unique constraint "board_kills_job_slug_idx"
--
-- ingest-on-build.mjs did exactly what it should -- refused to publish and
-- failed the build, so the board kept its old rows rather than being replaced
-- by a half load. But the board has not moved since, and it cannot move until
-- the constraint that refused it is the right constraint.
--
-- WHY THE UNIQUE WAS WRONG, AND NOT JUST INCONVENIENT. Two reasons, either one
-- on its own enough:
--
--   1. THE INGEST ALREADY DOCUMENTS THE OPPOSITE. scripts/ingest-jobs.mjs
--      picks "the kill of record for a row with several" -- a SELECT DISTINCT
--      ON (url) ordered by first_killed_at_utc and then by rule precedence.
--      That statement exists precisely because one posting can be killed under
--      more than one rule. A kill's id is sha1(url|rule)[:12], so the same URL
--      under two rules is two rows, and the join by URL then hands both of
--      them the same j.slug. The unique index made the file's own design
--      unrepresentable.
--
--   2. NO READER NEEDS IT. The only reader of this column,
--      getBoardJobBySlug() in src/lib/job-store.ts, already expects more than
--      one and chooses between them:
--
--        WHERE k.job_slug = $1 AND k.vacated_at IS NULL
--        ORDER BY k.first_killed_at_utc ASC NULLS LAST LIMIT 1
--
--      A unique index is not what makes that query correct; the ORDER BY is.
--      And the index did not even cover the case the reader cares about: it
--      is unique over every row with a job_slug, vacated or not, so a kill
--      withdrawn by hand still held its slug against a live one.
--
-- WHAT TONIGHT'S DATA ACTUALLY HIT. Two slugs, both repost_churn kills on two
-- different Teamtailor postings that share a computed slug:
--
--   busuu-freelance-online-japanese-teacher-remote-1y6m01
--   benedic-1721128878-gestionnaire-de-copropri-t-h-f-1y6oc1
--
-- THAT SHARING IS A SECOND, SEPARATE FAULT and this migration does not fix
-- it: slugFor() in scripts/ingest-jobs.mjs builds its tail with
-- `h.toString(36).slice(0, 6)`, and a 32-bit djb2 value is up to SEVEN base-36
-- characters, so the slice drops the last digit and collapses every block of
-- 36 neighbouring hashes into one tail. 117 slugs in tonight's feed are shared
-- by two rows for that reason. Fixing it changes public /board/<slug>
-- addresses, so it is an owner's call and its own change; it is written down
-- here so the next reader of this file knows the collision has a cause and
-- that the cause is still standing.
--
-- KEPT AS AN INDEX. job_slug is looked up by equality on every closed-page
-- read, so the column keeps a plain index; only the uniqueness goes.
--
-- HOW THIS REACHES EACH DATABASE. Production applies it on its own:
-- scripts/ingest-on-build.mjs runs db/migrate.mjs before the load, in the same
-- build, so the migration lands before the INSERT that the old index refused.
-- A preview or local database needs `npm run db:migrate` by hand.
--
-- REVERSIBLE, but do not: reinstating the unique index re-breaks the build the
-- moment one posting is killed under two rules.
--
--   DROP INDEX IF EXISTS board_kills_job_slug_idx;
--   CREATE UNIQUE INDEX board_kills_job_slug_idx
--     ON board_kills (job_slug) WHERE job_slug IS NOT NULL;

DROP INDEX IF EXISTS board_kills_job_slug_idx;

CREATE INDEX IF NOT EXISTS board_kills_job_slug_idx
  ON board_kills (job_slug)
  WHERE job_slug IS NOT NULL;

-- The live schema says so itself, the same way db/208 rewrote the PRF ledger's
-- COMMENT rather than leaving it claiming something no longer true. db/130's
-- own text still describes this index as unique; it is history and stays as
-- written, so this is where a reader of the running database is told.
COMMENT ON INDEX board_kills_job_slug_idx IS
  'Not unique, deliberately (db/210): one board row can be killed under more than one rule, and the ingest picks the kill of record with DISTINCT ON (url). getBoardJobBySlug() orders by first_killed_at_utc and takes one.';
