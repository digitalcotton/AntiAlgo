/**
 * desk-agg.ts: the Desk's reads, computed in the database.
 *
 * WHAT THIS REPLACED, AND WHY. buildDeskHome called listBoardAll({ liveOnly:
 * true }) and cut the result in TypeScript. That read has no WHERE beyond
 * "status <> 'killed'" and no LIMIT: measured on production 2026-09-23 it
 * returned 31,310 rows / 27.05 MB in about 970 ms, on every request to /desk
 * and /start, and it grew with every crawl (live rows went from roughly 2,000
 * to 31,310 during the September ATS expansion). The page never broke the way
 * /jobs-data did, because it reduced the rows server-side instead of shipping
 * them to the browser, but it paid the full egress and compute for a page that
 * draws at most twelve roles and a dropdown.
 *
 * It is the same defect and the same fix as cfd7277 ("Jobs Data: the numbers,
 * not the rows"): push the cut into SQL and return only what the page draws.
 * The Desk's cut is the member's watched titles, so the queries here are keyed
 * on those titles rather than taken over the whole board.
 *
 * WHAT LEAVES THE DATABASE NOW. At most DESK_SHOW rows per lane (twelve rows of
 * full columns), one row of five counts, one row of three counts per watched
 * title, and the head of the title index. Nothing here reads a posting the page
 * does not draw.
 *
 * THE MATCHER IS THE SAME MATCHER. Every title test below is the SQL mirror of
 * ledger-titles.matchesTitle, byte for byte the clause job-store.ts's
 * titleKeepClause already uses for the board's own narrowing: the role title is
 * lowercased, its punctuation turned to spaces and the whole thing space-padded,
 * then a normalised phrase is matched as a padded LIKE, so a watch only lands on
 * whole adjacent words. normalizeTitle leaves only [a-z0-9 ], so a phrase
 * carries no LIKE wildcard of its own. The watches travel as ARRAY parameters,
 * so nothing here builds SQL from a value; the statements are constants.
 *
 * ONE DETERMINISTIC ORDER. The old ranking was fit DESC then first_seen DESC,
 * and Array.prototype.sort is stable, so rows tied on both kept whatever
 * arbitrary order the sequential scan happened to return: the sixth card on a
 * lane could differ between two renders of the same board. The ORDER BY here
 * ends in id ASC, so a tie resolves the same way every time, the way
 * job-store.ts's BOARD_ORDER already does. That is the one intended difference
 * from the old reduction, and desk-agg.test.ts asserts it as a difference.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */
import { db } from './db';
import { BOARD_LIST_COLUMNS, KILL_COLUMNS } from './job-store';
import type { BoardRow } from './board-jobs';
import { normalizeTitle, type TitleCount } from './ledger-titles';
import type { Shelf } from './ledger-watch-store';
import type { LedgerSelection } from './ledger-prefs-store';

/** One watched title as the queries here need it: the raw title the member
    typed (what the page prints back in "matched X") and its shelf. */
export interface DeskWatch {
  title: string;
  shelf: Shelf;
}

/** The clock and the windows the lane reads against, all passed in so nothing
    here has a clock of its own. */
export interface DeskWhen {
  /** The sweep's calendar day (data.ts sweepDate()), the "to" end of every age. */
  sweepDate: string;
  /** The reader's last visit as an ISO calendar day, or null on a first visit.
      Date granularity on purpose; see desk-home.ts isNew. */
  lastSeenDay: string | null;
  /** Lane membership: a role first seen this many days ago at most. */
  windowDays: number;
  /** On a first visit (no lastSeenDay), "new" falls back to this many days. */
  firstVisitDays: number;
  /** How many ranked rows each lane returns. */
  show: number;
}

/** The Desk's five headline counts, every one over the whole matched set rather
    than over the rows returned. */
export interface DeskLaneCounts {
  /** Distinct live roles under all watched titles, after the member's filters,
      with NO age window: the summary line's number. */
  liveUnderTitles: number;
  coreLiveCount: number;
  stretchLiveCount: number;
  newCoreCount: number;
  newStretchCount: number;
}

/** One ranked lane row: the board row plus the three facts the cut decided. */
export interface DeskLaneRow {
  row: BoardRow;
  /** Which watched titles pulled this role in, in the member's own watch order,
      exactly as ledger-titles.laneFor tags them. */
  matched: string[];
  /** True when any CORE watch caught it (a role a core title caught is core,
      even when a stretch title also caught it). */
  isCore: boolean;
  isNew: boolean;
}

/** Per watched title: the three numbers the watch list prints. */
export interface DeskTitleCounts {
  /** Live rows matching this watch, before the member's filters. */
  liveCount: number;
  /** Distinct live board titles this watch matches. */
  titlesLive: number;
  /** Distinct board titles it matches across live AND killed rows. */
  titlesTotal: number;
}

/** The autocomplete's source: the head of the index, and how long the whole
    index is, so the panel can say what it is not showing. */
export interface DeskTitleIndex {
  head: TitleCount[];
  total: number;
}

/**
 * The normalised phrase for a watch, and the raw title to hand back. A watch
 * that normalises to nothing (all punctuation) matches nothing, exactly as
 * matchesTitle decides, so it is dropped here and its counts are zeros.
 */
function phrasesOf(watches: readonly DeskWatch[]): { ord: number[]; phrase: string[]; raw: string[]; core: boolean[] } {
  const ord: number[] = [];
  const phrase: string[] = [];
  const raw: string[] = [];
  const core: boolean[] = [];
  watches.forEach((w, i) => {
    const p = normalizeTitle(w.title);
    if (!p) return;
    ord.push(i);
    phrase.push(p);
    raw.push(w.title);
    core.push(w.shelf === 'core');
  });
  return { ord, phrase, raw, core };
}

/**
 * The member's filters as bound parameters, mirroring desk-home.ts passesPrefs:
 * remote when asked, and a floor read off comp_range.min the same way the
 * board's comp facet reads it (a floor of zero or less is no floor, and a row
 * with no numeric minimum fails any floor that is set).
 */
function prefsParams(prefs: LedgerSelection): { remoteOnly: boolean; compFloor: number | null } {
  const floor = typeof prefs.compFloor === 'number' && prefs.compFloor > 0 ? prefs.compFloor : null;
  return { remoteOnly: Boolean(prefs.remoteOnly), compFloor: floor };
}

/**
 * The lane, as one CTE both statements below share so the cut cannot drift
 * between the counts and the rows (the same discipline job-store.ts's
 * BOARD_FACET_CTE keeps). Parameters, in order:
 *   $1 the watch ordinals, $2 the normalised phrases, $3 the raw titles,
 *   $4 which of them are core, $5 remote-only, $6 the comp floor or NULL,
 *   $7 the sweep day, $8 the window in days, $9 the last-visit day or NULL,
 *   $10 the first-visit window in days.
 *
 * THE CANDIDATE SET IS NARROW ON PURPOSE. The matching CTE carries four columns,
 * not a whole board row: the normalisation and the match run over id, first_seen,
 * fit_total and the normalised title, and the full columns are joined back on id
 * for the twelve rows that actually win. Carrying every column through the match
 * measured 48 ms against 32 ms for the narrow one, for rows that were then thrown
 * away.
 *
 * MATERIALIZED IS LOAD-BEARING, NOT A HINT. Without it Postgres inlines the
 * candidate CTE into the semi join and re-evaluates the title normalisation once per
 * (row, watched title) PAIR: measured on the local snapshot (13,284 live rows, a
 * three-title watch list) the lane count took 59.8 ms inlined and 32.3 ms
 * materialised, because the regexp then runs once per row. The single remaining
 * pass is about 23 ms of that, and the only way to remove it is to stop deriving
 * the value at read time at all: a stored generated column on jobs takes the
 * same query to 9.3 ms (measured 2026-09-25). That is the db/207 move and it is
 * left for the owner, because the column would also widen the SELECT * that
 * jobs-data-agg.ts scans, which this change was scoped not to touch.
 *
 * age_days is the sweep day minus first_seen, which is a DATE column (db/117),
 * so this is the same whole-day subtraction desk-home.ts got from daysBetween
 * over isoDay(first_seen). A row with no first_seen has no age and is in no
 * window, which is what inDeskWindow decides for a null.
 */
const DESK_LANE_CTE = `
WITH w AS (
  SELECT ord, phrase, raw, is_core
    FROM unnest($1::int[], $2::text[], $3::text[], $4::boolean[]) AS t(ord, phrase, raw, is_core)
),
cand AS MATERIALIZED (
  SELECT j.id, j.first_seen, j.fit_total,
         (' ' || regexp_replace(lower(j.title), '[^a-z0-9]+', ' ', 'g') || ' ') AS nt
    FROM jobs j
   WHERE j.status <> 'killed'
     AND (NOT $5::boolean OR j.remote)
     AND ($6::numeric IS NULL
          OR (jsonb_typeof(j.comp_range->'min') = 'number'
              AND (j.comp_range->>'min')::numeric >= $6::numeric))
),
lane AS (
  SELECT c.id, c.first_seen, c.fit_total,
         ARRAY(SELECT w.raw FROM w WHERE c.nt LIKE ('% ' || w.phrase || ' %') ORDER BY w.ord) AS matched,
         EXISTS (SELECT 1 FROM w WHERE w.is_core AND c.nt LIKE ('% ' || w.phrase || ' %')) AS is_core,
         ($7::date - c.first_seen IS NOT NULL
           AND $7::date - c.first_seen >= 0
           AND $7::date - c.first_seen <= $8::int) AS in_window,
         CASE WHEN $9::date IS NOT NULL
                THEN c.first_seen IS NOT NULL AND c.first_seen >= $9::date
              ELSE $7::date - c.first_seen IS NOT NULL
                   AND $7::date - c.first_seen >= 0
                   AND $7::date - c.first_seen <= $10::int
         END AS is_new
    FROM cand c
   WHERE EXISTS (SELECT 1 FROM w WHERE c.nt LIKE ('% ' || w.phrase || ' %'))
)`;

/** The lane's parameter list, in the order DESK_LANE_CTE binds them. */
function laneParams(watches: readonly DeskWatch[], prefs: LedgerSelection, when: DeskWhen): unknown[] {
  const { ord, phrase, raw, core } = phrasesOf(watches);
  const { remoteOnly, compFloor } = prefsParams(prefs);
  return [ord, phrase, raw, core, remoteOnly, compFloor, when.sweepDate, when.windowDays, when.lastSeenDay, when.firstVisitDays];
}

/**
 * The five headline counts. A separate statement from the rows on purpose: a
 * member whose every match is older than the window has real counts and no
 * rows, so the counts cannot ride on a returned row.
 */
export async function deskLaneCounts(
  watches: readonly DeskWatch[],
  prefs: LedgerSelection,
  when: DeskWhen
): Promise<DeskLaneCounts> {
  const empty: DeskLaneCounts = {
    liveUnderTitles: 0, coreLiveCount: 0, stretchLiveCount: 0, newCoreCount: 0, newStretchCount: 0
  };
  if (phrasesOf(watches).phrase.length === 0) return empty;
  const { rows } = await db().query<Record<string, number>>(
    `${DESK_LANE_CTE}
SELECT count(*)::int                                                              AS live_under_titles,
       count(*) FILTER (WHERE in_window AND is_core)::int                          AS core_live,
       count(*) FILTER (WHERE in_window AND NOT is_core)::int                       AS stretch_live,
       count(*) FILTER (WHERE in_window AND is_core AND is_new)::int                AS new_core,
       count(*) FILTER (WHERE in_window AND NOT is_core AND is_new)::int            AS new_stretch
  FROM lane`,
    laneParams(watches, prefs, when)
  );
  const c = rows[0];
  if (!c) return empty;
  return {
    liveUnderTitles: c.live_under_titles ?? 0,
    coreLiveCount: c.core_live ?? 0,
    stretchLiveCount: c.stretch_live ?? 0,
    newCoreCount: c.new_core ?? 0,
    newStretchCount: c.new_stretch ?? 0
  };
}

/**
 * The ranked head of each lane: at most when.show rows of core and when.show of
 * stretch, inside the window, fit first and newest breaking a tie, with id ASC
 * making the tie deterministic (see the header). One statement for both lanes,
 * partitioned on is_core.
 */
export async function deskLaneRows(
  watches: readonly DeskWatch[],
  prefs: LedgerSelection,
  when: DeskWhen
): Promise<DeskLaneRow[]> {
  if (phrasesOf(watches).phrase.length === 0) return [];
  const params = laneParams(watches, prefs, when);
  const { rows } = await db().query<BoardRow & { matched: string[]; is_core: boolean; is_new: boolean }>(
    `${DESK_LANE_CTE},
ranked AS (
  SELECT lane.id, lane.matched, lane.is_core, lane.is_new,
         row_number() OVER (PARTITION BY is_core
                            ORDER BY coalesce(fit_total, 0) DESC,
                                     coalesce(first_seen, '1970-01-01'::date) DESC,
                                     lane.id ASC) AS rn
    FROM lane
   WHERE in_window
)
SELECT ${BOARD_LIST_COLUMNS}, ${KILL_COLUMNS},
       r.matched, r.is_core, r.is_new
  FROM ranked r
  JOIN jobs j ON j.id = r.id
  LEFT JOIN board_kills k ON k.id = j.kill_id
 WHERE r.rn <= $11::int
 ORDER BY r.is_core DESC, r.rn ASC`,
    [...params, when.show]
  );
  return rows.map((r) => {
    const { matched, is_core, is_new, ...row } = r;
    return { row: row as BoardRow, matched: matched ?? [], isCore: is_core, isNew: is_new };
  });
}

/**
 * The three numbers under each watched title, in the order the watches were
 * given. Over the whole live board with NO member filters (the title's real
 * market, which the filters narrow the lanes against but not this total), and
 * folding the kill archive into titlesTotal so a title alias that only shows on
 * dead roles still counts as covered.
 *
 * The titles travel as arrays and the watches are LEFT JOINed to them, so a
 * watch that matches nothing comes back as three zeros rather than as a missing
 * row. Raw titles, not trimmed ones, because the sets this mirrors were built
 * from row.title as the board holds it.
 *
 * ONE ROW PER TITLE, NOT PER POSTING. Two of these three numbers are counts of
 * DISTINCT titles, so the rows are folded to one per title FIRST and the counts
 * become plain counts over that. It also means the normalisation runs once per
 * distinct title rather than once per row. Measured on the local snapshot with a
 * three-title watch list: 56.8 ms counting DISTINCT over every row, 29.0 ms this
 * way, with identical numbers.
 */
export async function deskTitleCounts(watches: readonly DeskWatch[]): Promise<DeskTitleCounts[]> {
  const zero: DeskTitleCounts = { liveCount: 0, titlesLive: 0, titlesTotal: 0 };
  const out: DeskTitleCounts[] = watches.map(() => ({ ...zero }));
  const { ord, phrase } = phrasesOf(watches);
  if (phrase.length === 0) return out;
  const { rows } = await db().query<{ ord: number; live_count: number; titles_live: number; titles_total: number }>(
    `WITH w AS (
  SELECT ord, phrase FROM unnest($1::int[], $2::text[]) AS t(ord, phrase)
),
t AS (
  SELECT j.title AS title, true AS live FROM jobs j WHERE j.status <> 'killed'
  UNION ALL
  SELECT k.title, false FROM board_kills k WHERE k.vacated_at IS NULL
),
g AS MATERIALIZED (
  SELECT title,
         (' ' || regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g') || ' ') AS nt,
         count(*) FILTER (WHERE live)::int AS live_rows,
         bool_or(live) AS any_live
    FROM t
   WHERE title IS NOT NULL
   GROUP BY title
)
SELECT w.ord,
       coalesce(sum(g.live_rows), 0)::int          AS live_count,
       count(*) FILTER (WHERE g.any_live)::int     AS titles_live,
       count(g.title)::int                         AS titles_total
  FROM w LEFT JOIN g ON g.nt LIKE ('% ' || w.phrase || ' %')
 GROUP BY w.ord
 ORDER BY w.ord`,
    [ord, phrase]
  );
  for (const r of rows) {
    if (r.ord >= 0 && r.ord < out.length) {
      out[r.ord] = { liveCount: r.live_count, titlesLive: r.titles_live, titlesTotal: r.titles_total };
    }
  }
  return out;
}

/**
 * The head of the title index, and the whole index's length.
 *
 * WHY A HEAD AND NOT THE INDEX. The board carries 10,526 distinct live titles
 * on the local snapshot and near one per row on production; the dropdown that
 * reads this renders at most 1,500 of them and says how many it is not showing.
 * The old code got the whole index by grouping every row in TypeScript, which
 * is what the 27 MB read was mostly paying for.
 *
 * THE COLLATION IS NOT DECORATION. buildTitleIndex broke a count tie with
 * String.localeCompare, so the SQL has to order ties the same way or the head
 * would hold a different set of titles. "en-US-x-icu" is that comparator:
 * checked against localeCompare over all 10,526 titles on 2026-09-25, the top
 * 200 and the top 1,500 came out identical in order, where the database's own
 * en_US.UTF-8 collation differed on 19 titles and "C" on 162. desk-agg.test.ts
 * asserts that equality, so the exact ordering is proved and not assumed.
 *
 * AND IT DEGRADES RATHER THAN THROWS. A named collation only exists if the
 * server was built with ICU. If it is missing Postgres raises 42704
 * (undefined_object) and nothing else in the statement is wrong, so this catches
 * exactly that code once, remembers it, and re-asks with the server's own
 * collation. A dropdown whose tail is ordered slightly differently is a far
 * better outcome than a paid page that throws, and the numbers on the page do
 * not depend on this order at all. Nothing else is caught.
 */
/** Set once, if this server turns out to have no ICU collation. */
let noIcuCollation = false;
/** The error Postgres raises for a collation that does not exist. */
const UNDEFINED_OBJECT = '42704';
export async function deskTitleIndex(limit: number): Promise<DeskTitleIndex> {
  const sql = (collate: string) => `WITH g AS (
  SELECT btrim(j.title) AS title, count(*)::int AS n
    FROM jobs j
   WHERE j.status <> 'killed' AND btrim(coalesce(j.title, '')) <> ''
   GROUP BY 1
)
SELECT title, n, count(*) OVER ()::int AS total
  FROM g
 ORDER BY n DESC, title${collate} ASC
 LIMIT $1::int`;
  const params = [Math.max(0, Math.floor(limit))];
  let rows: { title: string; n: number; total: number }[];
  if (noIcuCollation) {
    ({ rows } = await db().query<{ title: string; n: number; total: number }>(sql(''), params));
  } else {
    try {
      ({ rows } = await db().query<{ title: string; n: number; total: number }>(sql(' COLLATE "en-US-x-icu"'), params));
    } catch (err) {
      if ((err as { code?: string })?.code !== UNDEFINED_OBJECT) throw err;
      noIcuCollation = true;
      ({ rows } = await db().query<{ title: string; n: number; total: number }>(sql(''), params));
    }
  }
  return {
    head: rows.map((r) => ({ title: r.title, count: r.n })),
    total: rows[0]?.total ?? 0
  };
}
