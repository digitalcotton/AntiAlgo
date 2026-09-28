-- 212: where derived_fam's answer came from.
--
-- derived_fam was declared in db/207 and never built: famFromDepartment()
-- returned the crawled department verbatim, so the column held 3,350 distinct
-- values including 'FLZR', 'Scaling' and 'Cody Agency'. A column with 3,350
-- values groups nothing, and nothing downstream could use it. src/lib/job-family.mjs
-- now clusters those strings into 22 occupational families.
--
-- WHY A SECOND COLUMN RATHER THAN JUST A BETTER FIRST ONE. The department is a
-- field the employer filled in; the title is this repo reading a string. They
-- are different claims and jobs-derived.mjs's own note warned against the
-- weaker one "wearing the same name". Department alone classifies 67.8% of the
-- board and the title rescues another 7,520 postings, so both are worth having
-- and the only real requirement is that a reader can tell them apart. That is
-- this column.
--
--   'department'  the employer filed it under a department that names a family
--   'title'       no usable department, and the title named one
--   NULL          neither named a family. derived_fam is NULL too.
--
-- A reader that only trusts stated facts filters on source = 'department'. A
-- reader that wants coverage takes both. Neither can mistake one for the other,
-- which is the whole point.
--
-- Additive and backfilled in place: every existing row already has a
-- derived_fam holding the old verbatim department, and scripts/backfill-derived.mjs
-- rewrites both columns together. Nothing reads the new column until it does.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS derived_fam_source TEXT;

-- The three states, enforced rather than documented. A source without a family,
-- or a family without a source, means the writer disagreed with itself.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_derived_fam_source_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_derived_fam_source_check CHECK (
  (derived_fam IS NULL AND derived_fam_source IS NULL)
  OR (derived_fam IS NOT NULL AND derived_fam_source IN ('department', 'title'))
);

-- The board filters on family, so it is worth an index; partial because a NULL
-- family is never selected FOR, only counted, and 12.3% of rows carry one.
-- Same reasoning db/207 gives for its own partial indexes.
CREATE INDEX IF NOT EXISTS jobs_derived_fam_idx ON jobs (derived_fam) WHERE derived_fam IS NOT NULL;
