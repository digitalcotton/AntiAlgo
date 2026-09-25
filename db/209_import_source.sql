-- 209_import_source.sql
--
-- Where a record entry came from, so removing a document can take back what
-- that document put in.
--
-- WHY. A resume upload and a cover letter both land entries in the Profile
-- Record through the same reader (src/lib/resume-parse-runner.ts, which
-- src/pages/profile/import/cover.ts calls too). Removing the cover letter
-- nulled three columns on app_user_profile and stopped: every entry the letter
-- had proposed stayed in the record, and nothing anywhere could say which rows
-- those were. A resume had no remove at all, so a second upload stacked a
-- second copy of every role on top of the first. Owner ruling 2026-09-25:
-- whatever records we took in, delete them.
--
-- NULL MEANS TYPED BY HAND, and that is what makes this migration safe to
-- apply to a record that already has rows in it. Every existing entry gets
-- NULL, so no historical row becomes deletable by a remove it was never part
-- of. Only rows written from this point on, by an import that names its
-- source, can be taken back by that source's remove.
--
-- CHECK rather than an enum, for the reason db/104 gives for `kind` and
-- `classification`: the next source (an offer letter, a LinkedIn export) is an
-- ALTER of this constraint, not a heavier enum-type change.
--
-- THE COVENANT IS NOT TOUCHED. The import band's third promise reads "Read
-- once, in memory, then gone. Nothing stored, nothing sent to us." The two
-- app_user_profile columns below store the uploaded file's NAME and the moment
-- it was read, never the file and never its text -- the same line db/115's own
-- header already draws for resume_parse.source_name, held past the buffer so
-- there is something for a remove to point at.
--
-- HOW THIS REACHES EACH DATABASE. Production applies it on its own:
-- scripts/ingest-on-build.mjs runs db/migrate.mjs on every production build,
-- before the deploy is live. A preview or local database applies nothing, so
-- it needs
--
--   npm run db:migrate
--
-- by hand. Until it is applied there, every insert into record_entry fails on
-- the unknown column and the apply step counts each proposal as failed.
--
-- ADDITIVE, AND RE-RUNNABLE. Three ADD COLUMN IF NOT EXISTS, one index, and a
-- DROP CONSTRAINT IF EXISTS before each ADD CONSTRAINT, the same posture every
-- migration before this takes. Touches no existing data.
--
-- REVERSIBLE.
--
--   DROP INDEX IF EXISTS record_entry_import_source_idx;
--   ALTER TABLE record_entry DROP COLUMN IF EXISTS import_source;
--   ALTER TABLE resume_parse DROP COLUMN IF EXISTS import_source;
--   ALTER TABLE app_user_profile
--     DROP COLUMN IF EXISTS resume_source_name,
--     DROP COLUMN IF EXISTS resume_added_at;

-- ---------------------------------------------------------------------------
-- record_entry.import_source: the document that brought this entry in.
-- ---------------------------------------------------------------------------

ALTER TABLE record_entry
  ADD COLUMN IF NOT EXISTS import_source text;

ALTER TABLE record_entry DROP CONSTRAINT IF EXISTS record_entry_import_source;
ALTER TABLE record_entry ADD CONSTRAINT record_entry_import_source
  CHECK (import_source IS NULL OR import_source IN ('resume', 'cover_letter'));

-- The only shape a remove or a count ever filters on: this person's rows from
-- one source. Partial, because the rows that matter here are the imported
-- ones; a record of hand-typed entries carries no weight in this index.
CREATE INDEX IF NOT EXISTS record_entry_import_source_idx
  ON record_entry (user_id, import_source)
  WHERE import_source IS NOT NULL;

-- ---------------------------------------------------------------------------
-- resume_parse.import_source: which document the in-flight read belongs to.
-- ---------------------------------------------------------------------------
--
-- The parse row is the only thing that survives between the upload request and
-- the background apply, so it is where the answer has to live. A cover letter
-- goes through the same reader as a resume; without this column the apply
-- cannot tell the two apart and neither remove could be trusted.
--
-- NOT NULL DEFAULT 'resume': every row this buffer holds today came from the
-- resume path, and the buffer is transient anyway (one row per person,
-- replaced on each upload), so the default is right for the rows in flight
-- while this deploys.
ALTER TABLE resume_parse
  ADD COLUMN IF NOT EXISTS import_source text NOT NULL DEFAULT 'resume';

ALTER TABLE resume_parse DROP CONSTRAINT IF EXISTS resume_parse_import_source;
ALTER TABLE resume_parse ADD CONSTRAINT resume_parse_import_source
  CHECK (import_source IN ('resume', 'cover_letter'));

-- ---------------------------------------------------------------------------
-- The resume's receipt, so there is something to remove.
-- ---------------------------------------------------------------------------
--
-- Two columns on app_user_profile, the one-row-per-person table db/010,
-- db/016 and db/125 all chose to extend rather than sit a table beside: the
-- row already exists for every account, already cascades on delete, already
-- touch-stamps, and account.ts's PERSON_TABLES already inventories it as
-- exported and cascade-deleted, so new columns need no entry there.
--
-- The name is capped at 200 to match cover_letter_source_name. There is no
-- resume_text column and there is not going to be one.
ALTER TABLE app_user_profile
  ADD COLUMN IF NOT EXISTS resume_source_name text
    CHECK (resume_source_name IS NULL OR char_length(resume_source_name) <= 200),
  ADD COLUMN IF NOT EXISTS resume_added_at timestamptz;
