-- 008_watchlist.sql
--
-- The Watchlist: Pre-List follows (MASTER-SPEC 3.6). "Person follows a
-- Company or a Prospect (pre-posting company)... This is the dormant-mode
-- heartbeat." This table holds the Prospect half of that sentence: a
-- follow against one row of src/data/prospects.json, before any posting
-- exists for it to attach to.
--
-- Run with:  npm run db:migrate
-- Safe to run repeatedly. Every statement is guarded.

CREATE TABLE IF NOT EXISTS watchlist (
  -- Cascade for the same reason db/001 gives for app_user_profile and
  -- db/006 restates for desk_saved_job: a follow outliving its person is a
  -- fact attached to nobody, and the next account to reuse this id would
  -- inherit somebody else's watchlist.
  user_id      text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- The prospect's own id, read straight from src/data/prospects.json's
  -- "id" field: confirmed by reading one row of that file, for example
  -- "yc-30943:Iw9ggf8-mts-founding-designer" (a source key and a role slug
  -- joined by a colon, per that file's own _meta block on how it is
  -- generated). NOT A FOREIGN KEY, AND THAT IS DELIBERATE, THE SAME WAY
  -- desk_saved_job.job_id and desk_application.job_id are not foreign keys
  -- into any jobs table (db/006_desk.sql, both columns' own comments).
  -- prospects.json is machine-owned data: export-prospects.py on the mini
  -- (see that file's own _meta.purpose) regenerates and replaces it every
  -- night, wholesale, with no notion of a stable row it is updating in
  -- place versus a row it is retiring. A foreign key needs a table on this
  -- side of the boundary to reference, and there is no prospects table in
  -- Postgres: the file is the only copy of that data this system has, and
  -- a database constraint cannot be written against a file. The
  -- application layer resolves prospect_id against the published file at
  -- read time, the same way desk_saved_job/desk_application already
  -- resolve job_id against src/data/jobs.json.
  prospect_id  text NOT NULL CHECK (length(prospect_id) <= 200),

  -- One follow per person per prospect: following again is a no-op, not a
  -- second row, the same shape desk_saved_job's primary key already gives
  -- a bookmark.
  PRIMARY KEY (user_id, prospect_id),

  followed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Every watchlist view this feature needs (a person's own followed
-- prospects) filters by user_id first; nothing here queries across people.
CREATE INDEX IF NOT EXISTS watchlist_user_idx
  ON watchlist (user_id);

-- updated_at maintained by the database, the same trigger pattern db/001
-- uses, for the reason it gives: a timestamp only some code paths update is
-- worse than none, because it looks authoritative.
CREATE OR REPLACE FUNCTION watchlist_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS watchlist_touch_trigger ON watchlist;
CREATE TRIGGER watchlist_touch_trigger
  BEFORE UPDATE ON watchlist
  FOR EACH ROW EXECUTE FUNCTION watchlist_touch();
