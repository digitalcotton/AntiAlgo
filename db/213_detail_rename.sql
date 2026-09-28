-- 213: fit_total is not a fit score. It is how much the posting tells you.
--
-- WHAT IT ACTUALLY MEASURES, from scoreJob() in scripts/ingest-jobs.mjs:
--
--   title_scope     30   the title is longer than two characters
--   remote_geo      25   a location string exists (12 for country only)
--   comp            20   the posted pay contains a digit (12 for prose)
--   freshness       15   banded by days_up
--   apply_friction  10   an apply URL exists
--
-- Every component is a property of the POSTING. Not one reads the person, and
-- no userId reaches that function, so the number is identical for every member.
-- It is a good measure of how complete and how recent a crawled listing is, and
-- it was only ever wrong as a claim about fit. Owner, 2026-09-27: rename it to
-- what it measures and change nothing else, so every number stays identical and
-- nothing shifts under anyone.
--
-- 'Detail' is posting completeness said simply, and it fits a column header
-- where the longer phrase does not.
--
-- WHY ADDITIVE RATHER THAN `ALTER TABLE RENAME COLUMN`. A rename is atomic in
-- the database and would be the smaller diff, but migrations run during the
-- BUILD (scripts/ingest-on-build.mjs) and the previous deployment keeps serving
-- until the new one is aliased. A straight rename would leave the old code
-- selecting a column that no longer exists, for the length of that window, on
-- every page that reads the board. So: add, backfill, dual-write, move readers,
-- and drop the old pair in a later migration once nothing selects it.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS detail_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS detail_components JSONB;

-- Carry every existing row across. This is a copy, not a recomputation: the
-- rename must not change a single number, and recomputing here would quietly
-- re-score the board against whatever scoreJob() looks like today.
UPDATE jobs
   SET detail_total = fit_total,
       detail_components = fit_components
 WHERE detail_total = 0 AND fit_total IS DISTINCT FROM 0;

-- board_kills is deliberately untouched: it carries no fit_total of its own. A
-- killed row's card reads the pair from `jobs` through KILL_COLUMNS, so there is
-- nothing here to carry across. Checked rather than assumed — the first draft of
-- this file tried to backfill a column that does not exist.
