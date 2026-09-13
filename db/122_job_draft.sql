-- 022_job_draft.sql
--
-- The one-click draft button (RUN-DRAFT.md phase 3): on a verified job detail
-- page, a signed-in person presses one button and gets a resume and cover
-- letter drafted for that posting, WITHOUT applying and without a desk card.
-- The apply flow already drafts on apply into generated_render, keyed to the
-- application it just created; this button drafts against the posting itself,
-- with no application in the picture at all.
--
-- REUSE THE SAME TABLE, KEYED BY JOB INSTEAD OF APPLICATION. RUN-DRAFT names the
-- existing pipeline (beginDraft, renderInBackground, generated_render) as the
-- one to reuse, so rather than a second table with the same columns, this
-- migration teaches generated_render to also hold a draft keyed to a job. The
-- change is additive: every existing row has application_id set and job_id null
-- and is untouched, and the apply flow's own reads and writes still filter by
-- application_id exactly as before.
--
--   (1) job_id: the verified posting's slug (the /role/<slug> the button sits
--       on). text, to match how the site names a job everywhere a URL does.
--   (2) application_id becomes nullable: a job draft has no application. The
--       foreign key still cascades when the column is set, so an apply draft
--       still dies with its application; a job draft cascades on the user alone.
--   (3) EXACTLY ONE OF THE TWO IS SET, never both, never neither. A row is
--       either an apply draft (application_id) or a job draft (job_id). The
--       CHECK is a boolean XOR, satisfied by every existing row (application_id
--       set, job_id null) so it validates against live data without a rewrite.
--   (4) One job draft per (user, job, kind): a second press replaces the row in
--       place, the same "one resume and one cover, never a history" shape the
--       apply path's own UNIQUE (application_id, kind) already gives. A partial
--       unique index, because it applies only to job drafts (job_id NOT NULL);
--       apply drafts keep their own UNIQUE from db/012 untouched.

ALTER TABLE generated_render ADD COLUMN IF NOT EXISTS job_id text;

ALTER TABLE generated_render ALTER COLUMN application_id DROP NOT NULL;

-- Drop then add so re-running the migration is idempotent (the same posture the
-- triggers in db/012 take with DROP TRIGGER IF EXISTS).
ALTER TABLE generated_render DROP CONSTRAINT IF EXISTS generated_render_one_owner;
ALTER TABLE generated_render
  ADD CONSTRAINT generated_render_one_owner
  CHECK ((application_id IS NULL) <> (job_id IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS generated_render_job_uidx
  ON generated_render (user_id, job_id, kind)
  WHERE job_id IS NOT NULL;
