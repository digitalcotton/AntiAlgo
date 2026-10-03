-- 220: jobs.place_*: where a posting is, as four fields instead of one string.
--
-- WHY. The board carries a location string on 99.5% of its rows and a resolved
-- country on 40.3% (15,023 of 37,286 live rows, 2026-10-02). The strings are
-- free text: "Seattle, Washington, USA", "Amsterdam, Noord-Holland, Nederland",
-- "Ireland - Dublin", "San Francisco". The search box's "where" facet and the
-- country filter need a country, a state and a city that can be compared and
-- counted, and derived_region (db/207) cannot be that: it has five US buckets,
-- one bucket for all of Europe and nothing for the Middle East.
--
-- These columns are written by ONE definition, placeOf() in
-- src/lib/jobs-derived.mjs, called from derivedFor() by scripts/ingest-jobs.mjs
-- on every row of every crawl and by scripts/backfill-derived.mjs for rows
-- already on file. Nothing restates a place rule in SQL. The city table it
-- reads is src/data/place-cities.json, built by scripts/build-place-table.mjs.
--
-- ALL FOUR ARE NULLABLE, AND NULL IS NOT "UNKNOWN". A posting that prints
-- "Multiple Locations", "Remote" or "Worldwide" has no place to resolve, and
-- the page shows that as a gap. A city and a state are written only beside a
-- country: a city with no country is a guess about a word.
--   place_country  ISO 3166-1 alpha-2 ('US', 'GB', 'DE'), never 'remote_unresolved'
--   place_admin1   US state, Canadian province or Australian state code ('TX',
--                  'ON', 'NSW'); null for every other country
--   place_city     the city as the board spells it ('Austin', 'Munich')
--   place_label    what a reader sees: "Austin, TX", "London, United Kingdom",
--                  or the country alone when the posting names no city
--
-- NOT A COPY OF jobs.country. The crawl's own country is the starting point and
-- is believed, with one exception: a single place whose text spells out another
-- country (the crawl has put "Albuquerque, New Mexico" under Mexico) takes the
-- text's country. jobs.country is left exactly as the crawl wrote it.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS place_country TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS place_admin1  TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS place_city    TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS place_label   TEXT;

COMMENT ON COLUMN jobs.place_country IS
  'ISO 3166-1 alpha-2 country resolved by placeOf() (src/lib/jobs-derived.mjs); null = the posting names no place.';
COMMENT ON COLUMN jobs.place_admin1 IS
  'US state, Canadian province or Australian state code; null for other countries and when unstated.';
COMMENT ON COLUMN jobs.place_city IS
  'City as the board spells it; only ever set beside place_country.';
COMMENT ON COLUMN jobs.place_label IS
  'Display label: "City, ST" for US/CA/AU, "City, Country" elsewhere, the country alone with no city.';

-- PARTIAL ON THE LIVE ROWS, for the reason db/207 gives: every board query
-- carries "status <> 'killed'" literally, so Postgres can match these
-- predicates, and killed rows never appear in a filtered cut. The first serves
-- "jobs in Germany"; the second serves "jobs in Texas" and, as a prefix, the
-- country alone, so it is also what a country-then-state facet count reads.
CREATE INDEX IF NOT EXISTS jobs_live_place_country_idx ON jobs (place_country)
  WHERE status <> 'killed';
CREATE INDEX IF NOT EXISTS jobs_live_place_admin_idx ON jobs (place_country, place_admin1)
  WHERE status <> 'killed';
