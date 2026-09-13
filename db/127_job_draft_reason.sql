-- 027_job_draft_reason.sql
--
-- The person's "why this company" note, kept on the cover row.
--
-- The note is the letter's opening anchor. Until now it lived only in memory:
-- it rode the signed run token to the render and landed inside a READY cover
-- payload (tailor.ts, letterInputs.reason). A FAILED cover has payload NULL,
-- which is exactly the state a per-document retry starts from, so a retry had
-- nowhere to read the note back and would silently drop the person's own words.
--
-- This column keeps it. beginJobDraft() writes it on the cover row (the resume
-- has no channel for it, so its row stays NULL); beginJobDraftDocument() carries
-- the deleted row's value forward when a cover-only retry sends none. Additive:
-- every existing row reads NULL and old code is untouched.
--
-- 600 characters matches REASON_MAX_CHARS in src/pages/desk/job-draft.ts, the
-- textarea's own server-side backstop, so the column can never hold more than
-- the endpoint would ever store.

ALTER TABLE generated_render
  ADD COLUMN IF NOT EXISTS reason text
  CHECK (reason IS NULL OR char_length(reason) <= 600);
