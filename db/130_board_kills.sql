-- board_kills: every published kill from src/data/kills-archive.json, both
-- pipelines, keyed by the archive's own id (sha1(url|rule)[:12]).
--
-- NEVER TRUNCATED. The jobs table is replaced whole every deploy because it is
-- a snapshot of a feed; this table is a record, and a record that could be
-- emptied by a bad load is not one. Rows are upserted from the archive file on
-- every production build; a row the archive no longer carries (withdrawn with
-- vacate_kill.py) gets vacated_at set and is never deleted.
--
-- on_board / job_id / job_slug tie a kill to the board row it is about, set by
-- the ingest from a URL join after the jobs upsert. job_slug is kept after the
-- posting leaves the feed so /board/<slug> keeps resolving to the closed page.
CREATE TABLE IF NOT EXISTS board_kills (
  id                  TEXT PRIMARY KEY,
  slug                TEXT,
  url                 TEXT NOT NULL,
  company             TEXT NOT NULL,
  title               TEXT NOT NULL,
  ats                 TEXT,
  kill_rule           TEXT NOT NULL,
  reason              TEXT NOT NULL,
  evidence            JSONB,
  killed_on           DATE,
  first_killed_at_utc TIMESTAMPTZ,
  last_fired_on       DATE,
  times_fired         INTEGER NOT NULL DEFAULT 1,
  first_published     DATE,
  pipeline            TEXT NOT NULL DEFAULT 'sweep',
  on_board            BOOLEAN NOT NULL DEFAULT false,
  job_id              TEXT,
  job_slug            TEXT,
  vacated_at          TIMESTAMPTZ,
  first_ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS board_kills_url_idx ON board_kills (url);
CREATE UNIQUE INDEX IF NOT EXISTS board_kills_job_slug_idx ON board_kills (job_slug) WHERE job_slug IS NOT NULL;
