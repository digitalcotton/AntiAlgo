-- 218: jobs.pipeline — is this posting an evergreen talent pool, or one opening?
--
-- Apple is the first feed in the crawl to state it (type PIPE vs REQ) and it is
-- not a rounding error: 3,132 of its 4,909 postings on 2026-09-30. A pool never
-- closes and so reads as permanently open, and Apple additionally stamps some of
-- them with the request time as their posting date. Both make a pool look like
-- fresher, realer hiring than it is.
--
-- NULLABLE, AND NULL IS NOT FALSE. true/false only where the feed says so; null
-- where the feed has no such concept, which today is every other adapter. The
-- same discipline fields.py states for every absent value: a backfilled default
-- is a claim the feed never made, and "we do not know whether this is a pool" is
-- a different fact from "it is not one".
--
-- Nothing reads this yet. It exists so the choice of what to do about pools can
-- be made later against data already collected, rather than needing a re-crawl
-- of every board to answer the question.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pipeline boolean;

COMMENT ON COLUMN jobs.pipeline IS
  'true = evergreen talent pool, false = a specific opening, null = the feed does not say.';
