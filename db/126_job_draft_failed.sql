-- 026_job_draft_failed.sql
--
-- A fourth render status, and the two columns that make it honest.
--
-- db/012 argued that no 'failed' state was needed: a render that could not
-- reach a provider fell back to the built-in writer, and a render that threw
-- twice left its rows 'pending' for the result page to offer a retry against.
-- Both halves of that argument are now retired. The owner's ruling is that a
-- person whose own key was tried must never be handed the built-in template
-- as if it were the draft (it drops their note and reads like a resume), so a
-- tried-and-failed provider now lands the row here, 'failed', with the reason.
-- And a row left 'pending' forever is a wait state that never ends, which is
-- the exact symptom this migration's siblings in src/lib/defer-work.ts and
-- src/lib/draft-run-dispatch.ts exist to remove.
--
--   (1) status gains 'failed'. The inline CHECK db/012 declared on the column
--       was unnamed, so Postgres named it generated_render_status_check; it is
--       dropped and re-added under that same name, the drop-then-add posture
--       db/022 takes with generated_render_one_owner so re-running is idempotent.
--   (2) failure_reason: a plain sentence our own code minted (never a provider
--       body, so it can never carry a key), read by the status endpoint and the
--       draft room. NULL for every status but 'failed'.
--   (3) started_at: stamped once, by the invocation that claims the row to
--       render it (src/pages/desk/job-draft/[slug]/run.ts), never cleared: a
--       retry deletes the rows and begins fresh. Two jobs. It makes a replayed
--       run request a no-op (a claimed row is not claimed twice), and it lets
--       the state math tell "claimed and still working" from "claimed and
--       abandoned" by the platform's own ceiling (site.config.mjs).
--
-- Additive. Every existing row satisfies the new CHECK and reads NULL in both
-- new columns; old code deployed against the migrated table keeps working.

ALTER TABLE generated_render DROP CONSTRAINT IF EXISTS generated_render_status_check;
ALTER TABLE generated_render
  ADD CONSTRAINT generated_render_status_check
  CHECK (status IN ('pending', 'ready', 'fallback', 'failed'));

ALTER TABLE generated_render
  ADD COLUMN IF NOT EXISTS failure_reason text
  CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 1000);

ALTER TABLE generated_render ADD COLUMN IF NOT EXISTS started_at timestamptz;
