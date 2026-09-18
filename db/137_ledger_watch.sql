-- 137_ledger_watch.sql
--
-- The Ledger's watch list: the job titles a signed-in reader is watching, each
-- shelved 'core' (leads the report) or 'stretch' (secondary). One row per
-- person per title. This is the personal half of the Ledger (src/pages/
-- ledger.astro): the page re-cuts the board to these titles, so what a reader
-- sees is decided by the rows here, not by anything preset per field.
--
-- The same shape db/108_watchlist.sql already uses for Pre-List follows: a
-- title is NOT a foreign key, deliberately, for the same reason prospect_id is
-- not. The board's titles live in a nightly-regenerated set (the jobs table and
-- src/data/jobs.json), with no stable row for Postgres to reference; a watch is
-- resolved against the live board at read time by src/lib/ledger-titles.ts's
-- matcher, the same way a follow is resolved against prospectRows().
--
-- Run with:  npm run db:migrate
-- Safe to run repeatedly. Every statement is guarded.

CREATE TABLE IF NOT EXISTS ledger_watch (
  -- Cascade for the same reason db/001, db/008 and db/009 give for their own
  -- person-owned tables: a watch outliving its person is a fact attached to
  -- nobody, and the next account to reuse this id would inherit it.
  user_id     text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- The watched title, as the reader typed or picked it. Bounded like
  -- prospect_id; matched case-insensitively against board titles at read time,
  -- never used to build SQL.
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),

  -- Which shelf the reader put this title on. 'core' leads the report; 'stretch'
  -- is the wider net shown after it. A CHECK, not a lookup table: two values
  -- that change only when the product does.
  shelf       text NOT NULL DEFAULT 'core' CHECK (shelf IN ('core', 'stretch')),

  -- One watch per person per title: adding the same title again moves its shelf
  -- (the store's upsert), it is never a second row.
  PRIMARY KEY (user_id, title),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every read this feature makes is a person's own watch list, filtered by
-- user_id first; nothing here queries across people.
CREATE INDEX IF NOT EXISTS ledger_watch_user_idx
  ON ledger_watch (user_id);

-- updated_at maintained by the database, the same trigger pattern db/001,
-- db/008 and db/009 all use, for the reason each gives: a timestamp only some
-- code paths update is worse than none, because it looks authoritative.
CREATE OR REPLACE FUNCTION ledger_watch_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_watch_touch_trigger ON ledger_watch;
CREATE TRIGGER ledger_watch_touch_trigger
  BEFORE UPDATE ON ledger_watch
  FOR EACH ROW EXECUTE FUNCTION ledger_watch_touch();
