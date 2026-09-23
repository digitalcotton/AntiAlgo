/**
 * backfill-derived.mjs: fill db/207's derived columns on rows that were written
 * before the column existed.
 *
 * WHY IT IS NEEDED AT ALL, GIVEN THE INGEST TRUNCATES. scripts/ingest-jobs.mjs
 * replaces the jobs table whole on every crawl and now writes these columns
 * itself, so the next crawl would fill them anyway. But "the next crawl" is up
 * to a day away, and until then every row reads derived_region 'Unknown',
 * derived_friction 'easy' and priced false, which is the column defaults
 * masquerading as measurements. This runs the same definition over the rows
 * already on file so the two halves agree immediately.
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

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PAGE = Math.max(100, Number(arg('--page', '2000')) || 2000);

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
    const b = i * 9;
    holes.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
    params.push(
      r.id, d.derived_tier, d.derived_fam, d.derived_region, d.derived_friction,
      d.priced, d.comp_min_k, d.comp_max_k, d.comp_mid_k
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
       derived_region   = v.derived_region::text,
       derived_friction = v.derived_friction::text,
       priced           = v.priced::boolean,
       comp_min_k       = v.comp_min_k::integer,
       comp_max_k       = v.comp_max_k::integer,
       comp_mid_k       = v.comp_mid_k::integer
     FROM (VALUES ${holes.join(',')}) AS v(id, derived_tier, derived_fam, derived_region,
                                           derived_friction, priced, comp_min_k, comp_max_k, comp_mid_k)
     WHERE j.id = v.id
       AND (j.derived_tier     IS DISTINCT FROM v.derived_tier::text
         OR j.derived_fam      IS DISTINCT FROM v.derived_fam::text
         OR j.derived_region   IS DISTINCT FROM v.derived_region::text
         OR j.derived_friction IS DISTINCT FROM v.derived_friction::text
         OR j.priced           IS DISTINCT FROM v.priced::boolean
         OR j.comp_min_k       IS DISTINCT FROM v.comp_min_k::integer
         OR j.comp_max_k       IS DISTINCT FROM v.comp_max_k::integer
         OR j.comp_mid_k       IS DISTINCT FROM v.comp_mid_k::integer)`,
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
      holes.push(`($${n * 2 + 1},$${n * 2 + 2})`);
      params.push(r.id, tierFromTitle(r.title));
    });
    const res = await client.query(
      `UPDATE board_kills k SET derived_tier = v.derived_tier::text
         FROM (VALUES ${holes.join(',')}) AS v(id, derived_tier)
        WHERE k.id = v.id AND k.derived_tier IS DISTINCT FROM v.derived_tier::text`,
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
         count(*) FILTER (WHERE derived_region <> 'Unknown')::int AS placed
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
  `  region placed    ${c.placed}` +
  (unchecked.length
    ? `\n  NOT CHECKED, reading 'easy' by default: ` +
      unchecked.map((s) => `${s.ats} (${s.n})`).join(', ') +
      `\n  Check each apply flow and add it to MEASURED_ATS in src/lib/jobs-derived.mjs.`
    : `\n  every applicant system on the board has had its apply flow checked`)
);

await client.end();
