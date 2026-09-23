-- 207_jobs_derived.sql: the Jobs Data page's derived dimensions, as columns.
--
-- WHY. Seniority, region, family, apply friction and the posted pay midpoint
-- were computed in the browser, per row, on every render. That is why the page
-- had to carry the whole board as JSON: a filter cannot be a WHERE clause
-- against a field that only exists in JavaScript. At 31,310 live rows the
-- embedded payload reached 12.0 MB and the page stopped rendering.
--
-- These columns are written by ONE definition, src/lib/jobs-derived.mjs, called
-- from scripts/ingest-jobs.mjs on every row of every crawl and from
-- scripts/backfill-derived.mjs for rows written before this migration. Nothing
-- re-derives them at read time.
--
-- NULLABLE WHERE THE POSTING IS SILENT. derived_tier is NULL when the title
-- prints no seniority word and derived_fam is NULL when the applicant system
-- published no department. Those are gaps in what employers printed, and the
-- page shows them as gaps. derived_region and derived_friction always have an
-- answer ('Unknown' and 'easy' respectively are answers, not defaults for
-- missing data), so they are NOT NULL.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS derived_tier     TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS derived_fam      TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS derived_region   TEXT NOT NULL DEFAULT 'Unknown';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS derived_friction TEXT NOT NULL DEFAULT 'easy';

-- Posted pay, in thousands, from the structured comp_range only. priced is
-- false when no structured minimum above zero was published; the three k
-- columns are then NULL. An absent range is a gap, never a zero.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priced     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS comp_min_k INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS comp_max_k INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS comp_mid_k INTEGER;

-- PARTIAL ON THE LIVE ROWS. Every query this page makes carries
-- "status <> 'killed'" literally, because the page is about the live board, so
-- Postgres can match these predicates. Killed rows are a minority but they are
-- never in a filtered cut, and keeping them out keeps each index to the set
-- that is actually scanned.
--
-- Measured before any of these existed (2026-09-23, production, 31,310 live
-- rows): the slowest aggregate was 373 ms and most were under 70 ms, so these
-- are headroom for the crawl continuing to grow, not a rescue.
CREATE INDEX IF NOT EXISTS jobs_live_tier_idx     ON jobs (derived_tier)     WHERE status <> 'killed';
CREATE INDEX IF NOT EXISTS jobs_live_region_idx   ON jobs (derived_region)   WHERE status <> 'killed';
CREATE INDEX IF NOT EXISTS jobs_live_friction_idx ON jobs (derived_friction) WHERE status <> 'killed';
CREATE INDEX IF NOT EXISTS jobs_live_ats_idx      ON jobs (ats)              WHERE status <> 'killed';
CREATE INDEX IF NOT EXISTS jobs_live_age_idx      ON jobs (days_up)          WHERE status <> 'killed';
CREATE INDEX IF NOT EXISTS jobs_live_company_idx  ON jobs (company)          WHERE status <> 'killed';
-- Pay reads always test priced before touching a midpoint, so the two belong
-- in one index in that order.
CREATE INDEX IF NOT EXISTS jobs_live_pay_idx      ON jobs (priced, comp_mid_k) WHERE status <> 'killed';

-- THE ARCHIVE NEEDS THE SAME COLUMN. The kill views cut by seniority too, and
-- the page derived a kill's seniority from its title in the browser with the
-- same regex it used on live rows. One definition means one column, on both
-- tables, written by the same function.
ALTER TABLE board_kills ADD COLUMN IF NOT EXISTS derived_tier TEXT;
CREATE INDEX IF NOT EXISTS board_kills_standing_idx ON board_kills (kill_rule, ats) WHERE vacated_at IS NULL;
