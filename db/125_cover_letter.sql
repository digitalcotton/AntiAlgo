-- 025_cover_letter.sql
--
-- A cover letter the person keeps on file, so a drafted letter can be an
-- ADAPTATION of their own writing rather than one written from scratch. Three
-- columns on app_user_profile, the same one-row-per-person table db/010, db/011
-- and db/016 chose to extend rather than add a table beside: the row already
-- exists for every account, already cascades on delete, already touch-stamps,
-- and account.ts's PERSON_TABLES already inventories it as exported and
-- cascade-deleted, so a new column needs no new entry there (the same reasoning
-- db/016_resume_email.sql spells out).
--
-- WHAT IS STORED, AND WHAT IS NOT. cover_letter_text is the person's own letter
-- as plain text, capped at 20000 characters to match VOICE_SAMPLE_MAX_BYTES
-- (src/lib/voice.ts): the letter is fed to the cover render ONLY as a writing-
-- voice sample, never as a source of facts, so its cap is the voice cap. A PDF
-- or DOCX upload is text-extracted before it is stored (src/pages/profile/
-- import/cover.ts), because voice.ts refuses those formats by design; only the
-- extracted text lands here. cover_letter_source_name is the file's own name
-- (or null for a paste), shown on the "on file" line. cover_letter_added_at
-- stamps when it was stored.
--
-- FACTS IN THE LETTER GO THROUGH THE RECORD, NOT AROUND IT. A dated employer or
-- role the letter names is proposed into the Profile Record through the same
-- import-propose-confirm flow a resume upload uses; only once it is a record
-- entry can a rendered letter assert it. This column is the voice, never a
-- second, unreviewed store of facts.
ALTER TABLE app_user_profile
  ADD COLUMN IF NOT EXISTS cover_letter_text text
    CHECK (cover_letter_text IS NULL OR char_length(cover_letter_text) <= 20000),
  ADD COLUMN IF NOT EXISTS cover_letter_source_name text
    CHECK (cover_letter_source_name IS NULL OR char_length(cover_letter_source_name) <= 200),
  ADD COLUMN IF NOT EXISTS cover_letter_added_at timestamptz;
