-- 214: the kill archive gets a family, so watching a title stops emptying it.
--
-- WHAT WAS BROKEN. /jobs-data narrows the kill archive to "the kinds of role
-- the reader watches", and the predicate it used was
--
--     derived_fam_placeholder = ANY($watchedFams)
--
-- with the placeholder replaced by NULL::text before the query ran, because
-- board_kills had no family column. `NULL = ANY(...)` is never true, so the
-- archive emptied the moment any title was watched. jobs-data-agg.ts documented
-- it honestly ("a kill carries no measured department under crawl coverage...
-- the fix is a department on the archive, not a looser test here") and the
-- browser went on labelling the panel "archive cut to your families" over a
-- section that could only ever be empty.
--
-- This is that fix. db/207 made exactly the same argument for seniority — "the
-- kill views cut by seniority too... one definition means one column, on both
-- tables, written by the same function" — and added derived_tier here. The
-- family is the other half of that sentence and is four migrations late.
--
-- WHY IT IS ONE COLUMN AND NOT TWO. jobs carries derived_fam AND
-- derived_fam_source, because a live row has a crawled department to prefer
-- over its title. A kill has no department: board_kills holds id, slug, url,
-- company, title, ats and the rule, and nothing else the classifier can read.
-- So every value in this column is read from the title, the source is a
-- constant, and a source column here would be a column with one value in it.
-- familyOf(null, title) is the call, the same function db/212 stores for live
-- rows, so a kill and a posting with the same title land in the same family —
-- which is the whole point of putting it here rather than deriving it in the
-- page.
--
-- NULL IS STILL A REAL ANSWER, and there will be more of it here than on the
-- live board: a title alone places less than a title plus a department does.
-- A kill the classifier cannot place is outside every chosen family, the same
-- rule the live board states for a row with no family and the age strip states
-- for a row with no measurable age.
--
-- The backfill is scripts/backfill-derived.mjs --kills; the nightly writer is
-- the KILL_UPSERT in scripts/ingest-jobs.mjs. Additive and idempotent: the
-- column is nullable with no default, so an un-backfilled database behaves
-- exactly as it does today (the archive empties under a watch) rather than
-- claiming a classification it has not made.

ALTER TABLE board_kills ADD COLUMN IF NOT EXISTS derived_fam TEXT;

-- The archive is cut by family and seniority together, so they are indexed
-- together, and only over the rows the views can draw (a vacated kill is one
-- the posting came back from and no view shows it).
CREATE INDEX IF NOT EXISTS board_kills_fam_tier_idx
  ON board_kills (derived_fam, derived_tier) WHERE vacated_at IS NULL;

-- Nothing but a real family id, or nothing at all. The same guard db/212 puts
-- on jobs.derived_fam, and for the same reason: that column held 3,350 raw
-- department strings for months while every reader of it assumed a closed set.
-- Written with an explicit IS NOT NULL because a CHECK only refuses an explicit
-- FALSE — a NULL branch passes, which would make this decoration.
ALTER TABLE board_kills DROP CONSTRAINT IF EXISTS board_kills_derived_fam_known;
ALTER TABLE board_kills ADD CONSTRAINT board_kills_derived_fam_known CHECK (
  derived_fam IS NULL OR (
    derived_fam IS NOT NULL AND derived_fam IN (
      'software', 'data-ai', 'it-infra', 'security', 'design', 'product', 'sales', 'marketing',
      'customer', 'finance', 'legal', 'people', 'operations', 'trades', 'manufacturing', 'health',
      'social-care', 'education', 'hospitality', 'public-safety', 'science', 'admin'
    )
  )
);
