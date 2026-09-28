-- 212: where derived_fam's answer came from, and clearing what it used to hold.
--
-- derived_fam was declared in db/207 and never built: famFromDepartment()
-- returned the crawled department verbatim, so the column held 3,350 distinct
-- values including 'FLZR', 'Scaling' and 'Cody Agency'. A column with 3,350
-- values groups nothing. src/lib/job-family.mjs now clusters those strings into
-- 22 occupational families.
--
-- WHY A SECOND COLUMN RATHER THAN JUST A BETTER FIRST ONE. The department is a
-- field the employer filled in; the title is this repo reading a string. They
-- are different claims and jobs-derived.mjs's own note warned against the
-- weaker one "wearing the same name". Department alone classifies 67.8% of the
-- board and the title rescues another 7,520 postings, so both are worth having
-- and the only requirement is that a reader can tell them apart.
--
--   'department'  the employer filed it under a department that names a family
--   'title'       no usable department, and the title named one
--   NULL          neither named a family. derived_fam is NULL too.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS derived_fam_source TEXT;

-- THE OLD VALUES ARE NOT FAMILIES, SO THEY GO. Every existing row carries the
-- verbatim department in derived_fam. 'Cody Agency' is not a classification and
-- must not be left sitting in a column that now means one — a reader joining on
-- derived_fam would get 3,350 groups of one and no error to explain it. The
-- next ingest rewrites every row (scripts/ingest-jobs.mjs --replace), and
-- scripts/backfill-derived.mjs fills any row that misses, so this clears rather
-- than tries to translate.
--
-- Anything that IS already a valid family id is left alone, so re-running this
-- after a backfill is a no-op rather than a round trip through NULL.
UPDATE jobs
   SET derived_fam = NULL, derived_fam_source = NULL
 WHERE derived_fam IS NOT NULL
   AND derived_fam NOT IN (
     'software', 'data-ai', 'it-infra', 'security', 'design', 'product',
     'sales', 'marketing', 'customer', 'finance', 'legal', 'people',
     'operations', 'trades', 'manufacturing', 'health', 'social-care',
     'education', 'hospitality', 'public-safety', 'science', 'admin'
   );

-- Whatever survived the clear is a real family written before this column
-- existed, so it came from the department by definition.
UPDATE jobs SET derived_fam_source = 'department'
 WHERE derived_fam IS NOT NULL AND derived_fam_source IS NULL;

-- The three states, enforced rather than documented.
--
-- NOTE THE EXPLICIT IS NOT NULL, WHICH IS THE WHOLE CONSTRAINT. Written as
-- `derived_fam_source IN ('department','title')` alone, a NULL source makes the
-- branch evaluate to NULL rather than FALSE, and a CHECK only refuses an
-- explicit FALSE — so a family with no source passed. That was verified by
-- reproducing it before this line was written; the constraint had been decoration.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_derived_fam_source_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_derived_fam_source_check CHECK (
  (derived_fam IS NULL AND derived_fam_source IS NULL)
  OR (
    derived_fam IS NOT NULL
    AND derived_fam_source IS NOT NULL
    AND derived_fam_source IN ('department', 'title')
  )
);

-- The board filters on family, so it is worth an index; partial because a NULL
-- family is never selected FOR, only counted, and 12.3% of rows carry one.
-- Same reasoning db/207 gives for its own partial indexes.
CREATE INDEX IF NOT EXISTS jobs_derived_fam_idx ON jobs (derived_fam) WHERE derived_fam IS NOT NULL;
