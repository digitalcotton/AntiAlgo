/**
 * build-search-suggestions.mjs: the board search box's type-ahead list.
 *
 * WHY A LIST AT ALL. The search field was `autocomplete="off"` over
 * `title ILIKE … OR company ILIKE …` and nothing else. It is the one control a
 * reader reaches for first and the only one that offered no vocabulary, so the
 * two controls on the same strip disagreed in both directions: typing "nurse"
 * returned 747 while the Field control held 4,430 Healthcare roles, and typing
 * "design" returned 676 against a Design field of 313. That gap — a title-level
 * entry point that suggests — is the whole of what LinkedIn does better here,
 * and it is not a taxonomy problem.
 *
 * WHY A FIXED LIST WORKS ON A BOARD THIS FRAGMENTED. 22,978 of 26,385 distinct
 * titles occur exactly once, and the top 100 normalised phrases cover only 26%
 * of rows. So this is NOT a catalogue of the board and must never be read as
 * one. It is a set of shortcuts into a substring search that still accepts
 * anything a person types, which is why a list that reaches 91% of English rows
 * and 61% of the rest is worth shipping rather than withholding.
 *
 * WHY IT IS BUILT HERE AND COMMITTED, not read at request time. The whole
 * useful list is ~13 KB raw and ~2 KB over the wire, so an endpoint would cost
 * a round trip to save nothing, and this repo has already fought the "load the
 * board into JS" battle once (db/207, desk-agg.ts: 6.72 MB -> 121.4 KB per
 * request). The existing title index is the wrong list for this job twice over:
 * it groups RAW titles, so "Software Engineer" is rank 170 with 12 rows while
 * the board's own search returns 1,276 for it, and its head is dominated by
 * single-employer and non-English strings.
 *
 * THE COUNT BESIDE A SUGGESTION IS THE NUMBER THE SEARCH RETURNS, not the
 * number of rows whose title equals the phrase. Those differ by two orders of
 * magnitude here, and a suggestion that promises 12 and delivers 1,276 is worse
 * than no suggestion.
 *
 *   npm run build:suggestions        (needs DATABASE_URL)
 *
 * It rewrites src/data/search-suggestions.json. Re-run it when the corpus has
 * moved enough to matter; the list is a convenience, not a contract, and a
 * stale entry costs a reader one search that returns fewer rows than it says.
 */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { FAMILIES } from '../src/lib/job-family.mjs';

const OUT = new URL('../src/data/search-suggestions.json', import.meta.url);

/** Phrases must clear this many live rows to be offered at all. */
const MIN_ROWS = 8;
/** …and come from more than one employer, so a single company's req titles
    do not become the board's suggested vocabulary. */
const MIN_COMPANIES = 2;
/** Generic tails ("engineer", "nurse") carry most of the reach, and need a
    higher bar because they are single words. */
const MIN_ROWS_ONE_WORD = 40;
const MIN_ROWS_TWO_WORDS = 25;
/** Substring search over-matches short strings: "tech" returns 3,161 rows of
    which about half are not whole-word matches. Nothing shorter is offered. */
const MIN_CHARS = 5;
const MAX_TITLES = 200;
const MAX_COMPANIES = 90;

/**
 * One normalised phrase per live row. Lower-cased; parentheticals, bracketed
 * asides and everything after " - " or " | " or the first comma dropped;
 * m/w/d gender tags, leading seniority words, trailing level tokens and
 * federal grade codes removed; remote/hybrid/contract words dropped wherever
 * they sit. What is left is the thing a person would actually type.
 */
const NORM_SQL = `
CREATE TEMP TABLE norm AS
WITH a AS (
  SELECT id, company, lower(btrim(title)) AS t FROM jobs
   WHERE status='live' AND btrim(coalesce(title,''))<>''
), b AS (SELECT *, regexp_replace(t, '\\([^)]*\\)|\\[[^\\]]*\\]', ' ', 'g') AS t1 FROM a),
c AS (SELECT *, regexp_replace(t1, '\\s+[-–—|]\\s+.*$', '', 'g') AS t2 FROM b),
d AS (SELECT *, CASE WHEN length(btrim(split_part(t2, ',', 1))) >= 3 THEN split_part(t2, ',', 1) ELSE t2 END AS t3 FROM c),
e AS (SELECT *, regexp_replace(t3, '\\m(m|w|f|d|h|x)\\s*/\\s*(m|w|f|d|h|x)(\\s*/\\s*(m|w|f|d|h|x))?\\M', ' ', 'g') AS t4 FROM d),
f AS (SELECT *, regexp_replace(btrim(t4), '^((senior|sr\\.?|staff|lead|principal|junior|jr\\.?)\\s+)+', '') AS t5 FROM e),
g AS (SELECT *, regexp_replace(regexp_replace(btrim(t5), '\\s+((i|ii|iii|iv|v|vi)|level\\s*\\d+|l\\d)$', ''), '\\s+(gs|cy|wg|ws|nf|ng|nx|gg)[- ]?\\d+([/-]\\d+)*$', '') AS t6 FROM f),
h AS (SELECT *, regexp_replace(t6, '\\m(remote|hybrid|onsite|on-site|contract|temporary|temp|full-time|part-time|fulltime|parttime)\\M', ' ', 'g') AS t7 FROM g),
i AS (SELECT *, btrim(regexp_replace(regexp_replace(regexp_replace(t7, '[^[:alnum:] &+#./]', ' ', 'g'), '^[ ./&]+|[ ./&]+$', '', 'g'), '\\s+', ' ', 'g')) AS phrase FROM h)
SELECT id, company, phrase FROM i WHERE length(phrase) >= 3`;

/** The candidate pool: whole phrases, plus the last word and last two words of
    each, so a reader who types only "engineer" or "account manager" is met. */
const POOL_SQL = `
WITH whole AS (
  SELECT phrase AS p, count(*)::int AS n, count(DISTINCT company)::int AS cos
    FROM norm GROUP BY 1
   HAVING count(*) >= ${MIN_ROWS} AND count(DISTINCT company) >= ${MIN_COMPANIES}
), tail1 AS (
  SELECT (regexp_split_to_array(phrase, ' '))[array_length(regexp_split_to_array(phrase, ' '), 1)] AS p,
         count(*)::int AS n, count(DISTINCT company)::int AS cos
    FROM norm GROUP BY 1 HAVING count(*) >= ${MIN_ROWS_ONE_WORD} AND count(DISTINCT company) >= ${MIN_COMPANIES}
), tail2 AS (
  SELECT array_to_string((regexp_split_to_array(phrase, ' '))[
           greatest(1, array_length(regexp_split_to_array(phrase, ' '), 1) - 1)
           : array_length(regexp_split_to_array(phrase, ' '), 1)], ' ') AS p,
         count(*)::int AS n, count(DISTINCT company)::int AS cos
    FROM norm GROUP BY 1 HAVING count(*) >= ${MIN_ROWS_TWO_WORDS} AND count(DISTINCT company) >= ${MIN_COMPANIES}
)
SELECT p, max(n) AS n FROM (SELECT * FROM whole UNION ALL SELECT * FROM tail1 UNION ALL SELECT * FROM tail2) u
 WHERE length(p) >= ${MIN_CHARS}
 GROUP BY p ORDER BY max(n) DESC LIMIT 900`;

/** Title Case for display, leaving acronyms and joiners alone. */
const SMALL = new Set(['and', 'of', 'the', 'for', 'to', 'in', 'on', 'at', 'a', 'an', '&']);
function titleCase(phrase) {
  return phrase
    .split(' ')
    .map((word, index) => {
      if (index > 0 && SMALL.has(word)) return word;
      if (/^(it|hr|qa|ui|ux|ai|ml|sre|devops|erp|crm|seo|sap|bi|cnc|hvac|emt|rn|lpn|cdl)$/.test(word)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('build-search-suggestions: DATABASE_URL is not set. Nothing written.');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  await client.query(NORM_SQL);
  const { rows: pool } = await client.query(POOL_SQL);

  // The yield each candidate would actually return, measured through the board
  // search's own clause rather than assumed from the phrase's own count.
  const titles = [];
  for (const { p } of pool) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM jobs
        WHERE status='live' AND (title ILIKE $1 OR company ILIKE $1)`,
      [`%${p.replace(/[\\%_]/g, '\\$&')}%`]
    );
    const n = rows[0]?.n ?? 0;
    if (n >= MIN_ROWS) titles.push({ t: titleCase(p), k: 't', n });
  }
  titles.sort((a, b) => b.n - a.n);

  // Drop a phrase whose yield a shorter one already covers: "software engineer"
  // earns its place beside "engineer"; "senior software engineer" does not.
  const kept = [];
  for (const entry of titles) {
    const lower = entry.t.toLowerCase();
    if (kept.some((k) => lower !== k.t.toLowerCase() && lower.includes(k.t.toLowerCase()) && entry.n / k.n > 0.6)) continue;
    kept.push(entry);
    if (kept.length >= MAX_TITLES) break;
  }

  const { rows: companies } = await client.query(
    `SELECT company AS t, count(*)::int AS n FROM jobs WHERE status='live'
      GROUP BY 1 ORDER BY 2 DESC LIMIT ${MAX_COMPANIES}`
  );

  // The 22 fields go in the same list. They are not substrings of anything —
  // "Healthcare & Medicine" as a search term returns nothing — so the board
  // resolves a typed field name to the Field control instead of searching for
  // it (see parseBoardQuery's familyFromSearch).
  const { rows: famRows } = await client.query(
    `SELECT derived_fam AS id, count(*)::int AS n FROM jobs
      WHERE status='live' AND derived_fam IS NOT NULL GROUP BY 1`
  );
  const famCount = new Map(famRows.map((r) => [r.id, r.n]));
  const fields = FAMILIES.map((f) => ({ t: f.label, k: 'f', id: f.id, n: famCount.get(f.id) ?? 0 }));

  const out = [
    ...fields,
    ...kept,
    ...companies.map((c) => ({ t: c.t, k: 'c', n: c.n }))
  ];
  const json = JSON.stringify(out);
  writeFileSync(OUT, json + '\n');
  await client.end();
  console.log(
    `build-search-suggestions: ${out.length} entries ` +
      `(${fields.length} fields, ${kept.length} titles, ${companies.length} companies), ` +
      `${json.length.toLocaleString()} bytes -> src/data/search-suggestions.json`
  );
}

main().catch((error) => {
  console.error('build-search-suggestions failed:', error);
  process.exit(1);
});
