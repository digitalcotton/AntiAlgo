-- 211_job_slug_ledger.sql
--
-- A posting's address, assigned once and kept. /board/<slug> stops being a
-- thing the ingest recomputes every night and becomes a thing the database
-- remembers.
--
-- WHY. Two faults, one cause, and the cause is that the slug was a pure
-- function of tonight's row rather than a fact about the posting:
--
--   1. IT COLLIDED. slugFor() in scripts/ingest-jobs.mjs builds its tail with
--      `h.toString(36).slice(0, 6)`, and a 32-bit djb2 value is up to SEVEN
--      base-36 characters, so the slice drops the last digit and collapses
--      every block of 36 neighbouring hashes onto one tail. On the crawl of
--      2026-09-26 that put 117 slugs on two postings each. Two of those were
--      also killed, which is what met db/210's unique index and failed the
--      build.
--
--   2. IT MOVED. The slug is derived from company and title. An employer who
--      edits their own job title changes the address of a page that was
--      already linked to, and nothing anywhere notices.
--
-- Recomputing cannot fix either one: the tail has to come from something, and
-- anything wide enough to stop colliding is a different string from the one
-- that is live today, so every address on the board changes. Owner's question,
-- 2026-09-26: can we fix it without changing every job URL. This is how.
--
-- THE LEDGER. One row per posting id, holding the address that posting was
-- given the first time it was seen. The ingest reads this before it writes the
-- board: a posting already in here keeps its address whatever tonight's row
-- says, and a posting not in here is assigned one and written down.
--
-- WHAT THIS DOES TO THE ADDRESSES THAT EXIST TODAY. Nothing, for all but the
-- broken ones. The first run assigns exactly what slugFor() computes now, so
-- every posting whose address is already unique keeps the address it has. Only
-- where two postings genuinely want the same address does the second one get a
-- longer tail, and those are addresses that do not resolve to a stable page
-- today anyway -- the board picks one of the two arbitrarily.
--
-- NEVER DELETED HERE, the same posture db/130 takes for board_kills: an
-- address that has been published is a promise, and a ledger that can be
-- emptied by a bad run is not a ledger. A posting that leaves the feed and
-- comes back gets the address it had.
--
-- IT WILL GROW, and that is understood rather than overlooked: one row per
-- posting id ever seen, at roughly 37k live postings a night with real
-- turnover. A row here is an id and a short string, so a year of it is tens of
-- megabytes, not gigabytes. If it ever needs a bound, the honest one is by
-- last_seen_at -- and dropping a row means the address may be reassigned, so
-- it is a decision about how long a dead posting's URL should keep resolving,
-- not a cleanup. Nothing prunes it today.
--
-- HOW THIS REACHES EACH DATABASE. Production applies it on its own:
-- scripts/ingest-on-build.mjs runs db/migrate.mjs before the load, in the same
-- build. A preview or local database needs `npm run db:migrate` by hand. Until
-- it is applied, the ingest cannot read the ledger and fails closed rather
-- than publishing a board with recomputed addresses.
--
-- REVERSIBLE: DROP TABLE job_slug_ledger, and the ingest goes back to
-- recomputing. The addresses assigned while it was on are then lost, so the
-- 117 that were given longer tails would revert to colliding.

CREATE TABLE IF NOT EXISTS job_slug_ledger (
  -- The posting's own id, as the crawl names it ("teamtailor|8443557"). Not a
  -- foreign key to jobs(id): jobs is TRUNCATEd and replaced whole every night
  -- (scripts/ingest-jobs.mjs --replace), and the whole point of this table is
  -- to outlive that.
  job_id     text PRIMARY KEY,

  -- The address, and the reason this table exists. UNIQUE is the constraint
  -- that actually enforces what slugFor() only ever intended: two postings
  -- cannot hold one address. Unlike db/210's index on board_kills, this one is
  -- correct to be unique -- that column is a POINTER to a board row and many
  -- kills may point at one; this column IS the address and one posting owns it.
  slug       text NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 200),

  first_assigned_at timestamptz NOT NULL DEFAULT now(),

  -- Touched on every run that still sees the posting. Nothing reads it yet; it
  -- is what a future bound would be drawn on, and writing it now costs one
  -- column rather than a backfill later.
  last_seen_at      timestamptz NOT NULL DEFAULT now()
);

-- The ingest's own lookup is by job_id (the primary key) and by slug when it
-- checks whether a candidate is free; both are already indexed by the
-- constraints above. This one is for the bound that does not exist yet.
CREATE INDEX IF NOT EXISTS job_slug_ledger_last_seen_idx
  ON job_slug_ledger (last_seen_at);

COMMENT ON TABLE job_slug_ledger IS
  'One row per posting id: the /board/<slug> address it was given the first time it was seen, kept so the address never moves. Written by scripts/ingest-jobs.mjs inside the same transaction as the board replace (db/211).';
