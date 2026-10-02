/**
 * backfill-derived.mjs: fill db/207's derived columns on rows that were written
 * before the column existed.
 *
 * WHY IT IS NEEDED AT ALL, GIVEN THE INGEST REPLACES THE BOARD.
 * scripts/ingest-jobs.mjs replaces the jobs table whole on every crawl and now
 * writes these columns itself, so the next crawl would fill them anyway. But
 * "the next crawl" is up to a day away, and until then every row reads
 * derived_region 'Unknown', derived_friction 'easy' and priced false, which is
 * the column defaults masquerading as measurements. This runs the same
 * definition over the rows already on file so the two halves agree immediately.
 *
 * IT ALSO FILLS db/220's place_country, place_admin1, place_city and place_label,
 * and db/222's place_keys and place_leaves (every place a posting lists) and
 * db/223's place_countries (the countries among them), and it is the only thing
 * that will for rows already on file: the ingest writes them on the next crawl,
 * but "the next crawl" is up to a day away. db/222 and db/223 do not fill their
 * columns themselves, so until this has run every row reads '{}' and '', which the
 * board reads as "Not stated". Run with --all after db/222 or db/223 lands, and
 * after a change to placeOf(), placesOf() or src/data/place-cities.json, for the
 * same reason as any other rule change here.
 *
 * ONE DEFINITION. It imports src/lib/jobs-derived.mjs, the same module the
 * ingest calls. It does not restate a single rule in SQL. That is the whole
 * point: a rule lives in one function, and everything that writes these columns
 * calls that function.
 *
 * Reads only the columns the derivation needs, in pages, and writes back with
 * one UPDATE ... FROM per page so a run is a bounded number of round trips
 * rather than one per row.
 *
 * Usage:
 *   DATABASE_URL_UNPOOLED=... node scripts/backfill-derived.mjs [--all] [--page 2000]
 *
 *   --all   also rewrite rows that already carry a derived value (use after a
 *           rule change). The default touches every row anyway on first run,
 *           because every row starts on the defaults; --all matters on reruns.
 */
import pg from 'pg';
import { derivedFor, tierFromTitle, isMeasuredAts } from '../src/lib/jobs-derived.mjs';
import { familyOf } from '../src/lib/job-family.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
// Values bound per row: the id, nine derived columns (db/207, db/212), the
// four place columns (db/220), the two place arrays (db/222) and the country
// string (db/223). The placeholders are generated from this so a column added
// later cannot leave the VALUES list one short, and the page size is held under
// Postgres's 65,535 bound parameters per statement.
const PER_ROW = 17;
const PAGE = Math.min(
  Math.floor(65535 / PER_ROW),
  Math.max(100, Number(arg('--page', '2000')) || 2000)
);

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('backfill-derived: no DATABASE_URL_UNPOOLED or DATABASE_URL in the environment.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

let lastId = '';
let seen = 0;
let changed = 0;
const started = Date.now();

for (;;) {
  const { rows } = await client.query(
    `SELECT id, title, department, country, location, ats, comp_range
       FROM jobs
      WHERE id > $1
      ORDER BY id
      LIMIT $2`,
    [lastId, PAGE]
  );
  if (rows.length === 0) break;
  lastId = rows[rows.length - 1].id;
  seen += rows.length;

  // One UPDATE for the page. The derived values ride in as a VALUES list and
  // join back on id; the casts are explicit because a VALUES list of literals
  // arrives as text and Postgres will not guess the column types for us.
  const holes = [];
  const params = [];
  rows.forEach((r, i) => {
    const d = derivedFor(r);
    const b = i * PER_ROW;
    holes.push(`(${Array.from({ length: PER_ROW }, (_, k) => `$${b + k + 1}`).join(',')})`);
    params.push(
      r.id, d.derived_tier, d.derived_fam, d.derived_fam_source, d.derived_region, d.derived_friction,
      d.priced, d.comp_min_k, d.comp_max_k, d.comp_mid_k,
      // db/220: where the posting is. Null is written as null (the ::text cast
      // below keeps a VALUES list of nulls from being typed as unknown).
      d.place_country, d.place_admin1, d.place_city, d.place_label,
      // db/222: every place it lists. A JS array goes out as a Postgres array
      // literal, so the ::text[] cast below reads it back; [] is '{}'.
      d.place_keys, d.place_leaves,
      // db/223: the countries among them, one string ('' for none, never null).
      d.place_countries
    );
  });

  const res = await client.query(
    // Every value is cast explicitly. A VALUES list of bound parameters arrives
    // as text, so an uncast assignment to priced (boolean) or comp_min_k
    // (integer) is refused outright, and the three k columns would silently
    // stringify if they were not.
    `UPDATE jobs j SET
       derived_tier     = v.derived_tier::text,
       derived_fam      = v.derived_fam::text,
       derived_fam_source = v.derived_fam_source::text,
       derived_region   = v.derived_region::text,
       derived_friction = v.derived_friction::text,
       priced           = v.priced::boolean,
       comp_min_k       = v.comp_min_k::integer,
       comp_max_k       = v.comp_max_k::integer,
       comp_mid_k       = v.comp_mid_k::integer,
       place_country    = v.place_country::text,
       place_admin1     = v.place_admin1::text,
       place_city       = v.place_city::text,
       place_label      = v.place_label::text,
       place_keys       = v.place_keys::text[],
       place_leaves     = v.place_leaves::text[],
       place_countries  = v.place_countries::text
     FROM (VALUES ${holes.join(',')}) AS v(id, derived_tier, derived_fam, derived_fam_source,
                                           derived_region, derived_friction, priced, comp_min_k,
                                           comp_max_k, comp_mid_k, place_country, place_admin1,
                                           place_city, place_label, place_keys, place_leaves,
                                           place_countries)
     WHERE j.id = v.id
       AND (j.derived_tier     IS DISTINCT FROM v.derived_tier::text
         OR j.derived_fam      IS DISTINCT FROM v.derived_fam::text
         OR j.derived_fam_source IS DISTINCT FROM v.derived_fam_source::text
         OR j.derived_region   IS DISTINCT FROM v.derived_region::text
         OR j.derived_friction IS DISTINCT FROM v.derived_friction::text
         OR j.priced           IS DISTINCT FROM v.priced::boolean
         OR j.comp_min_k       IS DISTINCT FROM v.comp_min_k::integer
         OR j.comp_max_k       IS DISTINCT FROM v.comp_max_k::integer
         OR j.comp_mid_k       IS DISTINCT FROM v.comp_mid_k::integer
         OR j.place_country    IS DISTINCT FROM v.place_country::text
         OR j.place_admin1     IS DISTINCT FROM v.place_admin1::text
         OR j.place_city       IS DISTINCT FROM v.place_city::text
         OR j.place_label      IS DISTINCT FROM v.place_label::text
         OR j.place_keys       IS DISTINCT FROM v.place_keys::text[]
         OR j.place_leaves     IS DISTINCT FROM v.place_leaves::text[]
         OR j.place_countries  IS DISTINCT FROM v.place_countries::text)`,
    params
  );
  changed += res.rowCount || 0;
  process.stderr.write(`\rbackfill-derived: ${seen} read, ${changed} written`);
}

process.stderr.write('\n');

// The archive, the same way. It is small (hundreds of rows, not tens of
// thousands) and never truncated, so one pass with no paging.
{
  const { rows } = await client.query(`SELECT id, title FROM board_kills`);
  let killsChanged = 0;
  for (let i = 0; i < rows.length; i += PAGE) {
    const slice = rows.slice(i, i + PAGE);
    const holes = [];
    const params = [];
    slice.forEach((r, n) => {
      holes.push(`($${n * 3 + 1},$${n * 3 + 2},$${n * 3 + 3})`);
      // A kill has no department — board_kills holds the title and nothing
      // else the classifier can read — so the family comes from the title
      // alone, through the same function the live rows use (db/214). Expect
      // more nulls here than on the board: a title places less than a title
      // plus a department does.
      params.push(r.id, tierFromTitle(r.title), familyOf(null, r.title));
    });
    const res = await client.query(
      `UPDATE board_kills k SET
         derived_tier = v.derived_tier::text,
         derived_fam  = v.derived_fam::text
         FROM (VALUES ${holes.join(',')}) AS v(id, derived_tier, derived_fam)
        WHERE k.id = v.id
          AND (k.derived_tier IS DISTINCT FROM v.derived_tier::text
            OR k.derived_fam  IS DISTINCT FROM v.derived_fam::text)`,
      params
    );
    killsChanged += res.rowCount || 0;
  }
  console.log(`backfill-derived: ${rows.length} archive rows read, ${killsChanged} updated`);
}

// The receipt: what the board now says about itself, so a run that silently did
// nothing cannot look like a run that worked.
const { rows: check } = await client.query(`
  SELECT count(*)::int AS live,
         count(derived_tier)::int AS with_tier,
         count(derived_fam)::int AS with_fam,
         count(*) FILTER (WHERE priced)::int AS priced,
         count(*) FILTER (WHERE derived_friction = 'hard')::int AS hard,
         count(*) FILTER (WHERE derived_region <> 'Unknown')::int AS placed,
         count(place_country)::int AS with_country,
         count(place_city)::int AS with_city,
         count(*) FILTER (WHERE cardinality(place_keys) > 0)::int AS with_keys,
         count(*) FILTER (WHERE cardinality(place_leaves) > 1)::int AS with_several
    FROM jobs WHERE status <> 'killed'`);
// An applicant system nobody has checked reads 'easy' by default, which is a
// default and not a measurement. Name it, so a new adapter's first night is a
// line here rather than a silent claim about a few thousand postings.
const { rows: systems } = await client.query(
  `SELECT ats, count(*)::int n FROM jobs WHERE status <> 'killed' GROUP BY 1 ORDER BY n DESC`
);
const unchecked = systems.filter((s) => !isMeasuredAts(s.ats));

const c = check[0];
console.log(
  `backfill-derived: ${seen} rows read, ${changed} updated in ${Math.round((Date.now() - started) / 1000)}s\n` +
  `  live rows        ${c.live}\n` +
  `  seniority read   ${c.with_tier}\n` +
  `  department read  ${c.with_fam}\n` +
  `  range printed    ${c.priced}\n` +
  `  account to apply ${c.hard}\n` +
  `  region placed    ${c.placed}\n` +
  `  place country    ${c.with_country}\n` +
  `  place city       ${c.with_city}\n` +
  `  places listed    ${c.with_keys} (${c.with_several} list several)` +
  (unchecked.length
    ? `\n  NOT CHECKED, reading 'easy' by default: ` +
      unchecked.map((s) => `${s.ats} (${s.n})`).join(', ') +
      `\n  Check each apply flow and add it to MEASURED_ATS in src/lib/jobs-derived.mjs.`
    : `\n  every applicant system on the board has had its apply flow checked`)
);

await client.end();
