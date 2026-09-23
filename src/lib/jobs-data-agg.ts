/**
 * jobs-data-agg.ts: every number on the Jobs Data page, computed in the
 * database.
 *
 * WHAT THIS REPLACED, AND WHY. The page used to embed the whole live board in
 * its own HTML as a JSON script tag, and the browser filtered that array and
 * reduced it into every chart. At 31,310 live rows that payload reached 12.0 MB
 * and the page stopped rendering at all. The charts never needed the rows: a
 * box plot is five percentiles, a bar chart is a GROUP BY, a heat map is a
 * crosstab. So the rows stay in Postgres and only the numbers travel.
 *
 * NO ROWS LEAVE. Nothing this module returns is a posting. Every field is a
 * count, a sum, an average, a percentile or a grouping key. The one list that
 * is per-something is the issuer table, which is per COMPANY, an aggregate of
 * that company's postings, exactly as the page has always drawn it.
 *
 * ONE SCAN FOR THE WHOLE PAGE. The facet counts under each filter button ("how
 * many rows would remain if I pressed this instead") used to be nine separate
 * passes over the array. Here every row is marked once with nine booleans, one
 * per filter dimension, each meaning "passes every filter EXCEPT this one".
 * Then the cut is the rows passing all nine, and the count under a button is a
 * FILTER over the mark for its dimension. One pass answers the cut and all
 * twenty eight facet counts together.
 *
 * ONE DEFINITION. Seniority, family, region, apply friction and posted pay are
 * columns, written at ingest by src/lib/jobs-derived.mjs. This file never
 * re-derives one. That is what makes them indexable, and it is why a rule
 * change is a code change plus a backfill rather than a change here too.
 *
 * PERCENTILES MATCH THE OLD ARITHMETIC EXACTLY. The browser's med(a) and
 * quant(a, p) were linear interpolation between the two neighbouring sorted
 * values, then Math.round. That is round(percentile_cont(p)), and med(a) is
 * quant(a, 0.5) for every length, odd and even alike. Verified against the old
 * implementation in jobs-data-agg.test.mjs.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */

import { db } from './db';
import { GROUP_DEFS, type Filters } from './jobs-data-filters';

/** The pay axis the page draws, in thousands. Fixed, so the axis does not
    move under the reader between two cuts. */
export const PAY_LO = 110;
export const PAY_HI = 360;
/** The longest standing time the kill-life axis draws, in days. */
export const LIFE_HI = 44;
/** Seniority, in ladder order. */
export const LADDER = ['Senior', 'Staff', 'Lead', 'Director'] as const;
/** The published kill rules, in the order the archive views draw them. */
export const RULE_KEYS = [
  'repost_churn', 'touched_not_refreshed', 'misrepresented', 'zombie', 'phantom'
] as const;
export const RULE_LABELS: Record<string, string> = {
  repost_churn: 'repost churn',
  touched_not_refreshed: 'touched, not refreshed',
  misrepresented: 'misrepresented remote',
  zombie: 'zombie, past close date',
  phantom: 'phantom, link 404s'
};

/** Five numbers and two counts: everything a box plot draws. */
export interface Box {
  label: string;
  n: number;
  priced: number;
  lo: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  hi: number | null;
}

export interface IssuerAgg {
  co: string;
  alias: string;
  ats: string;
  live: number;
  med: number | null;
  remotePct: number | null;
  kills: number;
  reposts: number;
  maxFired: number;
}

export interface Aggregates {
  cutN: number;
  pricedN: number;
  unpricedN: number;
  ladder: Box[];
  place: Box[];
  /** Posted midpoint against fit, as a count per (pay bin, fit) cell. The page
      used to plot a 500 row sample of individual postings here, which named a
      company and a title per point; a density grid says the same thing about
      the distribution and carries no posting. */
  density: { x: number; fit: number; n: number }[];
  fitLo: number | null;
  fitHi: number | null;
  midMed: number | null;
  fitMed: number | null;
  quadN: number;
  bandCounts: number[];
  bandN: number;
  bandMed: number | null;
  drag: { key: string; avg: number; zeros: number }[];
  issuers: IssuerAgg[];
  ageCounts: number[];
  in48: number;
  in96: number;
  past14: number;
  geo: { region: string; n: number; remote: number }[];
  facets: Record<string, Record<string, number>>;
}

export interface KillAggregates {
  killCutN: number;
  archiveTotal: number;
  atsCols: string[];
  heat: Record<string, Record<string, number>>;
  life: Box[];
  churnCounts: number[];
  firedMax: number;
  customKills: number;
}

// ---------------------------------------------------------------------------
// Predicate building. Every value is a bound parameter; nothing is spliced.
// ---------------------------------------------------------------------------

class Binder {
  readonly values: unknown[] = [];
  /** Bind one value and return its placeholder. */
  p(v: unknown): string {
    this.values.push(v);
    return '$' + this.values.length;
  }
}

/** The nine filter dimensions, in the order the page draws their buttons. */
const DIMENSIONS = ['watch', 'where', 'floor', 'priced', 'age', 'level', 'ats', 'friction', 'record'] as const;
type Dimension = (typeof DIMENSIONS)[number];

/**
 * One SQL boolean per dimension: "this row satisfies that filter". A dimension
 * set to its any value is the constant true, which Postgres folds away.
 *
 * Each clause is written to mean exactly what the browser's passes() meant,
 * including where it was permissive:
 *
 *   floor  keeps every row that printed NO range, because an absent range is
 *          not a number below a reader's floor. Only a priced row can fail.
 *   age    keeps every row with no age for the same reason.
 *   level  drops a row whose title prints no seniority, because "Senior" is a
 *          claim and an unlabelled title does not make it.
 */
function marks(f: Filters, b: Binder): Record<Dimension, string> {
  const m = {} as Record<Dimension, string>;

  if (f.watches.length === 0) {
    m.watch = 'TRUE';
  } else {
    const parts = f.watches.map((w) => {
      const def = GROUP_DEFS.find((g) => g.title === w.title);
      if (!def) return 'FALSE';
      const tests: string[] = [`j.derived_tier = ANY(${b.p(def.tiers.slice())})`];
      if (def.fam !== null) tests.push(`j.derived_fam = ${b.p(def.fam)}`);
      if (w.off.length) tests.push(`NOT (j.title = ANY(${b.p(w.off)}))`);
      return '(' + tests.join(' AND ') + ')';
    });
    m.watch = '(' + parts.join(' OR ') + ')';
  }

  m.where = f.where === 'remote only' ? 'j.remote'
    : f.where === 'in office' ? 'NOT j.remote'
    : 'TRUE';

  m.floor = f.floor ? `NOT (j.priced AND j.comp_min_k < ${b.p(f.floor)})` : 'TRUE';

  m.priced = f.priced === 'priced' ? 'j.priced'
    : f.priced === 'unpriced' ? 'NOT j.priced'
    : 'TRUE';

  m.age = f.age ? `(j.days_up IS NULL OR j.days_up <= ${b.p(f.age)})` : 'TRUE';

  m.level = f.level === 'any' ? 'TRUE' : `j.derived_tier = ${b.p(f.level)}`;

  m.ats = f.ats === 'any' ? 'TRUE' : `j.ats = ${b.p(f.ats)}`;

  m.friction = f.friction === 'any' ? 'TRUE' : `j.derived_friction = ${b.p(f.friction)}`;

  m.record = f.record === 'clean' ? 'COALESCE(ck.n, 0) = 0'
    : f.record === 'lowchurn' ? 'COALESCE(ck.max_fired, 0) < 10'
    : 'TRUE';

  return m;
}

/** "passes every dimension except this one", as one SQL boolean. */
function passExcept(m: Record<Dimension, string>, skip: Dimension | null): string {
  const parts = DIMENSIONS.filter((d) => d !== skip).map((d) => m[d]);
  const live = parts.filter((p) => p !== 'TRUE');
  return live.length ? live.join(' AND ') : 'TRUE';
}

// The five fit components, and the weight each can earn. Weights are the
// page's, unchanged; they set the "percent of available" each bar draws to.
const DRAG_KEYS = ['title_scope', 'remote_geo', 'comp', 'freshness', 'apply_friction'] as const;

/**
 * round(percentile_cont(p)) over a column, which is the browser's quant().
 *
 * The FILTER belongs to the aggregate and the cast belongs outside it, in that
 * order and with those parentheses. Written the other way round Postgres reads
 * the cast as part of the filter condition and refuses the statement.
 */
const pct = (p: number, col: string, filter?: string) =>
  `round((percentile_cont(${p}) WITHIN GROUP (ORDER BY ${col})` +
  (filter ? ` FILTER (WHERE ${filter})` : '') +
  `)::numeric)::int`;

/**
 * The box for one subset of rows, as a SQL select list.
 *
 * `where` picks the subset; `valued` says which of those rows carry a number
 * to plot. On the live board that is a printed pay range; in the archive it is
 * a kill with both a first-published and a killed-on date. The counts are kept
 * apart on purpose: "n 40, priced 6" is the honest label, and collapsing them
 * would print a box drawn from six rows as if it described forty.
 */
function boxSelect(where: string, col = 'comp_mid_k', valued = 'priced'): string {
  const has = `${where} AND (${valued})`;
  return `json_build_object(
    'n',      count(*) FILTER (WHERE ${where})::int,
    'priced', count(*) FILTER (WHERE ${has})::int,
    'lo',     min(${col}) FILTER (WHERE ${has})::int,
    'hi',     max(${col}) FILTER (WHERE ${has})::int,
    'p25',    ${pct(0.25, col, has)},
    'p50',    ${pct(0.5, col, has)},
    'p75',    ${pct(0.75, col, has)}
  )`;
}

// ---------------------------------------------------------------------------
// The live aggregate.
// ---------------------------------------------------------------------------

/**
 * Every number the live views draw, for one filter combination, in one
 * statement and one scan.
 */
export async function liveAggregates(f: Filters): Promise<Aggregates> {
  const b = new Binder();
  const m = marks(f, b);
  const pass = passExcept(m, null);

  // One marked row set. The nine except-masks ride along so the facet counts
  // come out of the same scan as the cut.
  const exceptCols = DIMENSIONS.map((d) => `(${passExcept(m, d)}) AS x_${d}`).join(',\n           ');

  const ageDefs: [number, number][] = [[0, 1], [2, 2], [3, 4], [5, 7], [8, 14], [15, 30], [31, 90], [91, 9999]];
  const bandDefs: [number, number][] = [[0, 0.15], [0.15, 0.25], [0.25, 0.35], [0.35, 0.45], [0.45, 99]];
  const band = '((comp_max_k - comp_min_k)::numeric / NULLIF(comp_min_k, 0))';

  const sql = `
WITH co_kills AS (
  SELECT company,
         count(*)::int AS n,
         count(*) FILTER (WHERE kill_rule = 'repost_churn')::int AS reposts,
         COALESCE(max(times_fired), 0)::int AS max_fired
    FROM board_kills
   WHERE vacated_at IS NULL
   GROUP BY company
),
marked AS (
  SELECT j.company, j.title, j.ats, j.remote, j.priced,
         j.comp_min_k, j.comp_max_k, j.comp_mid_k, j.days_up,
         j.derived_tier AS tier, j.derived_region AS region,
         COALESCE(j.fit_total, 0)::int AS fit,
         j.fit_components,
         COALESCE(ck.n, 0)::int AS co_kills,
         COALESCE(ck.reposts, 0)::int AS co_reposts,
         COALESCE(ck.max_fired, 0)::int AS co_max_fired,
         (${pass}) AS pass,
         ${exceptCols}
    FROM jobs j
    LEFT JOIN co_kills ck ON ck.company = j.company
   WHERE j.status <> 'killed'
),
cut AS (SELECT * FROM marked WHERE pass),

head AS (
  SELECT count(*)::int AS cut_n,
         count(*) FILTER (WHERE priced)::int AS priced_n,
         min(fit)::int AS fit_lo,
         max(fit)::int AS fit_hi,
         ${pct(0.5, 'comp_mid_k', 'priced')} AS mid_med,
         ${pct(0.5, 'fit')} AS fit_med
    FROM cut
),
ladder AS (
  SELECT json_build_object(
    ${LADDER.map((t) => `'${t}', ${boxSelect(`tier = '${t}'`)}`).join(',\n    ')}
  ) AS v FROM cut
),
place AS (
  SELECT json_build_object(
    'remote', ${boxSelect('remote')},
    'office', ${boxSelect('NOT remote')}
  ) AS v FROM cut
),
density AS (
  SELECT COALESCE(json_agg(json_build_object('x', x, 'fit', fit, 'n', n)), '[]'::json) AS v
    FROM (
      SELECT width_bucket(
               least(greatest(((comp_mid_k - ${PAY_LO})::numeric / ${PAY_HI - PAY_LO}) * 100, 0), 100),
               0, 100, 48)::int AS x,
             fit,
             count(*)::int AS n
        FROM cut WHERE priced
       GROUP BY 1, 2
    ) d
),
quad AS (
  SELECT count(*)::int AS n FROM cut, head
   WHERE cut.priced AND cut.fit >= head.fit_med AND cut.comp_mid_k >= head.mid_med
),
bands AS (
  SELECT json_build_object(
    'counts', json_build_array(${bandDefs
      .map(([lo, hi]) => `count(*) FILTER (WHERE priced AND ${band} >= ${lo} AND ${band} < ${hi})::int`)
      .join(', ')}),
    'n', count(*) FILTER (WHERE priced)::int,
    'med', ${pct(0.5, `round(${band} * 1000)`, 'priced')}
  ) AS v FROM cut
),
drag AS (
  SELECT json_build_object(
    ${DRAG_KEYS.map(
      (k) => `'${k}', json_build_object(
      'avg',   COALESCE(avg(COALESCE((fit_components->>'${k}')::numeric, 0)), 0),
      'zeros', count(*) FILTER (WHERE COALESCE((fit_components->>'${k}')::numeric, 0) = 0)::int)`
    ).join(',\n    ')}
  ) AS v FROM cut
),
issuers AS (
  SELECT COALESCE(json_agg(json_build_object(
           'co', co, 'ats', ats, 'live', live, 'med', med,
           'remotePct', remote_pct, 'kills', kills, 'reposts', reposts, 'maxFired', max_fired)), '[]'::json) AS v
    FROM (
      SELECT COALESCE(c.company, k.company) AS co,
             COALESCE(c.ats, '') AS ats,
             COALESCE(c.live, 0) AS live,
             c.med AS med,
             c.remote_pct AS remote_pct,
             COALESCE(k.n, 0) AS kills,
             COALESCE(k.reposts, 0) AS reposts,
             COALESCE(k.max_fired, 0) AS max_fired
        FROM (
          SELECT company,
                 (array_agg(ats ORDER BY ats))[1] AS ats,
                 count(*)::int AS live,
                 ${pct(0.5, 'comp_mid_k', 'priced')} AS med,
                 round((count(*) FILTER (WHERE remote))::numeric * 100 / count(*))::int AS remote_pct
            FROM cut GROUP BY company
        ) c
        FULL OUTER JOIN co_kills k ON k.company = c.company
    ) t
),
ages AS (
  SELECT json_build_object(
    'counts', json_build_array(${ageDefs
      .map(([lo, hi]) => `count(*) FILTER (WHERE days_up IS NOT NULL AND days_up >= ${lo} AND days_up <= ${hi})::int`)
      .join(', ')}),
    'in48',   count(*) FILTER (WHERE days_up IS NOT NULL AND days_up <= 2)::int,
    'in96',   count(*) FILTER (WHERE days_up IS NOT NULL AND days_up <= 4)::int,
    'past14', count(*) FILTER (WHERE days_up IS NOT NULL AND days_up > 14)::int
  ) AS v FROM cut
),
geo AS (
  SELECT COALESCE(json_agg(json_build_object('region', region, 'n', n, 'remote', rem)
                           ORDER BY n DESC, region), '[]'::json) AS v
    FROM (SELECT region, count(*)::int AS n, count(*) FILTER (WHERE remote)::int AS rem
            FROM cut GROUP BY region) g
),
facets AS (
  SELECT json_build_object(
    'where', json_build_object(
      'anywhere',    count(*) FILTER (WHERE x_where)::int,
      'remote only', count(*) FILTER (WHERE x_where AND remote)::int,
      'in office',   count(*) FILTER (WHERE x_where AND NOT remote)::int),
    'priced', json_build_object(
      'any',      count(*) FILTER (WHERE x_priced)::int,
      'priced',   count(*) FILTER (WHERE x_priced AND priced)::int,
      'unpriced', count(*) FILTER (WHERE x_priced AND NOT priced)::int),
    'age', json_build_object(
      '0', count(*) FILTER (WHERE x_age)::int,
      ${[2, 4, 7, 14].map((d) => `'${d}', count(*) FILTER (WHERE x_age AND (days_up IS NULL OR days_up <= ${d}))::int`).join(',\n      ')}),
    'level', json_build_object(
      'any', count(*) FILTER (WHERE x_level)::int,
      ${LADDER.map((t) => `'${t}', count(*) FILTER (WHERE x_level AND tier = '${t}')::int`).join(',\n      ')}),
    'floor', json_build_object(
      '0', count(*) FILTER (WHERE x_floor)::int,
      ${[150, 200, 250, 300].map((v) => `'${v}', count(*) FILTER (WHERE x_floor AND NOT (priced AND comp_min_k < ${v}))::int`).join(',\n      ')}),
    'friction', json_build_object(
      'any',  count(*) FILTER (WHERE x_friction)::int,
      'easy', count(*) FILTER (WHERE x_friction AND ats <> ALL($WALL)) ::int,
      'hard', count(*) FILTER (WHERE x_friction AND ats = ANY($WALL))::int),
    'record', json_build_object(
      'any',      count(*) FILTER (WHERE x_record)::int,
      'clean',    count(*) FILTER (WHERE x_record AND co_kills = 0)::int,
      'lowchurn', count(*) FILTER (WHERE x_record AND co_max_fired < 10)::int),
    'ats', (SELECT COALESCE(json_object_agg(ats, n), '{}'::json)
              FROM (SELECT ats, count(*)::int AS n FROM marked WHERE x_ats GROUP BY ats) a),
    'atsAny', count(*) FILTER (WHERE x_ats)::int
  ) AS v FROM marked
)
SELECT (SELECT row_to_json(head) FROM head)         AS head,
       (SELECT v FROM ladder)                        AS ladder,
       (SELECT v FROM place)                         AS place,
       (SELECT v FROM density)                       AS density,
       (SELECT n FROM quad)                          AS quad_n,
       (SELECT v FROM bands)                         AS bands,
       (SELECT v FROM drag)                          AS drag,
       (SELECT v FROM issuers)                       AS issuers,
       (SELECT v FROM ages)                          AS ages,
       (SELECT v FROM geo)                           AS geo,
       (SELECT v FROM facets)                        AS facets`;

  // The friction facet needs the walled list as a bound array, and it appears
  // after every other parameter has been bound, so it is substituted here by
  // name rather than by position.
  const wallParam = b.p(ACCOUNT_WALLED);
  const finalSql = sql.split('$WALL').join(wallParam);

  const { rows } = await db().query(finalSql, b.values);
  return shape(rows[0]);
}

// Imported as a value rather than re-listed, so the facet count and the stored
// column can never disagree about which systems are walled.
import { ACCOUNT_WALLED_ATS } from './jobs-derived.mjs';
const ACCOUNT_WALLED = ACCOUNT_WALLED_ATS.slice();

function box(label: string, v: Record<string, number | null>): Box {
  return {
    label,
    n: Number(v.n ?? 0),
    priced: Number(v.priced ?? 0),
    lo: v.lo ?? null, p25: v.p25 ?? null, p50: v.p50 ?? null,
    p75: v.p75 ?? null, hi: v.hi ?? null
  };
}

function shape(r: Record<string, any>): Aggregates {
  const head = r.head || {};
  const bands = r.bands || {};
  const ages = r.ages || {};
  const facets: Record<string, Record<string, number>> = r.facets || {};
  // The applicant-system facet arrives as its own object plus a separate "any";
  // fold them together so every dimension has the same shape on the wire.
  const atsFacet: Record<string, number> = { any: Number(facets.atsAny ?? 0), ...(facets.ats as any || {}) };
  delete (facets as any).atsAny;
  facets.ats = atsFacet;

  return {
    cutN: Number(head.cut_n ?? 0),
    pricedN: Number(head.priced_n ?? 0),
    unpricedN: Number(head.cut_n ?? 0) - Number(head.priced_n ?? 0),
    ladder: LADDER.map((t) => box(t, (r.ladder || {})[t] || {})),
    place: [box('Remote', (r.place || {}).remote || {}), box('In office', (r.place || {}).office || {})],
    density: r.density || [],
    fitLo: head.fit_lo ?? null,
    fitHi: head.fit_hi ?? null,
    midMed: head.mid_med ?? null,
    fitMed: head.fit_med ?? null,
    quadN: Number(r.quad_n ?? 0),
    bandCounts: bands.counts || [0, 0, 0, 0, 0],
    bandN: Number(bands.n ?? 0),
    // The page prints the band as a percentage to one decimal, which the
    // browser reached by taking the median of the band times a thousand and
    // dividing by ten. Same two steps, same rounding.
    bandMed: bands.med === null || bands.med === undefined ? null : Math.round(Number(bands.med) / 10),
    drag: DRAG_KEYS.map((k) => {
      const d = (r.drag || {})[k] || {};
      return { key: k, avg: Math.round(Number(d.avg ?? 0) * 10) / 10, zeros: Number(d.zeros ?? 0) };
    }),
    issuers: rankIssuers(r.issuers || []),
    ageCounts: ages.counts || [0, 0, 0, 0, 0, 0, 0, 0],
    in48: Number(ages.in48 ?? 0),
    in96: Number(ages.in96 ?? 0),
    past14: Number(ages.past14 ?? 0),
    geo: r.geo || [],
    facets
  };
}

/**
 * The stable issuer alias, and the page's own filter on the table.
 *
 * ALIAS ORDER IS COMPUTED HERE, NOT IN SQL. It is kills descending, ties broken
 * by company name through String.localeCompare, and Postgres's collation does
 * not order strings the way the browser's comparator does once case and accents
 * are in play. Ranking a few hundred names in JavaScript costs nothing and
 * keeps "source A" pointing at the same issuer it always did.
 */
function rankIssuers(rows: any[]): IssuerAgg[] {
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const ranked = rows
    .slice()
    .sort((a, b) => (b.kills || 0) - (a.kills || 0) || String(a.co).localeCompare(String(b.co)));
  const aliasOf = new Map<string, string>();
  ranked.forEach((c, i) => aliasOf.set(c.co, 'source ' + (i < 26 ? LETTERS[i] : String(i + 1))));
  return rows
    .filter((r) => (r.live || 0) > 0 || (r.kills || 0) > 0)
    .map((r) => ({
      co: r.co,
      alias: aliasOf.get(r.co) || 'source ?',
      ats: r.ats || '',
      live: Number(r.live || 0),
      med: r.med ?? null,
      remotePct: r.remotePct ?? null,
      kills: Number(r.kills || 0),
      reposts: Number(r.reposts || 0),
      maxFired: Number(r.maxFired || 0)
    }));
}

// ---------------------------------------------------------------------------
// The archive aggregate.
// ---------------------------------------------------------------------------

/**
 * The kill views' numbers. A separate statement because it reads a different
 * table and its cut is a different predicate: the archive follows the watched
 * families and the seniority filter, and nothing else on the page.
 *
 * `fams` and `tiers` are the families and seniorities the watched groups match
 * ACROSS THE WHOLE BOARD, not within the current cut. That is what the browser
 * did, and it is the right reading: the archive is being narrowed to the kinds
 * of role the reader watches, not to the rows that survived their pay floor.
 */
export async function killAggregates(
  f: Filters,
  watchedFams: string[],
  watchedTiers: string[]
): Promise<KillAggregates> {
  const b = new Binder();
  const parts = ["vacated_at IS NULL"];
  const cutParts = ['TRUE'];
  if (f.watches.length > 0) {
    // A kill carries no measured department under crawl coverage, so this is
    // NULL for every archive row and the archive empties whenever a title is
    // watched. That is the existing behaviour, reproduced rather than papered
    // over: the fix is a department on the archive, not a looser test here.
    cutParts.push(`derived_fam_placeholder = ANY(${b.p(watchedFams)})`);
    cutParts.push(`derived_tier = ANY(${b.p(watchedTiers)})`);
  }
  if (f.level !== 'any') cutParts.push(`derived_tier = ${b.p(f.level)}`);
  const cut = cutParts.join(' AND ').split('derived_fam_placeholder').join('NULL::text');

  const churnDefs: [number, number][] = [[1, 1], [2, 2], [3, 3], [4, 5], [6, 9], [10, 15], [16, 28]];
  const lifeDays = "(killed_on::date - first_published::date)";

  const sql = `
WITH standing AS (
  SELECT company, title, COALESCE(ats, '') AS ats, kill_rule, times_fired,
         derived_tier, killed_on, first_published,
         CASE WHEN killed_on IS NOT NULL AND first_published IS NOT NULL
              THEN ${lifeDays} END AS life,
         (${cut}) AS pass
    FROM board_kills
   WHERE ${parts.join(' AND ')}
),
cut AS (SELECT * FROM standing WHERE pass)
SELECT (SELECT count(*)::int FROM cut)      AS cut_n,
       (SELECT count(*)::int FROM standing) AS archive_total,
       (SELECT count(*) FILTER (WHERE ats = '')::int FROM cut) AS custom_kills,
       (SELECT COALESCE(max(times_fired), 0)::int FROM cut)    AS fired_max,
       (SELECT COALESCE(json_agg(json_build_object('ats', ats, 'n', n) ORDER BY n DESC, ats), '[]'::json)
          FROM (SELECT ats, count(*)::int AS n FROM standing GROUP BY ats) a) AS ats_cols,
       (SELECT COALESCE(json_agg(json_build_object('rule', kill_rule, 'ats', ats, 'n', n)), '[]'::json)
          FROM (SELECT kill_rule, ats, count(*)::int AS n FROM cut GROUP BY 1, 2) h) AS heat,
       (SELECT json_build_object(${RULE_KEYS.slice(0, 3)
         .map((rule) => `'${rule}', ${boxSelect(`kill_rule = '${rule}'`, 'life', 'life IS NOT NULL')}`)
         .join(', ')}) FROM cut) AS life,
       (SELECT json_build_array(${churnDefs
         .map(([lo, hi]) => `count(*) FILTER (WHERE times_fired >= ${lo} AND times_fired <= ${hi})::int`)
         .join(', ')}) FROM cut) AS churn`;

  const { rows } = await db().query(sql, b.values);
  const r = rows[0] || {};

  const heat: Record<string, Record<string, number>> = {};
  for (const rule of RULE_KEYS) heat[rule] = {};
  for (const cell of (r.heat || [])) {
    (heat[cell.rule] || (heat[cell.rule] = {}))[cell.ats] = cell.n;
  }

  return {
    killCutN: Number(r.cut_n ?? 0),
    archiveTotal: Number(r.archive_total ?? 0),
    atsCols: (r.ats_cols || []).map((a: any) => a.ats),
    heat,
    life: RULE_KEYS.slice(0, 3).map((rule) => box(RULE_LABELS[rule], (r.life || {})[rule] || {})),
    churnCounts: r.churn || [0, 0, 0, 0, 0, 0, 0],
    firedMax: Number(r.fired_max ?? 0),
    customKills: Number(r.custom_kills ?? 0)
  };
}

// ---------------------------------------------------------------------------
// The board-wide facts, which no filter moves.
// ---------------------------------------------------------------------------

export interface BoardFacts {
  liveN: number;
  /** Live rows on the whole board that printed a pay range. The method note
      reports how many did NOT, which is this subtracted from liveN. */
  pricedN: number;
  /** Share of the whole live board carrying no recognised applicant system. */
  customLivePct: number;
  /** Rows the page offers as applicant-system buttons, commonest first. */
  atsOptions: { key: string; n: number }[];
  /** Every watched group, with the distinct titles it matches board wide. */
  titleIndex: { title: string; n: number; variants: [string, number][]; fams: string[]; tiers: string[] }[];
}

/**
 * The numbers that describe the whole board rather than a cut: how many rows
 * there are, which applicant systems exist to filter by, and what each watched
 * title group matches. None of these move when a filter changes, so the page
 * reads them once per crawl and the filtered endpoint never recomputes them.
 */
export async function boardFacts(): Promise<BoardFacts> {
  const groupCase = GROUP_DEFS.map((g) => {
    const tests = [`derived_tier = ANY(ARRAY[${g.tiers.map((t) => `'${t}'`).join(',')}])`];
    if (g.fam !== null) tests.push(`derived_fam = '${g.fam}'`);
    return `WHEN ${tests.join(' AND ')} THEN '${g.title}'`;
  }).join('\n         ');

  const { rows } = await db().query(`
WITH live AS (SELECT * FROM jobs WHERE status <> 'killed'),
grouped AS (
  SELECT CASE ${groupCase} END AS grp, title, derived_fam AS fam, derived_tier AS tier
    FROM live
)
SELECT (SELECT count(*)::int FROM live) AS live_n,
       (SELECT count(*) FILTER (WHERE priced)::int FROM live) AS priced_n,
       (SELECT count(*) FILTER (WHERE ats IS NULL OR ats = '')::int FROM live) AS custom_n,
       (SELECT COALESCE(json_agg(json_build_object('key', ats, 'n', n) ORDER BY n DESC, ats), '[]'::json)
          FROM (SELECT ats, count(*)::int AS n FROM live GROUP BY ats) a) AS ats_options,
       (SELECT COALESCE(json_agg(json_build_object('grp', grp, 'title', title, 'n', n, 'fam', fam, 'tier', tier)), '[]'::json)
          FROM (SELECT grp, title, fam, tier, count(*)::int AS n
                  FROM grouped WHERE grp IS NOT NULL GROUP BY 1, 2, 3, 4) g) AS group_rows`);

  const r = rows[0] || {};
  const liveN = Number(r.live_n ?? 0);
  const byGroup = new Map<string, any[]>();
  for (const g of (r.group_rows || [])) {
    if (!byGroup.has(g.grp)) byGroup.set(g.grp, []);
    byGroup.get(g.grp)!.push(g);
  }

  return {
    liveN,
    pricedN: Number(r.priced_n ?? 0),
    customLivePct: liveN ? Math.round((Number(r.custom_n ?? 0) / liveN) * 100) : 0,
    atsOptions: r.ats_options || [],
    titleIndex: GROUP_DEFS.map((def) => {
      const rows2 = byGroup.get(def.title) || [];
      const counts = new Map<string, number>();
      const fams = new Set<string>();
      const tiers = new Set<string>();
      let n = 0;
      for (const g of rows2) {
        counts.set(g.title, (counts.get(g.title) || 0) + g.n);
        if (g.fam) fams.add(g.fam);
        if (g.tier) tiers.add(g.tier);
        n += g.n;
      }
      const variants = [...counts.entries()].sort((a, b) => b[1] - a[1]) as [string, number][];
      return { title: def.title, n, variants, fams: [...fams], tiers: [...tiers] };
    })
  };
}
