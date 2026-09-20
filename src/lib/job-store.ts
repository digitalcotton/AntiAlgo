/**
 * job-store.ts: the read/write half of the general-tracker job table
 * (db/017_jobs.sql). The site reads the /board surface one page at a time
 * through listBoardFiltered() (2026-09-11) and the age plot through
 * listBoardAgeHistogram(), a GROUP BY rather than a read of every row (2026-09-19);
 * the mini's tracker is the only writer in production, but upsertJobs() lives
 * here so the ingest has one place that knows the table's shape.
 *
 * Same discipline as watchlist-store.ts and desk-store.ts: PARAMETERISED
 * QUERIES ONLY, no value is ever concatenated into SQL. The search term is a
 * bound parameter used with ILIKE, never interpolated.
 */
import { db } from './db';
import type { BoardRow } from './board-jobs';
import type { AgeHistogram, AgeBucket } from './data';
import { normalizeTitle } from './ledger-titles';

/**
 * The columns the board adapter (board-jobs.ts) reads, in one place. ghost is
 * gone (2026-09-08): it was an age flag, the retired evergreen rule under
 * another name. status and kill_id are the record's answer instead, written by
 * the ingest from board_kills (db/030, db/031).
 */
const BOARD_COLUMNS = `j.id, j.slug, j.company, j.title, j.url, j.location, j.country, j.remote, j.published, j.ats,
  j.posting_id, j.department, j.comp_posted, j.comp_range, j.days_up, j.first_seen, j.last_seen,
  j.fit_total, j.fit_components, j.source, j.description, j.status, j.kill_id`;

/**
 * The kill of record beside a board row, when one names it. Read with a LEFT
 * JOIN on jobs.kill_id so a live row carries nulls and a killed row carries the
 * rule, the machine's reason and the dates, exactly as kills-archive.json holds
 * them. Nothing here is derived on the site; the ingest wrote it from the file.
 */
const KILL_COLUMNS = `k.kill_rule, k.reason AS kill_reason, k.killed_on, k.first_published AS kill_first_published,
  k.pipeline AS kill_pipeline`;

/** The board's counts, written by the ingest from the crawl and the kill record (db/020, db/032). */
export interface BoardStats {
  boards_swept: number;
  verified_live: number;
  killed: number;
  killed_by_rule: number;
  postings_observed: number;
  swept_at: Date | string | null;
  kills_by_rule: Record<string, number> | null;
  killed_all_time: number;
  kills_exported_at: Date | string | null;
  /** The sweep's per-stage instants (db/205: read, verify, kill, save as ISO
      strings), or null until the sweep emits them. */
  stage_log: Record<string, string> | null;
}

/**
 * The board's own counts, or null when the sweep has not written them yet. The
 * tiles read this rather than the design sweep's stats.json, so every number
 * over the board is the board's own and updates with the nightly ingest.
 */
export async function getBoardStats(): Promise<BoardStats | null> {
  const { rows } = await db().query<BoardStats>(
    `SELECT boards_swept, verified_live, killed, killed_by_rule, postings_observed, swept_at,
            kills_by_rule, killed_all_time, kills_exported_at, stage_log
       FROM board_stats WHERE id = 1`
  );
  return rows[0] ?? null;
}

/* ---- the paged board (2026-09-11) ---------------------------------------- */

/** The facet keys the board's URL contract allows (src/lib/board-query.ts). */
export interface BoardFilter {
  q: string;
  location: string;
  comp: string;
  freshness: string;
  sort: 'fit' | 'comp' | 'age';
  page: number;
  perPage: number;
  /** The sweep's calendar day (data.ts sweepDate()), the "to" end of every age. */
  sweepDate: string;
  /** The age strip's range in whole days, either end open. A row with no
      measurable age is outside any range that is set. */
  ageMin: number | null;
  ageMax: number | null;
  /** Optional ISO country code to restrict rows to (the homepage teaser
   *  geo-targets by it). Null/undefined = every country, the board's default. */
  country?: string | null;
  /** When true, only rows whose status is 'live' — no killed/closed rows. The
   *  teaser uses it; the board leaves it off and keeps showing kills. */
  liveOnly?: boolean;
  /** When true, only rows that actually show a pay figure (facet_comp is not
   *  'not-listed'), so every teaser row's pay column is filled. */
  hasComp?: boolean;
  /** The signed-in member's watched titles (The Desk). When present and
   *  non-empty, the board is narrowed to rows whose title matches one of them by
   *  the same token-subset rule ledger-titles.matchesTitle uses, so a reader sees
   *  only their own titles instead of the whole sweep. Undefined/empty = the full
   *  board, the default for a signed-out reader or a member with no watch list.
   *  It narrows every facet count too, so the counts describe the narrowed board.
   *  Resolved from Astro.locals.viewer, never from the query string. */
  titles?: string[];
}

/** How many rows each option would leave, given everything else that is set. */
export interface FacetCounts {
  total: number;
  location: Record<string, number>;
  comp: Record<string, number>;
  freshness: Record<string, number>;
}

export interface BoardFilteredResult {
  rows: BoardRow[];
  total: number;
  counts: FacetCounts;
}

/** The comp bands, floor and ceiling, in the order the filter offers them. Kept
    beside the SQL that reads them so the two cannot drift; data.ts's COMP_BANDS
    carries the same numbers for the labels. */
const COMP_BAND_SQL: readonly { key: string; ceiling: number | null }[] = [
  { key: 'under-150', ceiling: 150_000 },
  { key: '150-200', ceiling: 200_000 },
  { key: '200-250', ceiling: 250_000 },
  { key: '250-300', ceiling: 300_000 },
  { key: '300-plus', ceiling: null }
];

/** The ORDER BY for each sort key, allowlisted; the raw string never reaches SQL. */
const BOARD_ORDER: Record<BoardFilter['sort'], string> = {
  fit: 'fit_total DESC, company ASC, title ASC, id ASC',
  comp: 'comp_top DESC NULLS LAST, company ASC, title ASC, id ASC',
  age: 'age_days ASC NULLS LAST, company ASC, title ASC, id ASC'
};

/**
 * The facets, computed in SQL exactly as data.ts computes them in TypeScript
 * (facetsOf, workplaceOf, compBandOf, ageOf, compTop), so a count printed on an
 * option is the count of rows the option leaves. Parameters, in order:
 *   $1 the sweep date, $2 the fresh window in days, $3 the search pattern or
 *   NULL, $4 location, $5 comp, $6 freshness, $7 and $8 the age range in days
 *   (either NULL for open). The range is not a facet: it has no options to
 *   count, so it joins every keep clause and never has a column of its own.
 *
 * location: the words win and the remote flag is not read; "hybrid" beats
 *   "remote" ("Remote or hybrid" is On-site or hybrid), as workplaceOf says.
 * comp: the band of comp_range.min; no numeric floor, or a floor of zero or
 *   less, is "not-listed".
 * age_days: the posted date (UTC calendar day), else the kill's own first
 *   published date, else first_seen when it is strictly before the sweep date;
 *   measured to the kill date for a killed row and to the sweep date otherwise.
 * comp_top: the largest "$Nk" figure in the posted pay text, the comp sort key.
 * description is NULL::text on purpose: the heavy column never leaves the
 * database for a list, and the row shape stays BoardRow.
 */
const BOARD_FACET_CTE = `
WITH base AS (
  SELECT j.id, j.slug, j.company, j.title, j.url, j.location, j.country, j.remote, j.published, j.ats,
         j.posting_id, j.department, j.comp_posted, j.comp_range, j.days_up, j.first_seen, j.last_seen,
         j.fit_total, j.fit_components, j.source, NULL::text AS description, j.status, j.kill_id,
         ${KILL_COLUMNS},
         CASE WHEN j.location ~* '\\yhybrid\\y' THEN 'onsite'
              WHEN j.location ~* '\\yremote\\y' THEN 'remote'
              ELSE 'onsite' END AS facet_location,
         CASE WHEN jsonb_typeof(j.comp_range->'min') IS DISTINCT FROM 'number'
                OR (j.comp_range->>'min')::numeric <= 0 THEN 'not-listed'
              ${COMP_BAND_SQL.filter((b) => b.ceiling !== null)
                .map((b) => `WHEN (j.comp_range->>'min')::numeric < ${b.ceiling} THEN '${b.key}'`)
                .join('\n              ')}
              ELSE '${COMP_BAND_SQL[COMP_BAND_SQL.length - 1].key}' END AS facet_comp,
         CASE
           WHEN coalesce((j.published AT TIME ZONE 'UTC')::date, k.first_published::date) IS NOT NULL
             THEN (CASE WHEN j.status = 'killed' THEN coalesce(k.killed_on::date, $1::date) ELSE $1::date END)
                  - coalesce((j.published AT TIME ZONE 'UTC')::date, k.first_published::date)
           WHEN j.first_seen IS NOT NULL AND j.first_seen < $1::date
             THEN (CASE WHEN j.status = 'killed' THEN coalesce(k.killed_on::date, $1::date) ELSE $1::date END) - j.first_seen
           ELSE NULL END AS age_days,
         (SELECT max((m[1])::numeric) FROM regexp_matches(coalesce(j.comp_posted, ''), '\\$(\\d+(?:\\.\\d+)?)k', 'gi') AS m) AS comp_top
    FROM jobs j LEFT JOIN board_kills k ON k.id = j.kill_id
),
scored AS (
  SELECT b.*,
         CASE WHEN age_days IS NULL THEN 'unknown' WHEN age_days <= $2 THEN 'fresh' ELSE 'older' END AS facet_freshness,
         ($3::text IS NULL OR b.title ILIKE $3 ESCAPE '\\' OR b.company ILIKE $3 ESCAPE '\\') AS match_q
    FROM base b
),
matched AS (
  SELECT s.*,
         ($4::text = 'all' OR facet_location = $4::text) AS match_location,
         ($5::text = 'all' OR facet_comp = $5::text)     AS match_comp,
         ($6::text = 'all' OR facet_freshness = $6::text) AS match_freshness,
         (($7::int IS NULL AND $8::int IS NULL)
           OR (age_days IS NOT NULL
               AND ($7::int IS NULL OR age_days >= $7::int)
               AND ($8::int IS NULL OR age_days <= $8::int))) AS match_age,
         ($9::text IS NULL OR country = $9::text) AS match_country,
         (NOT $10::boolean OR status = 'live')     AS match_live,
         (NOT $11::boolean OR facet_comp <> 'not-listed') AS match_comp_present
    FROM scored s
)`;

/** The count line: every option, leave-one-out, in one round trip. The age
    range is in every keep clause: it is a filter every count respects, not an
    option any count is taken without. */
function facetCountSql(titleClause: string): string {
  const on = (keep: string, extra = '') => `count(*) FILTER (WHERE match_age AND match_country AND match_live AND match_comp_present AND ${titleClause} AND ${keep}${extra})::int`;
  const cols = [
    `${on('match_q AND match_location AND match_comp AND match_freshness')} AS total`,
    `${on('match_q AND match_comp AND match_freshness')} AS location_all`,
    `${on('match_q AND match_comp AND match_freshness', " AND facet_location = 'remote'")} AS location_remote`,
    `${on('match_q AND match_comp AND match_freshness', " AND facet_location = 'onsite'")} AS location_onsite`,
    `${on('match_q AND match_location AND match_freshness')} AS comp_all`,
    ...COMP_BAND_SQL.map(
      (b) => `${on('match_q AND match_location AND match_freshness', ` AND facet_comp = '${b.key}'`)} AS "comp_${b.key}"`
    ),
    `${on('match_q AND match_location AND match_freshness', " AND facet_comp = 'not-listed'")} AS "comp_not-listed"`,
    `${on('match_q AND match_location AND match_comp')} AS freshness_all`,
    `${on('match_q AND match_location AND match_comp', " AND facet_freshness = 'fresh'")} AS freshness_fresh`,
    `${on('match_q AND match_location AND match_comp', " AND facet_freshness = 'older'")} AS freshness_older`,
    `${on('match_q AND match_location AND match_comp', " AND facet_freshness = 'unknown'")} AS freshness_unknown`
  ];
  return `${BOARD_FACET_CTE}\nSELECT ${cols.join(',\n       ')}\n  FROM matched`;
}

/** A search term as a bound ILIKE pattern: the wildcards a person typed are
    literal, so "50%" finds "50%" and not everything. */
export function likePattern(q: string): string | null {
  const trimmed = q.trim();
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * The member's watched titles, compiled to one SQL keep-clause that mirrors
 * ledger-titles.matchesTitle EXACTLY: a role keeps if, for ANY watched title,
 * that title appears in the role title as a contiguous run of whole words (a
 * WHOLE-PHRASE match, tightened 2026-09-18 from any-order tokens). So "Product
 * Designer" keeps "Senior Product Designer, AI" but not "Product Design Engineer".
 * The title is normalised inline the same way normalizeTitle does (lowercased,
 * punctuation to spaces) and space-padded, then a bound phrase param is matched
 * as a padded LIKE, so the phrase only lands on word boundaries. normalizeTitle
 * leaves only [a-z0-9 ], so the phrase carries no LIKE wildcard and only the
 * outer % are wildcards; nothing but the clause STRUCTURE is generated. Bound
 * params start at `start`; the caller appends `params` in order. Empty (no
 * titles, or all blank) returns the always-true clause, so the board is unnarrowed.
 */
function titleKeepClause(titles: string[] | undefined, start: number): { clause: string; params: string[] } {
  const groups: string[] = [];
  const params: string[] = [];
  let n = start;
  for (const raw of titles ?? []) {
    const phrase = normalizeTitle(raw);
    if (!phrase) continue;
    params.push(phrase);
    groups.push(`(' ' || regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g') || ' ') LIKE ('% ' || $${n++} || ' %')`);
  }
  if (groups.length === 0) return { clause: 'TRUE', params: [] };
  return { clause: `(${groups.join(' OR ')})`, params };
}

/**
 * One page of the board under the reader's filters, with the count every
 * option would leave. Two queries, one shared CTE, every value bound.
 */
export async function listBoardFiltered(opts: BoardFilter): Promise<BoardFilteredResult> {
  const perPage = Math.max(1, Math.floor(opts.perPage) || 5);
  const page = Math.max(1, Math.floor(opts.page) || 1);
  const shared: unknown[] = [
    opts.sweepDate, FRESH_WINDOW_DAYS_SQL, likePattern(opts.q), opts.location, opts.comp, opts.freshness,
    opts.ageMin ?? null, opts.ageMax ?? null, opts.country ?? null, opts.liveOnly ?? false, opts.hasComp ?? false
  ];
  // The watched-titles narrowing binds after the 11 shared params ($12..), so
  // the LIMIT/OFFSET indices shift by however many title tokens there are.
  const { clause: titleClause, params: titleParams } = titleKeepClause(opts.titles, shared.length + 1);

  const { rows: countRows } = await db().query<Record<string, number>>(facetCountSql(titleClause), [...shared, ...titleParams]);
  const c = countRows[0] ?? {};
  const counts: FacetCounts = {
    total: c.total ?? 0,
    location: { all: c.location_all ?? 0, remote: c.location_remote ?? 0, onsite: c.location_onsite ?? 0 },
    comp: Object.fromEntries([...COMP_BAND_SQL.map((b) => b.key), 'not-listed', 'all'].map((k) => [k, c[`comp_${k}`] ?? 0])),
    freshness: { all: c.freshness_all ?? 0, fresh: c.freshness_fresh ?? 0, older: c.freshness_older ?? 0, unknown: c.freshness_unknown ?? 0 }
  };

  const order = BOARD_ORDER[opts.sort] ?? BOARD_ORDER.fit;
  const limIdx = shared.length + titleParams.length + 1;
  const offIdx = limIdx + 1;
  const { rows } = await db().query<BoardRow>(
    `${BOARD_FACET_CTE}
SELECT ${BOARD_ROW_OUT}
  FROM matched
 WHERE match_age AND match_q AND match_location AND match_comp AND match_freshness AND match_country AND match_live AND match_comp_present AND ${titleClause}
 ORDER BY ${order}
 LIMIT $${limIdx} OFFSET $${offIdx}`,
    [...shared, ...titleParams, perPage, (page - 1) * perPage]
  );
  return { rows, total: counts.total, counts };
}

/** The BoardRow columns read back out of the CTE (the same names, unprefixed). */
const BOARD_ROW_OUT = `id, slug, company, title, url, location, country, remote, published, ats,
  posting_id, department, comp_posted, comp_range, days_up, first_seen, last_seen,
  fit_total, fit_components, source, description, status, kill_id,
  kill_rule, kill_reason, killed_on, kill_first_published, kill_pipeline`;

/**
 * Every board row, full columns, no pagination and no facet counts: the
 * total-coverage read the Ledger uses to hold the whole crawl at once.
 * description is NULL::text so the heavy column never leaves the database in
 * bulk. liveOnly excludes killed rows (the default); pass false for everything.
 */
export async function listBoardAll(opts?: { liveOnly?: boolean }): Promise<BoardRow[]> {
  const where = opts && opts.liveOnly === false ? '' : "WHERE j.status <> 'killed'";
  const { rows } = await db().query<BoardRow>(
    `SELECT j.id, j.slug, j.company, j.title, j.url, j.location, j.country, j.remote, j.published, j.ats,
            j.posting_id, j.department, j.comp_posted, j.comp_range, j.days_up, j.first_seen, j.last_seen,
            j.fit_total, j.fit_components, j.source, NULL::text AS description, j.status, j.kill_id,
            ${KILL_COLUMNS}
       FROM jobs j LEFT JOIN board_kills k ON k.id = j.kill_id
       ${where}`
  );
  return rows;
}

/** One standing kill from board_kills, as the Ledger reads the whole archive. */
export interface BoardKillRow {
  company: string; title: string; ats: string | null; kill_rule: string;
  killed_on: Date | string | null; first_published: Date | string | null;
  times_fired: number; pipeline: string | null; slug: string | null; url: string;
  /** The evidence sentence the ingest wrote for this kill (board_kills.reason),
      e.g. the byte-for-byte repost comparison. Prefixed with the rule name. */
  reason: string | null;
}
/** Every standing kill on record (not vacated), across the whole crawl. */
export async function listAllKills(): Promise<BoardKillRow[]> {
  const { rows } = await db().query<BoardKillRow>(
    `SELECT company, title, ats, kill_rule, killed_on, first_published, times_fired, pipeline, slug, url, reason
       FROM board_kills WHERE vacated_at IS NULL`
  );
  return rows;
}

/** data.ts's FRESH_WINDOW_DAYS, restated as the SQL parameter. Imported rather
    than typed so the two cannot drift. */
import { FRESH_WINDOW_DAYS as FRESH_WINDOW_DAYS_SQL } from './data';

/**
 * The age plot's data, as a distribution the database computes rather than a
 * list of rows the page reads.
 *
 * WHAT THIS REPLACED, AND WHY. This was listBoardAges(): every row's dates,
 * deliberately unbounded, "because the plot is a claim about every row." It was
 * a claim about every row, but the page never needed every row to make it. The
 * plot is a histogram — how many roles sit at each age — and a histogram is a
 * GROUP BY. Measured on 2026-09-19 the old read pulled 13,302 rows / 4.8 MB out
 * of Postgres on every request to / and /board and grew with the crawl; this
 * returns ~one row per distinct age (549 on that day, 12 KB) and says exactly
 * the same thing. The rows themselves never leave the database.
 *
 * IT MIRRORS ageOf() (src/lib/data.ts), through the same columns boardRowToJob
 * maps: a killed row ages to its kill date, everything else to the sweep day;
 * the "from" date is the published date (or the kill's first-published date),
 * and only failing that the first-seen date, and only when first-seen is
 * strictly before the sweep day. A row with neither has no age and no mark.
 *
 * TWO SETS, ONE ROUND TRIP. The buckets are the title-bearing rows, the ones
 * that get a mark and a count. axisMax is the oldest age over EVERY measured
 * row, title or not, because the axis is drawn to the oldest thing on it. Both
 * come back from one statement: the bucket rows, then a final rollup row
 * (days IS NULL) carrying the axis max.
 */
const AGE_MEASURED_CTE = `
  WITH measured AS (
    SELECT
      j.title AS title,
      j.company AS company,
      j.published AS published_at,
      CASE
        WHEN COALESCE(j.published::date, k.first_published::date) IS NOT NULL
          THEN (CASE WHEN j.status = 'killed' THEN k.killed_on::date ELSE $1::date END)
               - COALESCE(j.published::date, k.first_published::date)
        WHEN j.first_seen::date < $1::date
          THEN (CASE WHEN j.status = 'killed' THEN k.killed_on::date ELSE $1::date END)
               - j.first_seen::date
        ELSE NULL
      END AS days
    FROM jobs j
    LEFT JOIN board_kills k ON k.id = j.kill_id
  )`;

interface AgeRow {
  days: number | null;
  rows: number;
  rep_company: string | null;
  rep_title: string | null;
  /** A timestamp column: node-postgres hands it back as a Date. */
  rep_published_at: Date | string | null;
  axis_max: number | null;
}

/** The published instant as the ISO string formatAgeLabel expects, or null. */
function instantString(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export async function listBoardAgeHistogram(sweepDate: string): Promise<AgeHistogram> {
  const { rows } = await db().query<AgeRow>(
    `${AGE_MEASURED_CTE}
     SELECT days,
            count(*)::int AS rows,
            (array_agg(company     ORDER BY published_at ASC NULLS LAST))[1] AS rep_company,
            (array_agg(title       ORDER BY published_at ASC NULLS LAST))[1] AS rep_title,
            (array_agg(published_at ORDER BY published_at ASC NULLS LAST))[1] AS rep_published_at,
            NULL::int AS axis_max
       FROM measured
      WHERE days IS NOT NULL AND title IS NOT NULL
      GROUP BY days
      UNION ALL
     SELECT NULL::int AS days, 0 AS rows, NULL, NULL, NULL,
            max(days) FILTER (WHERE days IS NOT NULL)::int AS axis_max
       FROM measured
      ORDER BY days ASC NULLS LAST`,
    [sweepDate]
  );

  let axisMax = 0;
  const byDay: AgeBucket[] = [];
  for (const row of rows) {
    if (row.days === null) {
      axisMax = row.axis_max ?? 0;
      continue;
    }
    byDay.push({
      days: row.days,
      rows: row.rows,
      repCompany: row.rep_company ?? '',
      repTitle: row.rep_title ?? '',
      repPublishedAt: instantString(row.rep_published_at)
    });
  }

  return { byDay, axisMax, total: byDay.reduce((sum, b) => sum + b.rows, 0) };
}

/**
 * One board row by its slug, or null. Backs /board/[slug].
 *
 * TWO LOOKUPS, ONE SHAPE. First the feed: the row with its kill of record
 * joined on. Then, when the feed has moved on, the record: a killed posting
 * whose row has left the crawl still has a page, because board_kills keeps the
 * slug it was tied to (job_slug is sticky, db/030). That fallback row carries
 * the kill's own company, title and URL, status 'killed', and no fit, which
 * boardRowToJob renders as the closed page and never as a live one.
 */
export async function getBoardJobBySlug(slug: string): Promise<BoardRow | null> {
  const { rows } = await db().query<BoardRow>(
    `SELECT ${BOARD_COLUMNS}, ${KILL_COLUMNS}
       FROM jobs j LEFT JOIN board_kills k ON k.id = j.kill_id
      WHERE j.slug = $1 LIMIT 1`,
    [slug]
  );
  if (rows[0]) return rows[0];
  const { rows: gone } = await db().query<BoardRow>(
    `SELECT k.job_id AS id, k.job_slug AS slug, k.company, k.title, k.url, NULL::text AS location,
            NULL::text AS country, false AS remote, NULL::timestamptz AS published, coalesce(k.ats, 'custom') AS ats,
            NULL::text AS posting_id, NULL::text AS department, NULL::text AS comp_posted, NULL::jsonb AS comp_range,
            NULL::integer AS days_up, k.first_published AS first_seen, k.last_fired_on AS last_seen,
            0 AS fit_total, NULL::jsonb AS fit_components, 'tracked' AS source, NULL::text AS description,
            'killed' AS status, k.id AS kill_id, ${KILL_COLUMNS}
       FROM board_kills k
      WHERE k.job_slug = $1 AND k.vacated_at IS NULL
      ORDER BY k.first_killed_at_utc ASC NULLS LAST LIMIT 1`,
    [slug]
  );
  return gone[0] ?? null;
}

export interface JobRow {
  id: string;
  company: string;
  title: string;
  url: string | null;
  location: string | null;
  country: string | null;
  remote: boolean;
  published: Date | string | null;
  ats: string;
  posting_id: string | null;
  department: string | null;
  comp_posted: string | null;
  days_up: number | null;
  ghost: boolean;
  first_seen: Date | string | null;
  last_seen: Date | string | null;
  description: string | null;
}

export interface JobListResult {
  jobs: JobRow[];
  total: number;
}

/**
 * One page of jobs, filtered by an optional free-text query and ordered
 * freshest-first. total is the full count for that filter, so the caller can
 * page. A blank query returns everything, paged.
 */
export async function listJobs(opts: { q?: string; page: number; perPage: number }): Promise<JobListResult> {
  const page = Math.max(1, Math.floor(opts.page) || 1);
  const perPage = Math.max(1, Math.floor(opts.perPage) || 25);
  const offset = (page - 1) * perPage;

  const params: unknown[] = [];
  let where = '';
  const q = (opts.q || '').trim();
  if (q) {
    params.push(`%${q}%`);
    where = `WHERE (title ILIKE $1 OR company ILIKE $1 OR location ILIKE $1 OR coalesce(department, '') ILIKE $1)`;
  }

  const { rows: countRows } = await db().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs ${where}`,
    params
  );
  const total = countRows[0]?.n ?? 0;

  const listParams = [...params, perPage, offset];
  const limitIndex = listParams.length - 1;
  const offsetIndex = listParams.length;
  const { rows } = await db().query<JobRow>(
    `SELECT id, company, title, url, location, country, remote, published, ats,
            posting_id, department, comp_posted, days_up, ghost, first_seen, last_seen
       FROM jobs ${where}
      ORDER BY last_seen DESC NULLS LAST, company ASC, title ASC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    listParams
  );

  return { jobs: rows, total };
}

/** A single job by its stable id, or null. For the SSR detail route. */
export async function getJob(id: string): Promise<JobRow | null> {
  const { rows } = await db().query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Upsert a batch of jobs on the id primary key: re-ingesting the same posting
 * updates it in place rather than duplicating. The mini's tracker is the caller
 * in production; kept here so the table's write shape has one owner.
 */
export async function upsertJobs(jobs: JobRow[]): Promise<number> {
  if (jobs.length === 0) return 0;
  const client = db();
  let written = 0;
  for (const j of jobs) {
    await client.query(
      `INSERT INTO jobs (id, company, title, url, location, country, remote, published,
                         ats, posting_id, department, comp_posted, days_up, ghost,
                         first_seen, last_seen, description, ingested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
       ON CONFLICT (id) DO UPDATE SET
         company=$2, title=$3, url=$4, location=$5, country=$6, remote=$7, published=$8,
         ats=$9, posting_id=$10, department=$11, comp_posted=$12, days_up=$13, ghost=$14,
         first_seen=$15, last_seen=$16, description=$17, ingested_at=now()`,
      [
        j.id, j.company, j.title, j.url, j.location, j.country, Boolean(j.remote), j.published,
        j.ats, j.posting_id, j.department, j.comp_posted, j.days_up, Boolean(j.ghost),
        j.first_seen, j.last_seen, j.description ?? null
      ]
    );
    written += 1;
  }
  return written;
}
