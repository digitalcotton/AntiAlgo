-- 202_draft_versions.sql
--
-- Draft versioning and restore for job drafts. Until now generated_render kept
-- exactly one row per (user, job, kind): a re-draft DELETED the old row and
-- inserted a fresh one, the "no history to pick from" shape. The draft room now
-- keeps every draft as a version the person can read and restore, so re-drafting
-- (and steered regeneration) appends a new version rather than replacing the last.
--
-- TWO COLUMNS AND A SWAPPED INDEX.
--   (1) version: a per-(user, job, kind) counter, 1 for the first draft and +1 on
--       each re-draft. Every existing row is the first of its line, so DEFAULT 1
--       validates against live data with no backfill.
--   (2) is_current: exactly one row per (user, job, kind) is the current draft,
--       the one getJobRenders and the PDF/DOCX download path read. Restore flips
--       it. DEFAULT true keeps every existing single row current.
--   (3) The old partial unique (user, job, kind) forbade a second row per kind,
--       which is the one thing versioning must allow. It is replaced by a
--       CURRENT-only partial unique, so many versions may exist while only one is
--       current, and getJobRenders' one-row-per-kind contract still holds exactly.
--
-- Apply drafts (application_id set, job_id null) are untouched: they keep their
-- own UNIQUE (application_id, kind) from db/112, default to version 1 / current,
-- and never grow a version line, since only the job-draft path re-drafts.

ALTER TABLE generated_render ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE generated_render ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

-- Swap the job partial unique for a current-only one, idempotently (the same
-- DROP-then-CREATE posture db/122 and db/112 take so a re-run is safe).
DROP INDEX IF EXISTS generated_render_job_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS generated_render_job_current_uidx
  ON generated_render (user_id, job_id, kind)
  WHERE job_id IS NOT NULL AND is_current;

-- Listing a posting's versions for one kind, newest first.
CREATE INDEX IF NOT EXISTS generated_render_job_versions_idx
  ON generated_render (user_id, job_id, kind, version DESC)
  WHERE job_id IS NOT NULL;
