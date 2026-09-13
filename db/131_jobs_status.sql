-- A board row is live unless a published kill names its URL. status is written
-- by the ingest from the board_kills join inside the same transaction as the
-- rows, so the two can never disagree; kill_id points at the kill of record
-- (earliest first_killed_at_utc, tie broken by rule precedence).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'live';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kill_id TEXT;
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
