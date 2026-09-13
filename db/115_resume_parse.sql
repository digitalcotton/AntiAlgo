-- 015_resume_parse.sql
--
-- One in-flight resume parse per person: the working buffer between "I
-- uploaded a file" and "I confirmed what to keep". Reading a resume with the
-- person's own provider key can take many seconds, longer than a page POST
-- should hold a tab open, so the parse runs in the background the same way a
-- drafted resume does (src/lib/generation-preference-store.ts, db/012): the
-- upload endpoint writes a pending row, fires the parse, and redirects to a
-- review page that refreshes until the row turns ready.
--
-- ONE ROW PER PERSON, REPLACED EACH UPLOAD. The primary key is user_id, so a
-- second upload overwrites the first: there is only ever one parse to review,
-- never a history to pick through. That is the deliberate amendment to
-- src/pages/profile/import.ts's older "proposals are not persisted between the
-- two steps" promise, and it is written here so the change is visible where
-- the data lives: a parse IS persisted now, as a single transient buffer, so
-- the slow read can finish after the response. It is not a record of anything
-- the person did; the entries they actually confirm land in record_entry, and
-- THOSE are what an export holds.
--
-- THE RAW RESUME TEXT IS NOT STORED HERE. Only source_name (the filename, for
-- the review page to say which file this was) and the finished proposals. The
-- resume text itself lives in memory for the one parse call and is gone after,
-- the same discipline src/lib/resume-extract.ts already holds: this database
-- never keeps the uploaded document or its full text.
CREATE TABLE IF NOT EXISTS resume_parse (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,

  -- 'pending' the moment beginParse() writes the row; 'ready' once
  -- completeParse() lands an outcome. There is no 'failed' status: a parse
  -- that cannot use the provider key still completes 'ready' with a
  -- deterministic outcome and a fallback note (src/lib/resume-parse.ts's own
  -- fail-closed design), so a reader never watches a row that can only end in
  -- an error. The one honest dead end, both the provider parse and the
  -- deterministic parse throwing, leaves the row 'pending', which the review
  -- page's own polling state describes plainly.
  status text NOT NULL CHECK (status IN ('pending', 'ready')),

  -- The uploaded file's name, for the review page to name what it read. Not
  -- the file, not its text: see this file's own header.
  source_name text,

  -- The finished parse (src/lib/resume-parse-store.ts's StoredParseOutcome):
  -- method (llm or deterministic), the provider label when a key was used, a
  -- fallback reason when a key was tried and could not be used, the verified
  -- proposals, and the notes. NULL while status = 'pending'. No CHECK ties
  -- outcome's presence to status: the two writes that touch this column
  -- (beginParse setting it NULL, completeParse setting it once) are both in
  -- this codebase's own store, not an open write surface a constraint defends.
  outcome jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- updated_at maintained by the database, the same trigger pattern db/001,
-- db/006, db/007, db/009 and db/012 all use, for the reason each gives: a
-- timestamp only some code paths update is worse than none.
CREATE OR REPLACE FUNCTION resume_parse_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS resume_parse_touch_trigger ON resume_parse;
CREATE TRIGGER resume_parse_touch_trigger
  BEFORE UPDATE ON resume_parse
  FOR EACH ROW EXECUTE FUNCTION resume_parse_touch();
