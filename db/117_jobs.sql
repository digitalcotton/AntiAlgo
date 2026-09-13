-- 017_jobs.sql: the general-tracker job store.
--
-- The design product ships its ~70 verified roles as a static jobs.json bundled
-- at build time. The broader release tracks thousands of postings across every
-- board, far too many to bundle or to prerender one page each, so those live in
-- this table and are read at request time by src/pages/board.astro through
-- src/lib/job-store.ts. The mini's nightly tracker (track_all.py) is the writer;
-- the site is a reader only.
--
-- id is the tracker's own stable key (ats|posting_id, or a url/name fallback),
-- so re-ingesting the same posting is an upsert, not a duplicate. ghost, days_up,
-- first_seen and last_seen carry the ghost-watch the tracker computes, so the
-- site can show how long a role has been up and flag a zombie without recomputing.
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  company      TEXT NOT NULL,
  title        TEXT NOT NULL,
  url          TEXT,
  location     TEXT,
  country      TEXT,
  remote       BOOLEAN NOT NULL DEFAULT false,
  published    TIMESTAMPTZ,
  ats          TEXT NOT NULL,
  posting_id   TEXT,
  department   TEXT,
  comp_posted  TEXT,
  days_up      INTEGER,
  ghost        BOOLEAN NOT NULL DEFAULT false,
  first_seen   DATE,
  last_seen    DATE,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ordering key for the default listing (freshest first). ILIKE search is a
-- sequential scan, which is fine at the thousands-of-rows scale this holds; a
-- pg_trgm index is the optimisation to reach for only if the row count grows
-- into the hundreds of thousands.
CREATE INDEX IF NOT EXISTS jobs_last_seen_idx ON jobs (last_seen DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS jobs_company_idx ON jobs (company);
