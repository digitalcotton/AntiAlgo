/**
 * job-store.ts: the read/write half of the general-tracker job table
 * (db/017_jobs.sql). The site reads the /board surface one page at a time
 * through listBoardFiltered() (2026-09-11) and the age plot through
 * listBoardAgeHistogram(), a GROUP BY rather than a read of every row (2026-09-19);
 * the mini's tracker is the only writer in production, but upsertJobs() lives
 * here so the ingest has one place that knows the table's shape.
 *
 * Same discipline as watchlist-store.ts and desk-store.ts: PARAMETERISED
 * QUERIES ONLY, no value is ever concatenated into SQL. The search words reach
 * Postgres as one bound tsquery string, built in buildSearchQuery() below from
 * quoted lexemes and never from raw text, and handed to to_tsquery() as a
 * parameter.
 */
import { db } from './db';
import type { BoardRow } from './board-jobs';
import type { AgeHistogram, AgeBucket } from './data';
import { COMP_TOP_PATTERN } from './data';
import { normalizeTitle } from './ledger-titles';
import { ISO_COUNTRIES } from './jobs-derived.mjs';
import { SEARCH_MAX_CHARS } from './search-parse';
import { PLACE_UNSTATED, isPlaceUnstated, parsePlaceKey, type BoardSort } from './board-query';

/**
 * The columns the board adapter (board-jobs.ts) reads, in one place. ghost is
 * gone (2026-09-08): it was an age flag, the retired evergreen rule under
 * another name. status and kill_id are the record's answer instead, written by
 * the ingest from board_kills (db/030, db/031).
 */
const BOARD_COLUMNS = `j.id, j.slug, j.company, j.title, j.url, j.location, j.country, j.remote, j.published, j.ats,
  j.posting_id, j.department, j.derived_fam, j.derived_fam_source,
  j.comp_posted, j.comp_range, j.days_up, j.first_seen, j.last_seen,
  j.detail_total, j.detail_components, j.source, j.description, j.status, j.kill_id`;

/**
 * The same columns for a LIST read, with the heavy description column nulled at
 * the source so it never leaves the database in bulk. Exported because
 * desk-agg.ts reads rows in this exact shape (BoardRow) and a second copy of
 * this list would drift from it the first time a column was added.
 */
export const BOARD_LIST_COLUMNS = `j.id, j.slug, j.company, j.title, j.url, j.location, j.country, j.remote, j.published, j.ats,
  j.posting_id, j.department, j.derived_fam, j.derived_fam_source,
  j.comp_posted, j.comp_range, j.days_up, j.first_seen, j.last_seen,
  j.detail_total, j.detail_components, j.source, NULL::text AS description, j.status, j.kill_id`;

/**
 * The kill of record beside a board row, when one names it. Read with a LEFT
 * JOIN on jobs.kill_id so a live row carries nulls and a killed row carries the
 * rule, the machine's reason and the dates, exactly as kills-archive.json holds
 * them. Nothing here is derived on the site; the ingest wrote it from the file.
 */
export const KILL_COLUMNS = `k.kill_rule, k.reason AS kill_reason, k.killed_on, k.first_published AS kill_first_published,
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
/**
 * WHEN THE BOARD'S ROWS WERE LOADED, as an ISO instant, or null when the row
 * cannot say.
 *
 * This is NOT the sweep instant, and the difference is the whole reason this
 * function exists rather than a `.swept_at` read at each call site. Two
 * pipelines feed this site. The nightly sweep reads 45 curated boards and
 * writes stats.json (src/lib/data.ts's sweptAt(), ~77 live). The all-boards
 * crawl reads ~1,666 boards and loads ~37,000 rows into Postgres, stamping
 * board_stats.swept_at, and it finishes hours later because it runs after the
 * sweep, not with it.
 *
 * The board tiles and the board table are the crawl's output, so the stamp
 * above them has to be the crawl's instant. On 2026-09-30 the home page
 * claimed its 37,306 rows were verified four minutes earlier when they had been
 * loaded two days before, because the stamp read sweptAt() while the rows did
 * not.
 *
 * It normalises because the pg driver hands back a Date for a timestamp column
 * and a string when the row came from JSON — the home page rendered
 * `data-swept="Mon Sep 28 2026 13:43:00 GMT+0000 (Coordinated Universal Time)"`
 * for exactly that reason, which parses but is not the ISO string every other
 * timestamp on this site is written in.
 */
export function boardRowsLoadedAt(stats: BoardStats | null): string | null {
  const raw = stats?.swept_at;
  if (!raw) return null;
  const iso = raw instanceof Date ? raw.toISOString() : String(raw);
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

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
  /** The search words as typed. Blank is no text filter; see buildSearchQuery
      for what the rest becomes and listBoardFiltered for the typo fallback. */
  q: string;
  /** The old single-valued arrangement (`all` or one of the four). Used only
      when `remote` is empty; see resolveArrangement. */
  location: string;
  /** The pay band the current Comp select offers, or `all`. While it is
      anything but `all` it IS the pay filter (see resolvePay). */
  comp: string;
  freshness: string;
  /** `best` is the search-words order and only means something while `q` has
      words; with none it reads as `fit`. */
  sort: BoardSort;
  page: number;
  perPage: number;
  /** The sweep's calendar day (data.ts sweepDate()), the "to" end of every age. */
  sweepDate: string;
  /** Evergreen talent pools (db/218): 'all' (the default, and what every
   *  caller passes today), 'only', or 'exclude'. Nothing reads this off the
   *  URL yet — see the match_pipeline comment in the CTE for why it exists
   *  before it is used. */
  pipeline?: 'all' | 'only' | 'exclude';
  /** The age strip's range in whole days, either end open. A row with no
      measurable age is outside any range that is set. */
  ageMin: number | null;
  ageMax: number | null;
  /** Optional ISO country code to restrict rows to (the homepage teaser
   *  geo-targets by it). Null/undefined = every country, the board's default. */
  country?: string | null;
  /** When true (the default since 2026-09-20), only rows whose status is
   *  'live': no killed rows in a list a reader browses. A killed row keeps its
   *  record page (/board/[slug] resolves it through board_kills.job_slug) and
   *  its place on the Desk, the tracker and the kill list; it just never sits
   *  in the board's list, counts or age plot as if it were open. Pass false to
   *  read everything. */
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
  /** Arrangements to keep (`remote`, `hybrid`, `onsite`, `unstated`). Empty or
   *  undefined means every arrangement. Wins over the old single `location`. */
  remote?: readonly string[];
  /** The pay floor, in thousands: keep postings whose comp_range.min is at
   *  least $payMin,000, the Desk's own definition (see comp_min in the CTE).
   *  Ignored while `comp` names a band or `compNotListed` is set. */
  payMin?: number | null;
  /** Keep only postings that state no pay. Exclusive with `payMin`. */
  compNotListed?: boolean;
  /** A place key (`GB`, `US-MD`, `GB/London`, `US-MD/Baltimore`;
   *  board-query.ts parsePlaceKey), or `unstated` for the postings with no
   *  resolved country (place-key.ts PLACE_UNSTATED). An invalid key is dropped,
   *  not an error. */
  place?: string | null;
  /** Whether the reader can SEE Deets, the score this board prints in its own
   *  column and explains in the why panel. Absent means true, which is what every
   *  caller that does not render rows (the counts, the typeahead, the harness)
   *  means and what the signed-in board is. board.astro passes false for a reader
   *  who has neither the Deets column nor the panel, and a search's best-match
   *  order then drops Deets from its tie-break: an order must not lean on a
   *  number the reader cannot read. See BEST_ORDER. */
  deetsVisible?: boolean;
  /** A company by its exact name on the board. */
  company?: string | null;
  /** Occupational families to keep (src/lib/job-family.mjs, db/212's
   *  derived_fam). Empty or undefined means every family, which is the default
   *  and what a signed-out reader always gets. A row with no family is outside
   *  every chosen family: it has no field to be inside of, the same rule the age
   *  strip states for a row with no measurable age.
   *
   *  THIS NARROWS, IT DOES NOT RANK. The family answers "is this even my field";
   *  which of two design jobs is better is what tier, comp and region already
   *  answer, from measured values. */
  families?: string[];
}

/** How many rows each option would leave, given everything else that is set. */
export interface FacetCounts {
  total: number;
  location: Record<string, number>;
  /** NOT COUNTED BY THE BOARD ANY MORE (2026-10-02): the three below are absent
   *  from what the store returns, because nothing the board draws reads them. The
   *  pay bands (`comp`) went when COMP became floors: the floors' "Any" and "Not
   *  listed" are `pay.any` and `pay.notListed`, which are still counted. The
   *  freshness counts had no strip control, and the Field's (`family`) links under
   *  the table were removed. Each cost an aggregate over every row per request, and
   *  the three together about a third of the statement for the board with no words
   *  (docs/board-speed-plan.md).
   *  The FILTERS they belonged to (`comp=`, `freshness=`, `fam=`) still narrow
   *  the board exactly as before; only the counting went. They stay on the type,
   *  optional, because the Pre-List builds counts of this shape itself
   *  (prospect-board.ts) and its three-select path reads comp and freshness. */
  comp?: Record<string, number>;
  freshness?: Record<string, number>;
  /** Keyed by family id, plus 'all' and 'unplaced'. Not counted by the board; see above. */
  family?: Record<string, number>;
  /** The arrangement counts under the new name: `all` plus the four kinds, each
   *  the rows that would remain if THAT arrangement alone were chosen. The same
   *  numbers as `location` by construction (one expression, read twice) and kept
   *  as a second object only until the strip moves off `location`. */
  remote: Record<string, number>;
  /** The pay filter's counts. `floors` is CUMULATIVE ("$150k+" includes every
   *  posting at $200k+), keyed by the floor in thousands; `any` is no pay
   *  filter; `notListed` is the postings that state no pay. All of them leave
   *  the whole pay control out, so each is what that choice would leave. */
  pay: { any: number; notListed: number; floors: Record<string, number> };
  /** The places, counted over everything but the place filter itself: each
   *  country's rows, and the rows that list no place (`place=unstated`), counted
   *  apart. A posting is counted under EVERY country it lists (db/222), so each
   *  number is exactly the rows its own filter returns, and together they add up
   *  to MORE than the board holds whenever a posting lists two countries.
   *  `all` is therefore counted on its own: what the board would show with no
   *  place chosen, the number the Worldwide option prints and returns.
   *  EVERY COUNTRY THE LIVE BOARD HOLDS IS A KEY, at 0 where the other
   *  filters leave it nothing: a country is never dropped from the list because
   *  the words, the pay floor or the arrangement emptied it, since an absence
   *  cannot be told from a country the board never had. */
  place: { countries: Record<string, number>; notStated: number; all: number };
}

/** The pay floors the counts offer, in thousands (the plan's Comp control:
    $100k+ to $300k+). Exported so the strip and the counts name one list. */
export const PAY_FLOORS_K = [100, 150, 200, 250, 300] as const;

/** The fields a rank was decided on, the facts a "ranked because" line states. */
export type MatchField = 'title' | 'company' | 'department' | 'description';

/**
 * A board row plus the three facts its place in a text search was decided on.
 *
 *   match_tier   0 the title IS the words, 1 every word is in the title, 2 every
 *                word is in the title or the company, 3 anything else; null when
 *                there are no words, and null on the typo path, where a row has
 *                no tier because tiers are the ladder of EXACT matches and a
 *                close spelling is on none of its rungs.
 *   match_field  the LOWEST-weight field any word needed: title for tiers 0 and
 *                1, company for 2, and for 3 the department when every word is
 *                in the title, company or department, else the description. It
 *                is the field that completes the match, which is what the tier
 *                rule says; a row with one word in the title and one in the
 *                description is a description match. 'title' on the typo path
 *                (that is the only field it reads); null with no words.
 *   fuzzy_score  the similarity the typo path ordered by, 0 to 1, else null.
 */
export type BoardListRow = BoardRow & {
  match_tier: number | null;
  match_field: MatchField | null;
  fuzzy_score: number | null;
};

export interface BoardFilteredResult {
  rows: BoardListRow[];
  total: number;
  counts: FacetCounts;
  /** True when the words matched nothing exactly and every row, count and
      ordering here is from the close-spelling (trigram) path instead. The page
      says so; a reader must never mistake a near match for a match. */
  fuzzy: boolean;
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

/**
 * The comp_top SQL expression, as a function of a `comp_posted` column
 * reference, so boardFacetCte() and comp-top-sql.test.ts (which runs this
 * exact expression against known strings on a live database) share one
 * source rather than two copies that could drift the way comp_top's
 * pattern once drifted from compTop()'s. Built from COMP_TOP_PATTERN
 * (data.ts) — see the comment on comp_top in boardFacetCte() below before
 * changing this.
 *
 * m[1] is the digits (commas intact), m[2] is "k"/"K" or NULL. A "k" figure
 * is already in thousands; a bare figure is a full dollar amount and is
 * divided by 1000 to land in the same unit (matches compTop()'s
 * normalisation in data.ts, which this must be changed together with).
 */
export function compTopSql(column: string): string {
  return `(SELECT max((replace(m[1], ',', ''))::numeric / (CASE WHEN m[2] IS NULL THEN 1000 ELSE 1 END))
            FROM regexp_matches(coalesce(${column}, ''), '${COMP_TOP_PATTERN}', 'gi') AS m)`;
}

/** The ORDER BY for each sort key, allowlisted; the raw string never reaches SQL. */
const BOARD_ORDER: Record<Exclude<BoardFilter['sort'], 'best'>, string> = {
  // The sort key stays 'fit' because it is in the address and in people's
  // bookmarks; the COLUMN is what was renamed (db/213). The label a reader sees
  // is 'Detail' (SortControl.astro).
  fit: 'detail_total DESC, company ASC, title ASC, id ASC',
  comp: 'comp_top DESC NULLS LAST, company ASC, title ASC, id ASC',
  age: 'age_days ASC NULLS LAST, company ASC, title ASC, id ASC'
};

/**
 * THE BEST-MATCH ORDERS, TWO EACH, allowlisted: the raw string never reaches SQL
 * and neither does the flag that picks between them. A search's order is its text
 * (the tier a row's words are found at, then how close the match is, or on the typo
 * path how alike the spelling is), and what breaks a tie after that was Deets. A
 * reader who cannot see Deets, a signed-out reader on a board where fit_public is
 * dark, has no Deets column and no why panel, so a tie broken by Deets is broken
 * by a number they cannot read and the order is one they cannot check: the thing
 * this product exists to refuse. For them the tie is age, then id. `deetsVisible`
 * on the filter chooses (pageSql); rank-reason.ts words both, and
 * rank-reason.test.ts reads these four strings and fails when one changes under a
 * sentence that still describes the old order.
 */
const BEST_ORDER = {
  withDeets: 'tier_n ASC, rank_n DESC, detail_total DESC, age_days ASC NULLS LAST, id ASC',
  withoutDeets: 'tier_n ASC, rank_n DESC, age_days ASC NULLS LAST, id ASC'
} as const;
const FUZZY_ORDER = {
  withDeets: 'text_sim DESC, detail_total DESC, age_days ASC NULLS LAST, id ASC',
  withoutDeets: 'text_sim DESC, age_days ASC NULLS LAST, id ASC'
} as const;

/**
 * THE PLACE AND COMPANY PREDICATES, written once. boardFacetCte() spells its
 * match_place and match_company flags with these, and countBoardTotals() spells
 * the per-suggestion version of the same two questions with them, so "what is a
 * posting in this place" has one definition and a suggestion's count cannot
 * drift from the table's. The arguments are the PARAMETER NAMES to read (`$16`),
 * never values.
 *
 * A POSTING IS IN EVERY PLACE IT LISTS (db/222, 2026-10-02). jobs.place_keys holds
 * every key of every place the posting lists, at every level (GB, US-MD,
 * GB/London, US/Baltimore, US-MD/Baltimore: placesOf() in jobs-derived.mjs), so a
 * place filter of any level is one question, "does this posting's list hold this
 * key", answered by a GIN index. The key is rebuilt here from the three
 * parameters, in the grammar place-key.ts owns: the country, then `-` and the
 * region if one is named, then `/` and the city if one is. What this replaced was
 * three equalities on the columns of the ONE place a posting had been reduced to,
 * which is why a job listing London and Berlin was found under neither. place_keys
 * is NOT NULL, so unlike those columns it has no NULL case to coalesce.
 *
 * `unstated` TRAVELS IN THE COUNTRY PARAMETER. The country is bound as the
 * literal PLACE_UNSTATED (placeBinding), which no country code can equal, and the
 * predicate then asks for the rows that list NO place (an empty place_keys) instead
 * of the rows that list one. That keeps the statement's parameters exactly where
 * they were (the tests pin them, and the search words are numbered from the end of
 * them), and the keyword is written into the text from this file's own constant,
 * never from input.
 */
function placeKeySql(country: string, admin1: string, city: string): string {
  return `${country}::text || COALESCE('-' || ${admin1}::text, '') || COALESCE('/' || ${city}::text, '')`;
}
function placeMatchSql(country: string, admin1: string, city: string): string {
  return `CASE WHEN ${country}::text = '${PLACE_UNSTATED}' THEN cardinality(place_keys) = 0
                   ELSE ${country}::text IS NULL OR place_keys @> ARRAY[${placeKeySql(country, admin1, city)}]::text[] END`;
}
function companyMatchSql(name: string): string {
  return `(${name}::text IS NULL OR company = ${name}::text)`;
}

/**
 * EVERY COUNTRY THE LIVE BOARD HOLDS, as one subquery: for each of the 250 ISO
 * codes, does a live row list it (one probe of the GIN index on place_keys), and
 * the codes that pass, in order. The codes are written into the statement from
 * jobs-derived.mjs's own constant, never from input, and checked here to be two
 * upper case letters, so nothing a reader types can reach this text.
 */
const PLACE_UNIVERSE_SQL = (() => {
  for (const code of ISO_COUNTRIES) {
    if (!/^[A-Z]{2}$/.test(code)) throw new Error(`job-store: ${JSON.stringify(code)} is not an ISO country code`);
  }
  return `(SELECT array_agg(c ORDER BY c)
            FROM unnest(ARRAY[${ISO_COUNTRIES.map((code) => `'${code}'`).join(',')}]::text[]) AS c
           WHERE EXISTS (SELECT 1 FROM jobs WHERE status <> 'killed' AND place_keys @> ARRAY[c]))`;
})();

/**
 * The facets, computed in SQL exactly as data.ts computes them in TypeScript
 * (facetsOf, workplaceOf, compBandOf, ageOf, compTop), so a count printed on an
 * option is the count of rows the option leaves. Parameters, in order:
 *   $1 the sweep date, $2 the fresh window in days, $3 the search text (see
 *   below) or NULL, $4 location, $5 comp, $6 freshness, $7 and $8 the age range
 *   in days (either NULL for open), $9 country, $10 live only, $11 has comp,
 *   $12 families, $13 pipeline, $14 the arrangement list or NULL, $15 the pay
 *   floor in thousands or NULL, $16 $17 $18 the place's country, region and
 *   city (each NULL when the key stops short of it), $19 the company or NULL.
 *   The range is not a facet: it has no options to count, so it joins every
 *   keep clause and never has a column of its own.
 *
 * THE SEARCH TEXT, THREE WAYS (the `mode` argument). In EXACT mode $3 is the
 *   tsquery buildSearchQuery() wrote ('' matches nothing, NULL is no text
 *   filter), kept for the ranking and for those two states, and the match is
 *   the word-by-word predicate SearchQuery.match describes, written by
 *   compileMatch over the tsqueries bound from $20 on: each word is
 *   `search_tc @@ prefix OR search @@ whole word`, ANDed across words (see "TWO
 *   INDEXES, ONE PREDICATE" below for why it is not one tsquery any more). In TITLE mode (the title
 *   completions) $3 is the title-only tsquery and a row matches when
 *   `search_tc @@ to_tsquery('simple', $3)`. In FUZZY mode (the typo path) $3
 *   is the folded words, used only to score, $20 is a tsquery for the words too
 *   short to misspell (or NULL) and $21 onward are the words long enough to,
 *   each of which must be trigram word-similar to the title. Every mode is
 *   written ONCE, here, and every statement that filters by the words (the
 *   counts, the rows, the places, the age strip) builds on this CTE, so the
 *   four cannot disagree about which rows matched.
 *
 * match_q IS THE AUTHORITY AND THE WHERE IS ITS SHADOW. The same predicate is
 *   also written into base's WHERE, which is what lets Postgres use
 *   jobs_search_idx and jobs_search_tc_idx (GIN indexes, joined by a BitmapOr
 *   per word and a BitmapAnd across words) or jobs_title_trgm_idx instead of
 *   reading all 37,000 rows' search vectors out of TOAST. That is safe to do
 *   because the search words are never left out of a count: every option's count is taken inside the words
 *   (see keepSql). If the WHERE were deleted every number would stay the same
 *   and only the latency would change, which is why the unit tests check for
 *   both. The `status <> 'killed'` beside it is the literal the partial index
 *   needs; it is a superset of match_live, never a narrowing of it.
 *
 * comp_min is comp_range.min as a number, or NULL. The pay floor reads it, and
 *   it is the Desk's definition word for word (src/lib/desk-agg.ts: a numeric
 *   `min` at or above the floor, and a row with no numeric minimum fails any
 *   floor that is set). It is NOT jobs.comp_min_k, which is that same figure
 *   ROUNDED to thousands: a floor of 100 on comp_min_k admits a posting whose
 *   minimum is $99,600, and measured on 2026-10-02 the two disagreed on 14 rows
 *   at $100k, 5 at $1k, 3 at $200k and 2 at $150k.
 *
 * location: the words win and the remote flag is not read; "hybrid" beats
 *   "remote" ("Remote or hybrid" is On-site or hybrid), as workplaceOf says.
 * comp: the band of comp_range.min; no numeric floor, or a floor of zero or
 *   less, is "not-listed".
 * age_days: the posted date (UTC calendar day), else the kill's own first
 *   published date, else first_seen when it is strictly before the sweep date;
 *   measured to the kill date for a killed row and to the sweep date otherwise.
 * comp_top: built by compTopSql() above from COMP_TOP_PATTERN (data.ts) — the
 *   largest stated pay figure in the posted text, normalised to thousands,
 *   the comp sort key. MUST BE CHANGED TOGETHER WITH compTop() in data.ts:
 *   that function reads the same pattern and applies the same
 *   comma-strip/thousands-normalisation, and a row's comp sort must never
 *   disagree with what its comp cell displays.
 * description is NULL::text on purpose: the heavy column never leaves the
 * database for a list, and the row shape stays BoardRow.
 */
function boardFacetCte(mode: TextMode): string {
  return `
WITH base AS (
  SELECT j.id, j.slug, j.company, j.title, j.url, j.location, j.country, j.remote, j.published, j.ats,
         j.posting_id, j.department, j.comp_posted, j.comp_range, j.days_up, j.first_seen, j.last_seen,
         j.detail_total, j.detail_components, j.source, NULL::text AS description, j.status, j.kill_id,
         j.derived_fam, j.derived_fam_source,
         j.search, j.search_tc, j.place_keys, j.place_countries,
         CASE WHEN jsonb_typeof(j.comp_range->'min') = 'number' THEN (j.comp_range->>'min')::numeric END AS comp_min,
         ${KILL_COLUMNS},
         -- WHERE THE WORK HAPPENS. This read the location TEXT only, and the
         -- text is not where most applicant systems put the answer: the crawl
         -- already records the source's own structured flag in j.remote, and
         -- 2,650 live rows carried it while naming a city, so they were filed
         -- as on-site. The Remote filter was hiding 64% of the remote board
         -- (1,469 shown of 4,177 real). Ashby, Breezy, Lever, iCIMS and
         -- Teamtailor state it structurally; Greenhouse, Workday, Rippling and
         -- Personio only ever put it in the text, where the regex still finds
         -- it. Reading both is the only way to get one answer.
         --
         -- HYBRID IS ITS OWN ANSWER (2026-09-28). It was folded into 'onsite'
         -- by an explicit first branch, so a reader who wanted hybrid could not
         -- ask and a reader who wanted on-site was handed it anyway. It stays
         -- FIRST, ahead of remote, because a posting that says hybrid and also
         -- carries the remote flag is telling you the more specific of the two.
         --
         -- AND A MISSING LOCATION IS NOT AN OFFICE. 192 live rows carry no
         -- location string at all; the bare ELSE was claiming them for a
         -- place the employer never named. Same rule the family states for a
         -- department it cannot read: the gap is shown as a gap.
         CASE WHEN j.location ~* '\\yhybrid\\y' THEN 'hybrid'
              WHEN j.remote OR j.location ~* '\\yremote\\y' THEN 'remote'
              WHEN j.location IS NULL OR btrim(j.location) = '' THEN 'unstated'
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
         ${compTopSql('j.comp_posted')} AS comp_top,
         -- Carried into scope for match_pipeline below (db/218). base selects an
         -- explicit column list rather than j.*, so a column the CTE never
         -- names is invisible to every later stage: leaving this out made the
         -- board answer "column pipeline does not exist" -- a SCOPE error that
         -- reads exactly like a missing migration and sent me to check three
         -- databases that all had the column.
         j.pipeline
    FROM jobs j LEFT JOIN board_kills k ON k.id = j.kill_id
   WHERE (NOT $10::boolean OR j.status <> 'killed')
     AND ${textMatchSql(mode, { search: 'j.search', tc: 'j.search_tc', title: 'j.title' })}
),
scored AS (
  SELECT b.*,
         CASE WHEN age_days IS NULL THEN 'unknown' WHEN age_days <= $2 THEN 'fresh' ELSE 'older' END AS facet_freshness,
         ${textMatchSql(mode, { search: 'b.search', tc: 'b.search_tc', title: 'b.title' })} AS match_q,
         ${mode.kind === 'fuzzy' ? FUZZY_SCORE_SQL : 'NULL::float8'} AS text_sim
    FROM base b
),
matched AS (
  SELECT s.*,
         -- ONE ARRANGEMENT PREDICATE, TWO WAYS TO SET IT. $4 is the old single
         -- value and $14 the list; resolveArrangement() binds at most one of
         -- them (the other is 'all' / NULL), so this is never an intersection of
         -- two answers to one question.
         (($4::text = 'all' OR facet_location = $4::text)
           AND ($14::text[] IS NULL OR facet_location = ANY($14::text[]))) AS match_location,
         ($5::text = 'all' OR facet_comp = $5::text)     AS match_comp,
         -- THE PAY FLOOR. $15 is in thousands; comp_min is in the posted
         -- currency's own units, so the floor is multiplied back. A posting with
         -- no numeric minimum has no figure to be at or above a floor, so it
         -- fails any floor that is set (the Desk's rule), which is also why the
         -- COALESCE: NULL >= 150000 is NULL, and a NULL here would be neither
         -- kept nor counted as left out. resolvePay() binds a floor only while
         -- no band and no not-listed is chosen.
         COALESCE($15::numeric IS NULL OR comp_min >= $15::numeric * 1000, false) AS match_pay,
         -- THE PLACE. The one key the filter names (country, then region, then
         -- city, each only when the key says it) must be among the keys the
         -- posting lists, so a posting is inside every place it lists. One that
         -- lists no place is inside none and fails any place that is set;
         -- 'unstated' is the one key that reaches it.
         ${placeMatchSql('$16', '$17', '$18')} AS match_place,
         ${companyMatchSql('$19')} AS match_company,
         ($6::text = 'all' OR facet_freshness = $6::text) AS match_freshness,
         (($7::int IS NULL AND $8::int IS NULL)
           OR (age_days IS NOT NULL
               AND ($7::int IS NULL OR age_days >= $7::int)
               AND ($8::int IS NULL OR age_days <= $8::int))) AS match_age,
         ($9::text IS NULL OR country = $9::text) AS match_country,
         (NOT $10::boolean OR status = 'live')     AS match_live,
         (NOT $11::boolean OR facet_comp <> 'not-listed') AS match_comp_present,
         -- The occupational family (src/lib/job-family.mjs, db/212). NULL means
         -- no family was chosen and the board is unnarrowed; a row whose own
         -- derived_fam is NULL is outside every chosen family, because it has no
         -- field to be inside of. Same rule the age strip states for a row with
         -- no measurable age.
         -- 'unplaced' is not a family id, it is the absence of one, so it is
         -- matched against NULL rather than looked up. A reader who picks
         -- Design AND Unplaced gets both, which is the only reading of that
         -- selection that is not a lie about one of them.
         ($12::text[] IS NULL
           OR derived_fam = ANY($12::text[])
           OR (derived_fam IS NULL AND 'unplaced' = ANY($12::text[]))) AS match_family,
         -- EVERGREEN TALENT POOLS (db/218, jobs.pipeline). Nothing sets this
         -- today: board-query.ts does not read it off the URL, so every caller
         -- passes 'all' and this is constant true, which is why it costs the
         -- board nothing and changes no count. It is here so the question
         -- "should pools be on the board" can be answered later against data
         -- already collected instead of a re-crawl of 2,999 boards.
         --
         -- NULL IS NOT FALSE. 'only' keeps rows a feed called a pool; 'exclude'
         -- keeps everything else INCLUDING rows whose feed never said, because
         -- "we do not know" must not be silently read as "it is not one" and
         -- drop 52,000 postings off the board.
         ($13::text = 'all'
           OR ($13::text = 'only' AND pipeline IS TRUE)
           OR ($13::text = 'exclude' AND pipeline IS NOT TRUE)) AS match_pipeline
    FROM scored s
)`;
}

/**
 * THE FIVE CONTROLS, and the match flags each one owns. A control is one thing
 * a reader can change (a select, a chip, the strip's family menu), and a count
 * printed on one of its options answers "how many rows would this leave if I
 * chose it instead", so it is taken with EVERY OTHER control applied and its
 * own left out. The pay control owns two flags because it has two generations of
 * input (the band select and the floor, see resolvePay), and leaving out only
 * one of them would count an option against the other's old answer.
 *
 * Written once as data so that every count, in every statement, is built from
 * the same table. A new control is one line here, and cannot be applied in the
 * rows and forgotten in the counts, which is the shape the age range's first
 * bug had.
 */
type Control = 'location' | 'pay' | 'freshness' | 'family' | 'place';
const CONTROL_FLAGS: Record<Control, string> = {
  location: 'match_location',
  pay: 'match_comp AND match_pay',
  freshness: 'match_freshness',
  family: 'match_family',
  place: 'match_place'
};
const CONTROLS = Object.keys(CONTROL_FLAGS) as Control[];

/** The flags that are NOT a control, so no count is taken without them: the
    search words, the age range, the company chip, and the caller's scope (the
    first four of the SCOPE flags below plus the watched titles). */
const SCOPE_FLAGS = ['match_live', 'match_country', 'match_comp_present', 'match_pipeline'];
const FIXED_FLAGS = ['match_q', 'match_age', 'match_company', ...SCOPE_FLAGS];

/**
 * The keep clause: every flag except the named control's. Always applied, and
 * never a control: the search words (a count is taken INSIDE them), the age
 * range (a filter the strip sets, with no options to count), the company chip,
 * and the scope the caller fixed (country, live only, has comp, pipeline, the
 * watched titles).
 */
function keepSql(titleClause: string, except?: Control | 'age'): string {
  const flags = FIXED_FLAGS.filter((flag) => !(except === 'age' && flag === 'match_age'));
  flags.push(titleClause);
  for (const control of CONTROLS) if (control !== except) flags.push(CONTROL_FLAGS[control]);
  return flags.join(' AND ');
}

/**
 * The rows the words matched on THIS board, whatever else the reader chose: the
 * caller's scope and nothing from the controls. It is the question "did the
 * words find anything", asked before deciding the words were a typo. Written
 * once because the rows' count and the age strip both ask it, and a strip that
 * decided differently from the table about which spelling it was showing would
 * draw one population above another.
 */
function textTotalFilter(titleClause: string): string {
  return `${SCOPE_FLAGS.join(' AND ')} AND ${titleClause}`;
}

/**
 * The count line: every option, leave-one-out, in one round trip. The age
 * range is in every keep clause: it is a filter every count respects, not an
 * option any count is taken without. The places are counted in the same
 * statement, as a JSON object over the same rows, because the countries are not
 * a fixed list of columns.
 *
 * EACH ROW'S FLAGS ARE COMPUTED ONCE (`flags AS MATERIALIZED`). This statement
 * has about forty count columns (sixteen since 2026-10-02, when the Field, pay
 * band and freshness counts went) and every one repeats the keep clause, and
 * `matched` is inlined, so without this every match_* expression was evaluated
 * once per column per row. That was cheap when match_q was an ILIKE on two short
 * strings and ruinous when it became `search @@ to_tsquery(...)`: forty parses
 * of the tsquery and forty detoasts of a multi-kilobyte vector per row. Measured
 * on 2026-10-02 for "engineer" (6,218 rows), the count statement took 162 ms
 * with the flags inlined.
 *
 * ONLY WHEN IT PAYS. On the bare board (no words, no control chosen) every flag
 * is a constant the planner folds away, and Postgres is faster inlining the CTE
 * into both of its readers (measured 103 ms against 135 ms for the 37,286-row
 * board): the tuples it would have to store and re-read cost more than the
 * expressions it would have saved. The moment a control is set that is no longer
 * true. A chosen arrangement keeps `facet_location` live, two regular
 * expressions on the location text, and inlined it was evaluated once per count
 * column per row: the bare board with three arrangements and a pay floor chosen
 * took 507 ms inlined and a fraction of that materialised. See needsFlags.
 *
 * It stays NARROW on purpose, and narrower than the flags themselves: each row
 * carries the four values the options read (facet_location, facet_comp, comp_min,
 * and the short place_countries string, not the place_keys array it is taken
 * from: match_place reads the array before this point and the flags need no
 * more of it; the freshness and family a row has are read only by their filters,
 * which are flags, so they are not carried), `keep_base` (every flag
 * that is not a control, folded to one boolean), `scope_ok`, and `miss`, one integer with a
 * bit set for each control the row FAILS. "Every control but this one" is then
 * `keep_base AND (miss & mask) = 0` for the mask that leaves this control's bit
 * out, one test where the five flags were five, which is what the forty-odd
 * count columns each repeat for every row. No row, no search vector, no
 * description. This is the lesson desk-agg.ts records for its own lane CTE: a
 * materialised CTE is only cheap while it holds the columns the statement needs
 * and not the row. A flag that is NULL (match_family is, for a row with no
 * family under a family filter that does not name `unplaced`) is a failure, and
 * is coalesced to one, because a NULL in `miss` would make every count NULL.
 */
function facetCountSql(mode: TextMode, titleClause: string, materialize: boolean): string {
  // "Every control but this one", over the folded flags: the bits of the other
  // controls must all be clear.
  const bit = (control: Control) => 1 << CONTROLS.indexOf(control);
  const allBits = (1 << CONTROLS.length) - 1;
  const keep = (except?: Control) => `keep_base AND (miss & ${except ? allBits & ~bit(except) : allBits}) = 0`;
  const on = (except: Control | undefined, extra = '') => `count(*) FILTER (WHERE ${keep(except)}${extra})::int`;
  // WHAT IS COUNTED IS WHAT THE PAGE DRAWS (2026-10-02). The strip's three controls
  // (Location, Remote, Comp), the total and the text total. This statement also
  // counted the Field (a column per family), the pay bands and freshness's three
  // answers, thirty-odd aggregates over every row that nothing read: the Field
  // links under the table were removed (d9bcd16), COMP became floors, and freshness
  // never had a control on the strip. The filters those counts described are
  // untouched: fam=, comp= and freshness= in an address still narrow the board, by
  // their match flags and their bits in `miss`. What it saved is measured in
  // docs/board-speed-plan.md and in the commit that made the change.
  const cols = [
    `${on(undefined)} AS total`,
    `count(*) FILTER (WHERE scope_ok)::int AS text_total`,
    `${on('location')} AS location_all`,
    `${on('location', " AND facet_location = 'remote'")} AS location_remote`,
    `${on('location', " AND facet_location = 'hybrid'")} AS location_hybrid`,
    `${on('location', " AND facet_location = 'onsite'")} AS location_onsite`,
    `${on('location', " AND facet_location = 'unstated'")} AS location_unstated`,
    // The pay control's two ends, the floors' "Any" and "Not listed" (readCounts
    // reads them as pay.any and pay.notListed). The bands between them are not
    // counted: COMP is floors now.
    `${on('pay')} AS comp_all`,
    `${on('pay', " AND facet_comp = 'not-listed'")} AS "comp_not-listed"`,
    // The pay floors, cumulative: "at least $150k" includes every posting at
    // $200k and over. Counted from comp_min, the figure the pay filter itself
    // reads, so a floor's count is the rows that floor returns. `any` and
    // `not listed` are comp_all and comp_not-listed above, the same two
    // expressions, and are read from them rather than counted twice: every
    // aggregate is a pass over every row.
    ...PAY_FLOORS_K.map((k) => `${on('pay', ` AND comp_min >= ${k * 1000}`)} AS pay_${k}`),
    // What the board shows with no place chosen: the Worldwide option's number.
    // It is NOT the countries and Not stated added up, now that a posting lists
    // every country it names and is counted under each.
    `${on('place')} AS place_all`,
    // The places, counted over everything but the place filter. A posting is
    // counted once under each country it lists (place_countries names each once),
    // and the empty string is the rows that list none (`place=unstated` reaches
    // them): the LEFT JOIN gives it one NULL, which is the '' entry. So each number
    // is exactly the rows its own filter returns, and the numbers add up to MORE
    // than the total whenever a posting lists two countries. NULL (not an empty
    // object) when no row qualifies.
    //
    // GROUPED FIRST, SPLIT AFTER (db/223). The rows are grouped by the short
    // place_countries string, 262 distinct values on the local board, and
    // only those groups are split into countries and summed. The first version
    // unnested place_keys of every row (2.87 keys a row) and kept the two letter
    // ones, 22 ms where grouping the old place_country column took 2: reading the
    // arrays was the cost, and flags no longer carries them.
    `(SELECT jsonb_object_agg(k, n)
        FROM (SELECT coalesce(u.c, '') AS k, sum(g.n)::int AS n
                FROM (SELECT place_countries, count(*)::int AS n FROM flags WHERE ${keep('place')} GROUP BY 1) g
                LEFT JOIN LATERAL unnest(string_to_array(nullif(g.place_countries, ''), ' ')) AS u(c) ON true
               GROUP BY 1) p) AS places`,
    // EVERY COUNTRY THE LIVE BOARD HOLDS, so a country the other filters leave
    // nothing is a zero in the list and not a missing row (readCounts adds the
    // zeros). It cannot come from `flags`: the search words are in the CTE's
    // WHERE as well as in match_q, so under words `flags` holds only the rows
    // the words found. It is a list of NAMES, not a count, so it is read straight
    // off the table and takes no part in any number: every count above still comes
    // from the one CTE. One probe of the GIN index on place_keys per ISO code
    // (PLACE_UNIVERSE_SQL): 4.2 ms at the median (40 runs, local, 2026-10-02) for
    // the 109 countries the board holds, where a DISTINCT over unnest(place_keys)
    // reads every key of every row and took 24 ms. (The recursive skip this
    // replaced took 0.6 ms on place_country, which is a btree; an array has no
    // order to skip along, and a GIN index only answers a bitmap scan, so a
    // country as common as the US reads its whole posting list.) The literal
    // status <> 'killed' is what lets Postgres use the partial index.
    `${PLACE_UNIVERSE_SQL} AS place_universe`
  ];
  return `${boardFacetCte(mode)}
, flags AS ${materialize ? 'MATERIALIZED' : 'NOT MATERIALIZED'} (
  SELECT facet_location, facet_comp, comp_min, place_countries,
         COALESCE(${[...SCOPE_FLAGS, titleClause].join(' AND ')}, false) AS scope_ok,
         COALESCE(${[...FIXED_FLAGS, titleClause].join(' AND ')}, false) AS keep_base,
         (${CONTROLS.map((c) => `(NOT COALESCE(${CONTROL_FLAGS[c]}, false))::int * ${bit(c)}`).join(' + ')}) AS miss
    FROM matched
)
SELECT ${cols.join(',\n       ')}
  FROM flags`;
}

/* ---- the search words (2026-10-02) ---------------------------------------- *
 *
 * WHAT THIS REPLACED. `title ILIKE '%q%' OR company ILIKE '%q%'`: no index (every
 * search read all 37,000 rows, 285 to 340 ms locally with any words typed), no
 * ranking, no tolerance of a typo, and no way to find a word that is in the
 * description. It now reads jobs.search, the weighted tsvector db/219 builds
 * (title A, company B, department C, description D), through its GIN index.
 *
 * THE WORDS ARE TURNED INTO A TSQUERY HERE, NOT BY POSTGRES. to_tsquery() has an
 * operator syntax (`& | ! ( ) : *`) and a reader's text must never reach it as
 * syntax: "c++ & (java" would be a parse error and "a:*b" a surprise. So the
 * text is taken apart in TypeScript and put back together from QUOTED lexemes
 * only. Inside quotes the only two characters that mean anything are the quote
 * and the backslash, and both are escaped; everything else is inert. The result
 * is bound as ONE parameter ($3) and handed to to_tsquery('simple', $3), which
 * runs the lexeme through the same text parser that built the vector, so the
 * two sides tokenise one way.
 *
 * WHY WHOLE CHUNKS AND NOT ONLY WORDS. Postgres's parser does not split on every
 * punctuation mark. It keeps `node.js`, `asp.net`, `ai/ml`, `u.s` and `v2.0` as
 * single lexemes, and indexes `full-stack` as the whole AND its parts. 3,947 of
 * the 37,286 live titles (10.6%) carry a dot or slash between letters. A query
 * split on every non-letter looks for `ai` and `ml` and finds neither, because
 * the vector holds `ai/ml`: the title typed in full would not find itself. So a
 * chunk with punctuation inside is offered both ways, as the lexeme Postgres
 * would index it as and as the AND of its parts.
 *
 * EACH WORD IS EITHER A WHOLE WORD ANYWHERE, OR A PREFIX OF A WORD IN THE TITLE
 * OR COMPANY. The prefix is restricted to weights A and B (`:*AB`) on purpose: a
 * bare `desi:*` matched 12,644 live rows through "desired" in descriptions. A
 * prefix is what a person typing "desi" means, and what they mean it to find is
 * a title. A word shorter than three letters is whole-word only (a two letter
 * prefix is almost any word).
 */

/** Words read from the box: past this the rest is dropped. Every extra word is
    an AND that can only narrow, and each is up to three alternatives for the
    planner to cost. */
export const SEARCH_MAX_WORDS = 10;
/** The shortest word that is searched (see buildSearchQuery for the one exception). */
const SEARCH_MIN_WORD = 2;
/** The shortest word that may also match as a PREFIX of a title or company word. */
const SEARCH_PREFIX_MIN = 3;
/** The shortest word the typo path will correct. Four letters and under are
    matched exactly: a trigram says almost nothing about a word that short. */
export const FUZZY_MIN_WORD = 5;
/** The typo path's per-word trigram threshold. See FUZZY_SCORE_SQL. */
export const FUZZY_WORD_THRESHOLD = 0.3;

/** Letters Unicode does not take apart into a base and a mark, folded the way
    unaccent.rules folds them (the stroked and ligature letters of the languages
    on this board). Applied after lower-casing. */
const FOLD_LETTERS: Record<string, string> = {
  ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ð: 'd', þ: 'th', đ: 'd', ł: 'l', ħ: 'h', ŧ: 't', ŋ: 'n', ı: 'i', ĳ: 'ij', ŀ: 'l', ĸ: 'q', ſ: 's', ŉ: "'n"
};

/**
 * Text as jobs.search holds it: lower case, with accents folded the way
 * f_unaccent folds them. Nothing else is changed: where words begin and end is
 * decided afterwards, by buildSearchQuery, and by Postgres's own parser on the
 * other side.
 *
 * WHY THIS IS NOT search-parse's normalisePhrase. That one is the box's
 * dictionary key, and it strips EVERY combining mark and normalises to NFD, which
 * is right for matching a typed "Malmo" to "Malmö" and wrong here. The vector was
 * folded by Postgres's unaccent, which is narrower: it strips accents from Latin
 * and Greek letters and leaves everything else alone. Measured on 2026-10-02
 * against every non-ASCII character in the board's titles, companies and
 * departments, normalisePhrase disagreed with the vector on 62 of 382, and the
 * ones that are letters were Russian й (unaccent keeps it, NFD splits it), every
 * Hangul syllable (NFD takes them apart into jamo) and every Japanese kana with
 * a voicing mark (パ becomes ハ). A query that folds one way against a vector
 * that folded another finds nothing, silently, in three whole languages.
 *
 * So: strip combining marks U+0300 to U+036F, but only where they follow a Latin
 * or Greek letter, then put the text back together (NFC), so a syllable or a
 * kana the marks were never stripped from is whole again. The test file checks
 * this against f_unaccent on every character the board holds.
 *
 * Control, format and surrogate characters (a NUL, a zero-width joiner, half of a
 * broken emoji) become spaces first. A NUL cannot be sent to Postgres at all.
 */
export function foldForSearch(text: string): string {
  return String(text ?? '')
    .slice(0, SEARCH_MAX_CHARS)
    .replace(/\p{C}/gu, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/([\p{Script=Latin}\p{Script=Greek}])[\u0300-\u036f]+/gu, '$1')
    .normalize('NFC')
    .replace(/[ßæœøðþđłħŧŋıĳŀĸſŉ]/g, (c) => FOLD_LETTERS[c] ?? c)
    .replace(/[\uff10-\uff19\uff41-\uff5a]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** A letter, a combining mark or a digit in any script: what a WORD is made of. */
const WORD_CHAR = '\\p{L}\\p{N}\\p{M}';
const NON_WORD_EDGES = new RegExp(`^[^${WORD_CHAR}]+|[^${WORD_CHAR}]+$`, 'gu');
const NON_WORD_RUN = new RegExp(`[^${WORD_CHAR}]+`, 'u');

/** One lexeme, quoted for to_tsquery: the quote doubled, the backslash escaped. */
function lexeme(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** Which weights a lexeme may match in: the whole vector, or a restriction to the
    title (A), title and company (AB), or title, company and department (ABC). */
type Weights = 'all' | 'A' | 'AB' | 'ABC';

/** One word as a tsquery operand under a weight restriction. */
function wordAtom(word: string, weights: Weights): string {
  const long = [...word].length >= SEARCH_PREFIX_MIN;
  if (weights === 'all') return long ? `(${lexeme(word)} | ${lexeme(word)}:*AB)` : lexeme(word);
  return long ? `${lexeme(word)}:*${weights}` : `${lexeme(word)}:${weights}`;
}

/** A chunk with punctuation inside: the lexeme Postgres would index it as (and
    its prefix), or all of its parts. See the block comment above. */
function compoundAtom(whole: string, parts: readonly string[], weights: Weights): string {
  const w = weights === 'all' ? 'AB' : weights;
  const alternatives = [weights === 'all' ? lexeme(whole) : '', `${lexeme(whole)}:*${w}`].filter(Boolean);
  const kept = parts.filter((part) => [...part].length >= SEARCH_MIN_WORD);
  if (kept.length > 0) alternatives.push(`(${kept.map((part) => wordAtom(part, weights)).join(' & ')})`);
  return `(${alternatives.join(' | ')})`;
}

/* ---- the match as a tree: TWO INDEXES, ONE PREDICATE (db/221) ---------------- *
 *
 * `all` above is one tsquery, `('w' | 'w':*AB) & ...`, and it is still what ranks
 * a row (ts_rank_cd reads it against the whole vector) and what names a set of
 * words. It is no longer what FINDS the rows, because of the weights. A GIN
 * index stores a lexeme and the rows that carry it, not the weight each carries
 * it at, so `des:*AB` made the index name every row with ANY word starting "des"
 * (17,775 of 37,286 live rows, almost all through "description" or "designed" in
 * a posting) and Postgres then read each row's multi-kilobyte vector to keep the
 * 773 whose match was in the title or company. That read, not the index, was the
 * cost.
 *
 * db/221 adds jobs.search_tc, the title and company alone, which are the only
 * weights a prefix may match. A prefix in it needs no weight to say so, so the
 * index on it is exact and its vectors are a few words each. The match is then
 * the same set of rows written as a boolean over the two vectors:
 *
 *     ('w' | 'w':*AB) on search   =   search @@ 'w'  OR  search_tc @@ 'w':*
 *
 * and it is exact, not approximate: `search_tc` is the A and B part of `search`
 * with the same positions (the same function builds both, so no phrase can span
 * a gap that is not also in the other), so each alternative of the old query
 * finds the same rows through the new vector. OR and AND carry across `@@` when
 * the query has no NOT, and this one never does. The test file proves it row for
 * row over the board for the words it uses, against `all`.
 *
 * WHY A TREE AND NOT TWO TSQUERIES. One tsquery is one index: `(a | b) & (c | d)`
 * over two columns cannot be split into one query per column, because the OR sits
 * inside the AND. As SQL the planner sees the same shape it knows how to
 * cost, a BitmapOr of the two indexes for each word and a BitmapAnd across
 * words, and each word's two probes are the cheap ones (the prefix in a small
 * index, the whole word in the big one).
 *
 * THE PARAMETERS. Every distinct tsquery in the tree is bound as its own
 * parameter, from $20 on (compileMatch), so the planner sees a constant for each
 * and estimates from it, as it did for the one tsquery before. The tests pin the
 * text of the statement and the values together.
 */

/** One test a word is made of: a tsquery, run against one of the two vectors. */
interface MatchLeaf {
  /** `search`: the whole vector, for a whole word anywhere. `tc`: jobs.search_tc,
      title and company only, for a prefix. */
  vector: 'search' | 'tc';
  query: string;
}
/** The words as the boolean they are: tests joined by AND and OR and nothing else. */
export type MatchNode = MatchLeaf | { op: 'and' | 'or'; of: MatchNode[] };

const exactLeaf = (word: string): MatchLeaf => ({ vector: 'search', query: lexeme(word) });
const prefixLeaf = (word: string): MatchLeaf => ({ vector: 'tc', query: `${lexeme(word)}:*` });

/** One word as wordAtom('all') writes it: a whole word anywhere, or (three letters
    and over) a prefix in the title or company. The prefix is written first because
    it is the cheap one to read: a few words, where the other detoasts a posting. */
function wordNode(word: string): MatchNode {
  return [...word].length >= SEARCH_PREFIX_MIN ? { op: 'or', of: [prefixLeaf(word), exactLeaf(word)] } : exactLeaf(word);
}

/** A chunk with punctuation inside, as compoundAtom('all') writes it: the whole as
    one lexeme, or as a prefix, or all of its parts. */
function compoundNode(whole: string, parts: readonly string[]): MatchNode {
  const of: MatchNode[] = [prefixLeaf(whole), exactLeaf(whole)];
  const kept = parts.filter((part) => [...part].length >= SEARCH_MIN_WORD);
  if (kept.length > 0) of.push({ op: 'and', of: kept.map(wordNode) });
  return { op: 'or', of };
}

/** The names a statement gives the two vectors in the scope the match is written into. */
export interface VectorRefs {
  search: string;
  tc: string;
}

/** A match ready to write into a statement: the tsqueries it binds, in order, and
    its text for the vectors the statement calls by whatever names. */
export interface CompiledMatch {
  /** One per DISTINCT tsquery, bound from the number the match was compiled at. */
  params: string[];
  sql: (refs: VectorRefs) => string;
}

/** Numbers the tree's tsqueries from `first` and returns the SQL that reads them.
    Numbered in one walk, so the text and the parameters cannot disagree.
    Exported for the test that holds it to `all` over every row of the board. */
export function compileMatch(node: MatchNode, first: number): CompiledMatch {
  const params: string[] = [];
  const numbered = new Map<MatchLeaf, number>();
  const walk = (n: MatchNode): void => {
    if ('op' in n) {
      n.of.forEach(walk);
      return;
    }
    const held = params.indexOf(n.query);
    numbered.set(n, first + (held >= 0 ? held : params.push(n.query) - 1));
  };
  walk(node);
  const write = (n: MatchNode, refs: VectorRefs): string =>
    'op' in n
      ? n.of.length === 1
        ? write(n.of[0] as MatchNode, refs)
        : `(${n.of.map((x) => write(x, refs)).join(n.op === 'and' ? '\n       AND ' : ' OR ')})`
      : `${refs[n.vector]} @@ to_tsquery('simple', $${numbered.get(n)}::text)`;
  return { params, sql: (refs) => write(node, refs) };
}

export interface SearchQuery {
  /** The folded text, in words: the parts of every chunk, in order, one space
      between. What a title is compared to for the "title is the words" tier. */
  phrase: string;
  /** The words as one tsquery: every word, anywhere or as a title/company
      prefix. Bound as $3. It ranks a row and names a set of words; the rows are
      FOUND by `match`, which is this same predicate written for the two vectors. */
  all: string;
  /** `all` as a boolean over the two vectors (see "TWO INDEXES, ONE PREDICATE"). */
  match: MatchNode;
  /** The same words restricted to the title, to the title and company, and to
      title, company and department: the three rungs of the tier ladder. */
  a: string;
  ab: string;
  abc: string;
  /** The typo path's inputs, or null when no word is long enough to correct.
      `tokens` must each be word-similar to the title; `short` (or null) is a
      tsquery for the words too short to misspell, matched as title prefixes. */
  fuzzy: { tokens: readonly string[]; short: string | null } | null;
}

/**
 * The search box's words as the queries the store runs, or null when the text
 * holds no word at all (empty, or only punctuation).
 *
 * A word of one letter is dropped, so "a designer" is "designer", EXCEPT when
 * that would leave nothing: "c" and "r" are languages, and a box that answered
 * them with the whole board unnarrowed would be lying. Those are kept as
 * whole-word matches. At most SEARCH_MAX_WORDS chunks are read, each repeated
 * word once.
 */
export function buildSearchQuery(text: string): SearchQuery | null {
  const folded = foldForSearch(text);
  interface Chunk { core: string; parts: string[]; compound: boolean }
  const seen = new Set<string>();
  const chunks: Chunk[] = [];
  for (const raw of folded.split(/\s+/)) {
    const core = raw.replace(NON_WORD_EDGES, '');
    if (core === '' || seen.has(core)) continue;
    seen.add(core);
    const parts = core.split(NON_WORD_RUN).filter(Boolean);
    chunks.push({ core, parts, compound: parts.length > 1 });
    if (chunks.length >= SEARCH_MAX_WORDS) break;
  }
  if (chunks.length === 0) return null;

  const worthSearching = chunks.filter((c) => c.compound || [...c.core].length >= SEARCH_MIN_WORD);
  const kept = worthSearching.length > 0 ? worthSearching : chunks;
  const atoms = (weights: Weights) =>
    kept.map((c) => (c.compound ? compoundAtom(c.core, c.parts, weights) : wordAtom(c.core, weights))).join(' & ');

  // The typo path reads the words, never the chunks: it is correcting spelling,
  // and punctuation is not spelled wrong.
  const words = chunks.flatMap((c) => c.parts);
  const unique = [...new Set(words)];
  const tokens = unique.filter((w) => [...w].length >= FUZZY_MIN_WORD);
  const shorts = unique.filter((w) => [...w].length >= SEARCH_MIN_WORD && [...w].length < FUZZY_MIN_WORD);
  return {
    phrase: words.join(' '),
    all: atoms('all'),
    match: { op: 'and', of: kept.map((c) => (c.compound ? compoundNode(c.core, c.parts) : wordNode(c.core))) },
    a: atoms('A'),
    ab: atoms('AB'),
    abc: atoms('ABC'),
    fuzzy:
      tokens.length > 0
        ? { tokens, short: shorts.length > 0 ? shorts.map((w) => `${lexeme(w)}:*A`).join(' & ') : null }
        : null
  };
}

/**
 * The text predicate's three forms (see boardFacetCte). `refs` names the columns
 * in the statement's scope, because the same predicate is written once for
 * base's WHERE and once for match_q.
 */
type TextMode =
  | { kind: 'exact'; match: CompiledMatch | null }
  | { kind: 'title' }
  | { kind: 'fuzzy'; tokens: number };

/** Exact mode with no words in the shared part: $3 is NULL, nothing is matched. */
const NO_WORDS: TextMode = { kind: 'exact', match: null };

/** The typo path's first per-word parameter; $20 is its short-word tsquery. */
const FUZZY_PARAM_SHORT = 20;
const FUZZY_PARAM_FIRST = 21;

function textMatchSql(mode: TextMode, refs: VectorRefs & { title: string }): string {
  if (mode.kind === 'exact') {
    // $3 is always named, so Postgres can type it, and it is NULL (no words) or ''
    // (words that are only punctuation, which match nothing) when there is no tree.
    return mode.match === null
      ? `($3::text IS NULL)`
      : `($3::text IS NULL OR ($3::text <> '' AND ${mode.match.sql(refs)}))`;
  }
  if (mode.kind === 'title') {
    return `($3::text IS NULL OR ($3::text <> '' AND ${refs.tc} @@ to_tsquery('simple', $3::text)))`;
  }
  const words = Array.from({ length: mode.tokens }, (_, i) => `$${FUZZY_PARAM_FIRST + i}::text <% ${refs.title}`);
  return `(${words.join(' AND ')}
     AND ($${FUZZY_PARAM_SHORT}::text IS NULL OR ${refs.search} @@ to_tsquery('simple', $${FUZZY_PARAM_SHORT}::text)))`;
}

/**
 * THE TYPO PATH, AND WHY IT IS BUILT THIS WAY. It runs only when the words match
 * nothing exactly, and it answers "which titles are spelled like this".
 *
 * EVERY LONG WORD MUST BE SIMILAR, NOT THE PHRASE. The obvious form,
 * word_similarity(whole query, title) >= T, ranks by trigram sets and not by
 * words: measured on 2026-10-02, "marketng manager" at 0.5 returned 4,753 rows,
 * because every title with "manager" in it is half the query. Asking each word
 * of five letters or more to be word-similar to the title on its own
 * (`'marketng' <% title AND 'manager' <% title`) keeps the recall and drops the
 * noise: 659 rows at the threshold below, the first of them "Marketing Manager".
 * Words of four letters or fewer are matched exactly, as title prefixes, in the
 * same statement: a trigram says almost nothing about a word that short.
 *
 * THE THRESHOLD IS 0.3 PER WORD. Measured over 499 seeded queries, each the
 * first three words of a live title with one letter of one long word deleted,
 * swapped, replaced or inserted, scored by whether a posting with the ORIGINAL
 * title is in the results at all and in the first ten:
 *
 *     threshold   found   in the top 10   median / 90th percentile rows
 *        0.60      45.5%       39.5%             0 / 48    (pg_trgm's default)
 *        0.50      80.2%       68.7%             3 / 107
 *        0.40      90.8%       78.8%             6 / 126
 *        0.35      93.8%       81.2%             8 / 133
 *        0.30      96.8%       82.8%            11 / 150
 *        0.25      97.4%       83.4%            20 / 218
 *
 * 0.30 is where the curve flattens: the next step buys 0.6 points of recall for
 * twice the median result. Because every long word must clear it on its own, a
 * loose per-word threshold does not mean loose results (gibberish such as "xqzvw
 * rkt" matches nothing). What it does not find is a TRANSPOSITION: "pyhton"
 * scores 0.27 against "python", and a trigram cannot see that two letters
 * swapped; an edit distance would. The threshold is applied by the `<%`
 * operator through jobs_title_trgm_idx and is set for the transaction by
 * withTrigramThreshold, because the operator reads it from a setting, not from
 * an argument.
 *
 * THE ORDER IS THE MEAN OF TWO SIMILARITIES. word_similarity asks how well the
 * query covers a stretch of the title and similarity asks how much of the title
 * the query accounts for, so a short title that is the query spelled wrongly
 * beats a long title that merely contains it. word_similarity alone put "People
 * Business Partner, Product & Design" first for "prodct desiner" and "Program
 * Manager, Marketplace Growth" first for "marketng manager". The blend puts
 * "Product Designer" and "Marketing Manager" first, and on the same 499 queries
 * took the right title to first place 60.3% of the time (51.3% for
 * word_similarity alone) and into the first ten 82.8% (81.0%). Rounded to three
 * places so that a tie is a tie, which is also what fuzzy_score reports.
 */
const FUZZY_SCORE_SQL = `round(((word_similarity($3::text, b.title) + similarity($3::text, b.title)) / 2)::numeric, 3)::float8`;

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

/** Anything that can run a statement: the pool, or one connection of it. */
interface Queryable {
  // Rows are read through the field names this file wrote into the SQL.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

/** What the statements below need from a board filter, whichever of the two
    entry points it came through (the age strip takes no range, no sort, no page). */
type SharedInput = Pick<BoardFilter, 'sweepDate'> &
  Partial<
    Pick<
      BoardFilter,
      'location' | 'comp' | 'freshness' | 'country' | 'liveOnly' | 'hasComp' | 'families' | 'pipeline' | 'remote' | 'payMin' | 'compNotListed' | 'place' | 'company'
    >
  >;

/**
 * THE ARRANGEMENT HAS ONE ANSWER. A caller may hold the old single value
 * (`location`) or the new list (`remote`), and the page passes both, since the
 * query mirrors one into the other. The list wins when it has anything in it
 * and the single value is then bound as `all`, so the two can never be ANDed
 * into an answer neither of them gave. Unknown kinds are dropped here as well:
 * this file does not rely on its caller having read the address through
 * board-query.ts.
 */
function resolveArrangement(f: Pick<SharedInput, 'location' | 'remote'>): { location: string; remote: string[] | null } {
  const kinds = [...new Set((f.remote ?? []).filter((k) => ['remote', 'hybrid', 'onsite', 'unstated'].includes(k)))];
  return kinds.length > 0 ? { location: 'all', remote: kinds } : { location: f.location ?? 'all', remote: null };
}

/**
 * THE PAY FILTER HAS ONE ANSWER TOO, in this order: no stated pay, then a band,
 * then a floor. `compNotListed` is exclusive with a floor by definition (a
 * posting cannot state a figure and not state one), and it is read as the
 * `not-listed` band, which is the same rows (facet_comp). A band outranks a
 * floor because the band select is still the live control while the strip has
 * bands: its per-band counts are exact only if the band is applied exactly, and
 * board-query.ts reads a legacy `comp=` into BOTH fields. Once the strip offers
 * floors nothing sets a band and this order is simply never reached.
 */
function resolvePay(f: Pick<SharedInput, 'comp' | 'payMin' | 'compNotListed'>): { comp: string; payMin: number | null } {
  if (f.compNotListed) return { comp: 'not-listed', payMin: null };
  const comp = f.comp ?? 'all';
  if (comp !== 'all') return { comp, payMin: null };
  const floor = f.payMin;
  return { comp, payMin: typeof floor === 'number' && Number.isFinite(floor) && floor > 0 ? floor : null };
}

/**
 * A place filter as the statements bind it: the country, region and city (each
 * null where the key stops short of it), or null when no place is chosen. The one
 * reader of BoardFilter.place, so a statement cannot take `unstated` for "no
 * place" the way parsePlaceKey alone would, nor drop it. `unstated` is bound as
 * the country, as the literal placeMatchSql tests for; a key that is not a place
 * at all is dropped, as it always was.
 */
function placeBinding(place: string | null | undefined): { country: string; admin1: string | null; city: string | null } | null {
  if (isPlaceUnstated(place)) return { country: PLACE_UNSTATED, admin1: null, city: null };
  return parsePlaceKey(place ?? null);
}

/** Parameters $1 to $19 of the CTE, in order. `text` is $3: see boardFacetCte. */
function sharedParams(f: SharedInput, text: string | null, age: { min: number | null; max: number | null }): unknown[] {
  const arrangement = resolveArrangement(f);
  const pay = resolvePay(f);
  const place = placeBinding(f.place);
  const company = f.company?.trim();
  return [
    f.sweepDate, FRESH_WINDOW_DAYS_SQL, text, arrangement.location, pay.comp, f.freshness ?? 'all',
    age.min, age.max, f.country ?? null, f.liveOnly ?? true, f.hasComp ?? false,
    f.families && f.families.length > 0 ? f.families : null,
    f.pipeline ?? 'all',
    arrangement.remote, pay.payMin, place?.country ?? null, place?.admin1 ?? null, place?.city ?? null,
    company ? company : null
  ];
}

/** What the reader's words are, before any statement is run. */
type TextPlan = { kind: 'none' } | { kind: 'nomatch' } | { kind: 'words'; sq: SearchQuery };

/**
 * `none`: no words, no text filter. `words`: a query to run. `nomatch`: text
 * that holds no word at all (only punctuation), which matches nothing rather
 * than everything: a box that shows "!!!" above the whole unfiltered board has
 * answered a question nobody asked.
 */
function planText(q: string | undefined): TextPlan {
  const text = (q ?? '').trim();
  if (text === '') return { kind: 'none' };
  const sq = buildSearchQuery(text);
  return sq ? { kind: 'words', sq } : { kind: 'nomatch' };
}

/** One text mode, bound: its parameters, its mode and the watched-titles clause
    that has to number itself after however many parameters the mode took. */
interface Setup {
  mode: TextMode;
  /** Whether the count statement stores its per-row flags once; see facetCountSql. */
  materialize: boolean;
  shared: unknown[];
  titleClause: string;
  titleParams: string[];
}

/**
 * Is anything in this request more than a constant to Postgres? Words, or any
 * control the reader has set. When it is, the count statement stores each row's
 * flags once (facetCountSql); when it is not, it does not. `titles` and the
 * scope (country, has comp, pipeline) are cheap comparisons and do not count.
 */
function needsFlags(f: SharedInput, hasText: boolean, age: { min: number | null; max: number | null }): boolean {
  const arrangement = resolveArrangement(f);
  const pay = resolvePay(f);
  return (
    hasText ||
    arrangement.location !== 'all' ||
    arrangement.remote !== null ||
    pay.comp !== 'all' ||
    pay.payMin !== null ||
    (f.freshness ?? 'all') !== 'all' ||
    age.min !== null ||
    age.max !== null ||
    Boolean(f.families && f.families.length > 0) ||
    placeBinding(f.place) !== null ||
    Boolean(f.company?.trim())
  );
}

function setupExact(f: SharedInput, titles: string[] | undefined, plan: TextPlan, age: { min: number | null; max: number | null }): Setup {
  const text = plan.kind === 'words' ? plan.sq.all : plan.kind === 'nomatch' ? '' : null;
  const shared = sharedParams(f, text, age);
  // The words' tsqueries follow the nineteen shared parameters, each its own.
  const match = plan.kind === 'words' ? compileMatch(plan.sq.match, shared.length + 1) : null;
  if (match) shared.push(...match.params);
  const { clause, params } = titleKeepClause(titles, shared.length + 1);
  return { mode: { kind: 'exact', match }, materialize: needsFlags(f, plan.kind !== 'none', age), shared, titleClause: clause, titleParams: params };
}

function setupFuzzy(f: SharedInput, titles: string[] | undefined, sq: SearchQuery & { fuzzy: NonNullable<SearchQuery['fuzzy']> }, age: { min: number | null; max: number | null }): Setup {
  const shared = sharedParams(f, sq.phrase, age);
  shared.push(sq.fuzzy.short, ...sq.fuzzy.tokens);
  const { clause, params } = titleKeepClause(titles, shared.length + 1);
  return { mode: { kind: 'fuzzy', tokens: sq.fuzzy.tokens.length }, materialize: true, shared, titleClause: clause, titleParams: params };
}

/**
 * Run work with pg_trgm's word-similarity threshold set for the transaction.
 * The `<%` operator takes its threshold from a setting, not an argument, and a
 * pooled connection is shared, so it is set with set_config(..., true) (local to
 * the transaction, bound as a parameter) inside BEGIN and COMMIT on ONE
 * connection, and everything that has to agree about the threshold runs on it,
 * one statement after another. Only the typo path pays for this.
 */
async function withTrigramThreshold<T>(work: (conn: Queryable) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('pg_trgm.word_similarity_threshold', $1, true)`, [String(FUZZY_WORD_THRESHOLD)]);
    const out = await work(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * random_page_cost FOR A STATEMENT THAT CARRIES WORDS, AND WHY (db/221).
 *
 * The planner chooses between the two GIN indexes and a scan of the table by
 * cost, and it prices `search @@ 'w'` as one cheap operator. It is not: the
 * vector is a 4.5 KB value kept out of line, and a scan that evaluates it reads
 * and decompresses one per row it did not already reject, which is what made
 * every seq-scan plan of these statements slow (measured on 2026-10-02, 37,765
 * rows: 100 to 250 ms for a count that took 12 to 17 ms through the indexes).
 * The choice is a near tie at a word that a sixth of the board carries
 * ("engineer": a bitmap plan costed 11,786 and the seq scan 11,730), so the
 * planner flipped between the two from one statistics refresh to the next, and
 * the OR of two predicates overstates the rows (10,252 estimated, 6,218 real:
 * the estimate multiplies two probabilities that are nearly one event).
 * (db/221's own header has the same facts for whoever reads the migration.)
 *
 * The default random_page_cost of 4 prices a fetch of 3,000 scattered heap
 * pages four times a sequential read of the same table, which is a rotating
 * disk's arithmetic. With 1.1 (what a table that is mostly in memory, or on SSD,
 * is usually given) the indexes win through about half the board, and the seq
 * scan still wins for a word nearly every row carries, where it should. It is
 * set with set_config(..., true) inside BEGIN and COMMIT, as withTrigramThreshold
 * does, so it ends with the statement, and only the statements that carry words
 * pay the three round trips: a board with no words, the typo path and every
 * other reader of this table plan as they always did.
 *
 * What it bought, local and warm, alternating old and new in one process on
 * 2026-10-02 (p50, ms): the board for "engineer" 190 to 58, "des" 142 to 33,
 * "product des" 125 to 18; the suggestion panel's cold "des" 268 to 37 and
 * "engineer" 270 to 91; the existence probe of the typo path ("desginer") 118 to
 * 1.8, which the same plan choice had made a scan of every vector. Whether
 * Neon's planner makes the same near-tie choice, or its storage prices a random
 * page as the default says, was not measured: these are local numbers.
 */
const WORDS_RANDOM_PAGE_COST = '1.1';

/** Does this mode's statement carry words that a GIN index can answer? */
function plansForWords(mode: TextMode): boolean {
  return mode.kind === 'title' || (mode.kind === 'exact' && mode.match !== null);
}

/** Run a statement, under WORDS_RANDOM_PAGE_COST when `forWords`. `conn` is the
    pool for such a statement (the typo path's connection is already in its own
    transaction and carries no GIN words). */
async function runStatement(conn: Queryable, forWords: boolean, sql: string, params: unknown[]): Promise<{ rows: any[] }> {
  const pool = conn as Queryable & { connect?: () => Promise<Queryable & { release: () => void }> };
  if (!forWords || typeof pool.connect !== 'function') return conn.query(sql, params);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('random_page_cost', $1, true)`, [WORDS_RANDOM_PAGE_COST]);
    const out = await client.query(sql, params);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The rows the words matched on this board, ignoring every control. */
async function readTextTotal(conn: Queryable, setup: Setup): Promise<number> {
  const { rows } = await runStatement(
    conn,
    plansForWords(setup.mode),
    `${boardFacetCte(setup.mode)}\nSELECT count(*) FILTER (WHERE ${textTotalFilter(setup.titleClause)})::int AS text_total FROM matched`,
    [...setup.shared, ...setup.titleParams]
  );
  return Number(rows[0]?.text_total ?? 0);
}

/** Do the words match ANY row on this board, ignoring every control? The same
    question readTextTotal answers with a count, asked as EXISTS so it ends at the
    first row: a prefix that thousands of rows share is otherwise read out of every
    one of their vectors to learn that it is not zero. */
async function readTextMatches(conn: Queryable, setup: Setup): Promise<boolean> {
  const { rows } = await runStatement(
    conn,
    plansForWords(setup.mode),
    `${boardFacetCte(setup.mode)}\nSELECT EXISTS (SELECT 1 FROM matched WHERE ${textTotalFilter(setup.titleClause)}) AS found`,
    [...setup.shared, ...setup.titleParams]
  );
  return rows[0]?.found === true;
}

async function readCounts(conn: Queryable, setup: Setup): Promise<{ counts: FacetCounts; textTotal: number }> {
  const { rows } = await runStatement(conn, plansForWords(setup.mode), facetCountSql(setup.mode, setup.titleClause, setup.materialize), [...setup.shared, ...setup.titleParams]);
  const c: Record<string, number> = rows[0] ?? {};
  // The places arrive as one JSON object (see facetCountSql); '' is "no country".
  const countries: Record<string, number> = {};
  let notStated = 0;
  for (const [country, n] of Object.entries((rows[0]?.places ?? {}) as Record<string, number>)) {
    if (country === '') notStated += Number(n) || 0;
    else countries[country] = Number(n) || 0;
  }
  // Then every country the live board holds that the filters left nothing in, at
  // zero: counted ones are never overwritten, so a zero only ever fills a gap.
  for (const country of (rows[0]?.place_universe ?? []) as string[]) {
    if (!(country in countries)) countries[country] = 0;
  }
  const location = {
    all: c.location_all ?? 0,
    remote: c.location_remote ?? 0,
    hybrid: c.location_hybrid ?? 0,
    onsite: c.location_onsite ?? 0,
    unstated: c.location_unstated ?? 0
  };
  return {
    textTotal: Number(c.text_total ?? 0),
    counts: {
      total: c.total ?? 0,
      location,
      // The same five numbers under their new name, copied from the one
      // expression rather than counted twice, so they cannot differ.
      remote: { ...location },
      pay: {
        any: c.comp_all ?? 0,
        notListed: c['comp_not-listed'] ?? 0,
        floors: Object.fromEntries(PAY_FLOORS_K.map((k) => [String(k), c[`pay_${k}`] ?? 0]))
      },
      place: { countries, notStated, all: c.place_all ?? 0 }
    }
  };
}

/** What the page statement needs to know about the words and the order. */
interface PageSpec {
  mode: TextMode;
  /** `exact` and `fuzzy` carry words; `none` is no words (or nothing to match). */
  text: 'none' | 'exact' | 'fuzzy';
  sort: BoardSort;
  /** Whether the reader can see Deets: which of the two best-match tails to run. */
  deetsVisible: boolean;
  titleClause: string;
  /** Parameter numbers of the tier queries ($ index), exact words only. */
  tiers: { a: number; ab: number; abc: number; phrase: number } | null;
  limit: number;
  offset: number;
}

/**
 * THE TIER LADDER (sort=best, and the facts each row reports). Four rungs, the
 * first that holds wins:
 *   0  the title IS the words: lower-cased, accents folded, punctuation made a
 *      single space, the same as the box's words. "Product Designer" for the
 *      words "product designer", not for "Product Designer, Growth".
 *   1  every word is in the TITLE (weight A), as a whole word or a prefix.
 *   2  every word is in the title or the COMPANY (A or B).
 *   3  anything else: some word needed the department or the description.
 * Rungs 1 and 2 are the same words as the match, each alternative restricted to
 * a weight, so "in the title" is read from the same vector the match was.
 * Rung 0's comparison is written with [[:alnum:]] where the words are folded
 * with \p{L}\p{N}; they agree on every Latin, Greek and digit character, and on
 * a script where the database's locale classes a letter differently a title
 * that is the words lands on rung 1 instead of 0, still above everything else.
 */
function tierSql(titleRef: string, searchRef: string, tiers: NonNullable<PageSpec['tiers']>): string {
  return `CASE WHEN btrim(regexp_replace(lower(f_unaccent(${titleRef})), '[^[:alnum:]]+', ' ', 'g')) = $${tiers.phrase}::text THEN 0
              WHEN ${searchRef} @@ tq.q_a THEN 1
              WHEN ${searchRef} @@ tq.q_ab THEN 2
              ELSE 3 END`;
}

/** The field that COMPLETES the match (see BoardListRow): the lowest weight any word needed. */
function fieldSql(titleRef: string, searchRef: string, tiers: NonNullable<PageSpec['tiers']>): string {
  return `CASE WHEN btrim(regexp_replace(lower(f_unaccent(${titleRef})), '[^[:alnum:]]+', ' ', 'g')) = $${tiers.phrase}::text
                 OR ${searchRef} @@ tq.q_a THEN 'title'
              WHEN ${searchRef} @@ tq.q_ab THEN 'company'
              WHEN ${searchRef} @@ tq.q_abc THEN 'department'
              ELSE 'description' END`;
}

/**
 * The page statement. Three shapes of the same thing:
 *
 *   exact words, sort=best   every matching row is ranked (tier, then
 *                            ts_rank_cd, then Deets when the reader can see it,
 *                            then age, then id) before the page is cut, because
 *                            the order IS the rank.
 *   exact words, any other   the page is cut in the reader's own order and
 *                            only then are its twenty-five rows asked which
 *                            rung they are on. A tier is a fact about a row,
 *                            not a reason to read the description vector of
 *                            every row the words found.
 *   typo path / no words     the rows' own columns; the typo path orders by
 *                            similarity when asked for best.
 *
 * The tsqueries are parsed ONCE, in the one-row `tq` CTE, and not once per row:
 * to_tsquery is stable, not immutable, so Postgres will not fold it away.
 */
function pageSql(spec: PageSpec): string {
  const { text, tiers, titleClause } = spec;
  const best = spec.sort === 'best' && text !== 'none';
  const keep = keepSql(titleClause);
  const ctes: string[] = [];
  let source = `matched m\n WHERE ${keep}`;
  let order: string;

  if (text === 'exact' && tiers) {
    ctes.push(`tq AS MATERIALIZED (
  SELECT to_tsquery('simple', $3::text) AS q_all,
         to_tsquery('simple', $${tiers.a}::text) AS q_a,
         to_tsquery('simple', $${tiers.ab}::text) AS q_ab,
         to_tsquery('simple', $${tiers.abc}::text) AS q_abc
)`);
  }
  if (best && text === 'exact' && tiers) {
    ctes.push(`ranked AS (
  SELECT m.*, ${tierSql('m.title', 'm.search', tiers)} AS tier_n, ts_rank_cd(m.search, tq.q_all) AS rank_n
    FROM matched m CROSS JOIN tq
   WHERE ${keep}
)`);
    source = 'ranked m';
    order = spec.deetsVisible ? BEST_ORDER.withDeets : BEST_ORDER.withoutDeets;
  } else if (best && text === 'fuzzy') {
    order = spec.deetsVisible ? FUZZY_ORDER.withDeets : FUZZY_ORDER.withoutDeets;
  } else {
    order = BOARD_ORDER[spec.sort === 'best' ? 'fit' : spec.sort] ?? BOARD_ORDER.fit;
  }
  ctes.push(`page AS (
  SELECT m.* FROM ${source}
   ORDER BY ${order}
   LIMIT $${spec.limit} OFFSET $${spec.offset}
)`);

  let facts: string;
  let from = 'page';
  if (text === 'exact' && tiers) {
    facts = `${tierSql('page.title', 'page.search', tiers)} AS match_tier,
       ${fieldSql('page.title', 'page.search', tiers)} AS match_field,
       NULL::float8 AS fuzzy_score`;
    from = 'page CROSS JOIN tq';
  } else if (text === 'fuzzy') {
    facts = `NULL::int AS match_tier, 'title'::text AS match_field, page.text_sim AS fuzzy_score`;
  } else {
    facts = `NULL::int AS match_tier, NULL::text AS match_field, NULL::float8 AS fuzzy_score`;
  }
  return `${boardFacetCte(spec.mode)}
, ${ctes.join('\n, ')}
SELECT ${BOARD_ROW_OUT},
       ${facts}
  FROM ${from}
 ORDER BY ${order}`;
}

async function readPage(
  conn: Queryable,
  setup: Setup,
  text: PageSpec['text'],
  sq: SearchQuery | null,
  opts: Pick<BoardFilter, 'sort' | 'deetsVisible'>,
  perPage: number,
  page: number
): Promise<BoardListRow[]> {
  // The page's own parameters follow the shared ones and the watched titles: the
  // tier queries (exact words only), then LIMIT and OFFSET.
  const params: unknown[] = [...setup.shared, ...setup.titleParams];
  let tiers: PageSpec['tiers'] = null;
  if (text === 'exact' && sq) {
    const at = params.length;
    params.push(sq.a, sq.ab, sq.abc, sq.phrase);
    tiers = { a: at + 1, ab: at + 2, abc: at + 3, phrase: at + 4 };
  }
  params.push(perPage, (page - 1) * perPage);
  const { rows } = await runStatement(
    conn,
    plansForWords(setup.mode),
    pageSql({ mode: setup.mode, text, sort: opts.sort, deetsVisible: opts.deetsVisible !== false, titleClause: setup.titleClause, tiers, limit: params.length - 1, offset: params.length }),
    params
  );
  return rows as BoardListRow[];
}

/**
 * One page of the board under the reader's filters, with the count every
 * option would leave. Every value bound, one CTE shared by every statement.
 *
 * THE WORDS RUN IN TWO PASSES AT MOST. First exactly, against the weighted
 * vector. If that finds NOTHING ON THE WHOLE BOARD (not "nothing under these
 * filters": a reader who typed a real word and chose a pay floor nothing meets
 * has not misspelt it) and some word is long enough to be a misspelling, the
 * whole answer is taken again on the typo path and `fuzzy` says so. Counts, rows
 * and places in that answer all come from the same close-spelling predicate: one
 * population, never an exact count over a fuzzy list. If the typo path finds
 * nothing either, the empty exact answer stands and `fuzzy` is false.
 */
export async function listBoardFiltered(opts: BoardFilter): Promise<BoardFilteredResult> {
  const perPage = Math.max(1, Math.floor(opts.perPage) || 5);
  const page = Math.max(1, Math.floor(opts.page) || 1);
  const age = { min: opts.ageMin ?? null, max: opts.ageMax ?? null };
  const plan = planText(opts.q);
  const exact = setupExact(opts, opts.titles, plan, age);
  const sq = plan.kind === 'words' ? plan.sq : null;

  // THE COUNTS AND THE ROWS ARE ASKED AT THE SAME TIME, on two connections. The
  // rows do not depend on the counts, and waiting for the counts first made every
  // request pay for both end to end. When the words turn out to be a typo the
  // exact rows are thrown away, and they cost nothing: the words matched nothing.
  const text: PageSpec['text'] = sq ? 'exact' : 'none';
  const [first, exactRows] = await Promise.all([readCounts(db(), exact), readPage(db(), exact, text, sq, opts, perPage, page)]);

  if (sq && sq.fuzzy && first.textTotal === 0) {
    const fuzzySq = sq as SearchQuery & { fuzzy: NonNullable<SearchQuery['fuzzy']> };
    const close = await withTrigramThreshold(async (conn) => {
      const setup = setupFuzzy(opts, opts.titles, fuzzySq, age);
      const counted = await readCounts(conn, setup);
      if (counted.textTotal === 0) return null;
      // One connection runs one statement at a time, so the rows wait their turn.
      return { rows: await readPage(conn, setup, 'fuzzy', sq, opts, perPage, page), counts: counted.counts };
    });
    if (close) return { rows: close.rows, total: close.counts.total, counts: close.counts, fuzzy: true };
  }

  return { rows: exactRows, total: first.counts.total, counts: first.counts, fuzzy: false };
}

/* ---- the suggestion panel's counts (2026-10-02) ---------------------------- *
 *
 * A row of the search box's panel promises a number: "London, United Kingdom 406"
 * is a claim that /board at that row's address shows 406. Two reads make the
 * claim true by construction, and both are built on THE BOARD'S OWN CTE, so no
 * rule of the board (live only, the age range, the watched titles, the arrangement
 * list, the pay floor, a family, the typo fallback) is restated for the panel.
 *
 *   countBoardTotals          the `total` listBoardFiltered would return, for many
 *                             filters at once, sharing statements where they can.
 *   listBoardTitleCandidates  the titles worth offering as completions.
 */

/** The titles that complete what is being typed, with the rows that carry each. */
export interface TitleCandidate {
  /** The most common spelling among the rows that fold to the same title. */
  title: string;
  /** Rows under the filters whose TITLE matches the words, folded together. */
  rows: number;
}

/**
 * TITLES THE WORDS COMPLETE TO. The rows whose TITLE (weight A, not the company
 * or the description) matches every word, each word whole or as a prefix, under
 * every other filter the reader has set, grouped on the title folded the way the
 * tier ladder folds it (lower case, accents out, punctuation a single space) so
 * "Software Engineer" and "Software engineer " are one title, and shown under
 * the spelling most rows use. Most rows first, then the title, so a tie is the
 * same every time.
 *
 * `opts.q` is the text being typed. No words, or text with no searchable word,
 * completes to nothing: the typo path is not tried, because a completion is a
 * title the words ALREADY match.
 *
 * The count here is a ranking, and it is not the number the panel prints: "Software
 * Engineer" is 12 rows by this title and over a thousand as a search, because the
 * board searches words and not titles. countBoardTotals counts what the board
 * shows when the title becomes the words.
 */
export async function listBoardTitleCandidates(opts: BoardFilter, limit: number): Promise<TitleCandidate[]> {
  const plan = planText(opts.q);
  if (plan.kind !== 'words') return [];
  const age = { min: opts.ageMin ?? null, max: opts.ageMax ?? null };
  const shared = sharedParams(opts, plan.sq.a, age);
  const { clause, params: titleParams } = titleKeepClause(opts.titles, shared.length + 1);
  const params: unknown[] = [...shared, ...titleParams, Math.max(1, Math.min(50, Math.floor(limit) || 1))];
  const { rows } = await runStatement(
    db(),
    true,
    `${boardFacetCte({ kind: 'title' })}
SELECT mode() WITHIN GROUP (ORDER BY title) AS title, count(*)::int AS rows
  FROM matched
 WHERE ${keepSql(clause)}
 GROUP BY btrim(regexp_replace(lower(f_unaccent(title)), '[^[:alnum:]]+', ' ', 'g'))
 ORDER BY rows DESC, 1 ASC
 LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => ({ title: String(r.title), rows: Number(r.rows) }));
}

/** Two filters share a group when every parameter except the three the panel
    varies (the words, the place, the company) binds to the same value, which is
    read off the parameters themselves so the key cannot miss one. */
function totalsSignature(f: BoardFilter): string {
  const age = { min: f.ageMin ?? null, max: f.ageMax ?? null };
  const shared = sharedParams({ ...f, place: null, company: null }, null, age);
  return JSON.stringify([shared, titleKeepClause(f.titles, 1).params]);
}

/**
 * `listBoardFiltered(f).total` for each filter, with no rows, no facet matrix and
 * no ordering, and as few statements as the filters allow. This is what makes a
 * suggestion's number the board's number: the statement is the board's own CTE
 * (boardFacetCte) read through the board's own keep clause (keepSql), so every
 * rule of the table (live only, the age range, the watched titles, the
 * arrangement list, the pay floor, a family, a freshness) is applied by the code
 * that applies it to the table, and none is written again for the panel.
 *
 * WHAT VARIES, AND WHAT IS SHARED. Filters that differ only in their words, place
 * and company (the three things a suggestion changes) are one GROUP and share every
 * bound parameter of the CTE (totalsSignature). Within a group:
 *
 *   - Each DISTINCT WORDS is its own statement, run side by side on the pool. The
 *     words are the expensive part of any count: before db/221 a prefix such as
 *     `des:*` was read out of the vector of every row the index named, thousands
 *     of them, to check the weights (it is a probe of the small vector now, and a
 *     broad word is still the largest count). Counting eight titles in one scan
 *     looked cheaper and was not: one statement evaluates every tsquery against
 *     every row it reads (measured on 2026-10-02, 210 ms for eight common title
 *     phrases in one scan, against 5 to 30 ms for each alone through its own index
 *     scan), so the work is split by words, each statement is narrowed by the
 *     index on its own words, and a group takes about as long as its slowest.
 *   - Filters that share their words (the places and companies of one fragment)
 *     share the statement, and differ only in two cheap predicates, one FILTER each,
 *     spelled by placeMatchSql and companyMatchSql, the same two the CTE's flags
 *     are written from.
 *   - Filters with no words share one more, which reads only the rows their places
 *     and companies can match (their sargable forms, so the indexes on
 *     place_keys and company are used), or every row when one of them names
 *     neither (the board with no place and no company).
 *   - Text with no word in it matches nothing: zero, with no statement.
 *
 * THE TYPO FALLBACK IS KEPT, because the table has it: words that match nothing
 * on the whole board are answered on the close-spelling path, and a count of the
 * exact words would be a different population from the rows the address shows. It
 * is tried only for a filter that counted zero, has a word long enough to
 * misspell, and whose words no filter in the group counted anywhere; those are
 * asked, with EXISTS so the question ends at the first row (readTextMatches),
 * whether the words match anything, and only if not is the close-spelling count
 * taken, one statement each.
 */
export async function countBoardTotals(filters: readonly BoardFilter[]): Promise<number[]> {
  const totals = filters.map(() => 0);
  const groups = new Map<string, number[]>();
  filters.forEach((f, i) => {
    const key = totalsSignature(f);
    const held = groups.get(key);
    if (held === undefined) groups.set(key, [i]);
    else held.push(i);
  });
  await Promise.all(
    [...groups.values()].map(async (indexes) => {
      const counted = await countGroup(indexes.map((i) => filters[i] as BoardFilter));
      indexes.forEach((at, n) => {
        totals[at] = counted[n] ?? 0;
      });
    })
  );
  return totals;
}

async function countGroup(group: readonly BoardFilter[]): Promise<number[]> {
  const head = group[0] as BoardFilter;
  const age = { min: head.ageMin ?? null, max: head.ageMax ?? null };
  const plans = group.map((f) => planText(f.q));
  const out = group.map(() => 0);

  // One statement per DISTINCT WORDS. The words are the expensive part of every
  // count (before db/221 a prefix such as `des:*` was read out of the vector of
  // every row the index named, which is thousands, and a broad word is still the
  // largest count), so each distinct words is its own statement,
  // narrowed by the index on its own words, and the statements run side by side
  // on the pool. Filters that share their words (the places and companies of one
  // fragment) share the statement and differ only in two cheap predicates. Filters
  // with no words at all share one more, which reads only the rows their places
  // and companies can match. Text with no word in it matches nothing: zero.
  const byWords = new Map<string, number[]>();
  group.forEach((_, at) => {
    const plan = plans[at] as TextPlan;
    if (plan.kind === 'nomatch') return;
    const key = plan.kind === 'words' ? plan.sq.all : '';
    const held = byWords.get(key);
    if (held === undefined) byWords.set(key, [at]);
    else held.push(at);
  });

  await Promise.all(
    [...byWords].map(async ([key, members]) => {
      // $3 is left NULL: no words in the shared part. match_place and match_company
      // are bound to nothing as well, so they are true for every row and the keep
      // clause below is every OTHER flag, applied exactly as the table applies it.
      const shared = sharedParams({ ...head, place: null, company: null }, null, age);
      const { clause, params: titleParams } = titleKeepClause(head.titles, shared.length + 1);
      const params: unknown[] = [...shared, ...titleParams];
      // The words, written the way the board writes them (compileMatch), over the
      // two vectors by their own column names: this statement reads them off
      // `matched`, not off the table.
      let words = '';
      const plan = plans[members[0] as number] as TextPlan;
      if (key !== '' && plan.kind === 'words') {
        const match = compileMatch(plan.sq.match, params.length + 1);
        params.push(...match.params);
        words = match.sql({ search: 'search', tc: 'search_tc' });
      }
      const filters: string[] = [];
      const arms: string[] = [];
      let narrowable = true;
      for (const at of members) {
        const f = group[at] as BoardFilter;
        const own: string[] = [];
        const sargable: string[] = [];
        const place = placeBinding(f.place);
        if (place) {
          params.push(place.country, place.admin1, place.city);
          const [c, a, y] = [params.length - 2, params.length - 1, params.length].map((n) => `$${n}`) as [string, string, string];
          own.push(placeMatchSql(c, a, y));
          // `unstated` reads the rows that list no place, an empty array; every
          // other key is one array-contains probe of the GIN index, the same
          // question the predicate above asks.
          sargable.push(
            place.country === PLACE_UNSTATED ? `place_keys = '{}'` : `place_keys @> ARRAY[${placeKeySql(c, a, y)}]::text[]`
          );
        }
        const company = f.company?.trim();
        if (company) {
          params.push(company);
          own.push(companyMatchSql(`$${params.length}`));
          sargable.push(`company = $${params.length}::text`);
        }
        filters.push(own.length > 0 ? own.join(' AND ') : 'TRUE');
        if (sargable.length === 0) narrowable = false;
        else arms.push(`(${sargable.join(' AND ')})`);
      }
      // With words, the index on the words is the narrowing. Without, the union of
      // what the places and companies can match is, unless one filter names neither
      // (the board with no place and no company), which has to read every row.
      const where = [keepSql(clause), words, words === '' && narrowable ? `(${arms.join(' OR ')})` : ''].filter(Boolean).join('\n   AND ');
      const { rows } = await runStatement(
        db(),
        words !== '',
        `${boardFacetCte(NO_WORDS)}
SELECT ${filters.map((f, k) => `count(*) FILTER (WHERE ${f})::int AS t${k}`).join(',\n       ')}
  FROM matched
 WHERE ${where}`,
        params
      );
      members.forEach((at, k) => {
        out[at] = Number(rows[0]?.[`t${k}`] ?? 0);
      });
    })
  );

  // The typo path, for the filters that need it (see the header). Words that
  // counted anything in ANY filter of this group match something on the board, so
  // they are exact and nothing more is asked; only words that counted nothing
  // anywhere are asked whether they match a single row (readTextMatches).
  const counted = new Set<string>();
  group.forEach((_, at) => {
    const plan = plans[at] as TextPlan;
    if (plan.kind === 'words' && (out[at] ?? 0) > 0) counted.add(plan.sq.all);
  });
  const wordsMatchNothing = new Map<string, Promise<boolean>>();
  await Promise.all(
    group.map(async (f, at) => {
      const plan = plans[at] as TextPlan;
      if (out[at] !== 0 || plan.kind !== 'words' || !plan.sq.fuzzy) return;
      // Keyed by the tsquery, which is what the question is asked of: two spellings
      // can share their words (`node.js`, `node js`) and not their query.
      const key = plan.sq.all;
      let nothing = wordsMatchNothing.get(key);
      if (nothing === undefined) {
        nothing = counted.has(key)
          ? Promise.resolve(false)
          : readTextMatches(db(), setupExact(f, f.titles, plan, age)).then((found) => !found);
        wordsMatchNothing.set(key, nothing);
      }
      if (!(await nothing)) return;
      const fuzzySq = plan.sq as SearchQuery & { fuzzy: NonNullable<SearchQuery['fuzzy']> };
      out[at] = await withTrigramThreshold(async (conn) => {
        const setup = setupFuzzy(f, f.titles, fuzzySq, age);
        const { rows } = await conn.query(
          `${boardFacetCte(setup.mode)}
SELECT count(*) FILTER (WHERE ${keepSql(setup.titleClause)})::int AS total,
       count(*) FILTER (WHERE ${textTotalFilter(setup.titleClause)})::int AS text_total
  FROM matched`,
          [...setup.shared, ...setup.titleParams]
        );
        // The same decision listBoardFiltered makes: close spellings that match
        // nothing leave the (empty) exact answer standing.
        return Number(rows[0]?.text_total ?? 0) === 0 ? 0 : Number(rows[0]?.total ?? 0);
      });
    })
  );
  return out;
}

/** The BoardRow columns read back out of the CTE (the same names, unprefixed). */
const BOARD_ROW_OUT = `id, slug, company, title, url, location, country, remote, published, ats,
  posting_id, department, derived_fam, derived_fam_source, comp_posted, comp_range, days_up, first_seen, last_seen,
  detail_total, detail_components, source, description, status, kill_id,
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
    `SELECT ${BOARD_LIST_COLUMNS}, ${KILL_COLUMNS}
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
/**
 * THE STRIP RESPECTS THE READER'S FILTERS (2026-09-28). It did not, and that
 * was the loudest of the three disagreeing numbers on the board: the tiles said
 * 37,286, the strip said "Showing 36,457 of 36,457 roles", and the Field
 * dropdown said 1,463 — three denominators on one screen with nothing saying
 * they were different. The strip was the odd one out, because it took the sweep
 * date and nothing else.
 *
 * It is built on the board's own CTE now, so "every verified role" means every
 * role the reader is actually looking at, and the count under the strip can be
 * checked against the count in the table.
 *
 * EVERY FILTER EXCEPT ITS OWN. match_age is deliberately left out: the strip IS
 * the age control. Applying the range it sets would collapse the plot to the
 * selection and leave no handle to widen it again. Every other flag, the
 * search words and the pay, place and company the reader chose among them, comes
 * from keepSql(), the one list the rows and the counts are built from; this
 * statement used to carry its own copy, which did not apply match_pipeline.
 *
 * THE WORDS ARE SPELLED THE WAY THE TABLE SPELLED THEM. The page asks for the
 * rows and for this strip separately and at the same time, so the strip has to
 * reach the table's decision (exact words, or the close spellings the typo path
 * falls back to) on its own, by the same test (readTextTotal). A strip drawn
 * over the exact words above a table of near misses would be two populations.
 */
function ageHistogramSql(mode: TextMode, titleClause: string): string {
  return `${boardFacetCte(mode)}
, measured AS (
  SELECT title, company, published AS published_at, age_days AS days
    FROM matched
   WHERE ${keepSql(titleClause, 'age')}
)`;
}

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

/** What the strip is drawn over: the board's filters, minus the age range the
    strip itself sets, and minus paging and sort (a histogram has neither).

    The four narrowing values are optional here and default to "everything", so
    a caller that draws the strip over the whole sweep — the home page teaser —
    passes the sweep date alone. */
export type AgeHistogramFilter = Omit<
  BoardFilter,
  'page' | 'perPage' | 'sort' | 'deetsVisible' | 'ageMin' | 'ageMax' | 'q' | 'location' | 'comp' | 'freshness'
> &
  Partial<Pick<BoardFilter, 'q' | 'location' | 'comp' | 'freshness'>>;

export async function listBoardAgeHistogram(opts: AgeHistogramFilter): Promise<AgeHistogram> {
  // The age range is null on purpose: see ageHistogramSql.
  const age = { min: null, max: null };
  const plan = planText(opts.q);
  const readHistogram = async (conn: Queryable, setup: Setup): Promise<AgeRow[]> => {
    const { rows } = await runStatement(
      conn,
      plansForWords(setup.mode),
      `${ageHistogramSql(setup.mode, setup.titleClause)}
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
      [...setup.shared, ...setup.titleParams]
    );
    return rows as AgeRow[];
  };

  const exact = setupExact(opts, opts.titles, plan, age);
  let rows: AgeRow[] | null = null;
  if (plan.kind === 'words' && plan.sq.fuzzy && (await readTextTotal(db(), exact)) === 0) {
    const fuzzySq = plan.sq as SearchQuery & { fuzzy: NonNullable<SearchQuery['fuzzy']> };
    rows = await withTrigramThreshold(async (conn) => {
      const setup = setupFuzzy(opts, opts.titles, fuzzySq, age);
      return (await readTextTotal(conn, setup)) === 0 ? null : readHistogram(conn, setup);
    });
  }
  rows ??= await readHistogram(db(), exact);

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
/**
 * The board rows for a set of job ids, in one query.
 *
 * WHY THIS EXISTS. The Opportunities tracker resolved a posting by searching
 * loadJobs() — the 104-row static design fixture in src/data/jobs.json — while
 * every posting a member actually clicks comes from this table, which holds
 * 37,765. So the lookup always missed, and the page told the reader "No
 * observation of this posting" about postings the sweep verifies nightly, could
 * not link a card's title back to its job, and fell to the generic follow-up
 * prompt because it could not read the posting's apply friction. One hole,
 * four symptoms.
 *
 * ONE QUERY, ONLY THE IDS ASKED FOR. Not listBoardAll(): this repo already
 * fought and won that battle (db/207, desk-agg.ts), taking /desk from 6.72 MB
 * per request to 121.4 KB by refusing to load a whole board into JS. A tracker
 * page holds tens of applications, so `= ANY($1)` over their ids is the shape,
 * and the primary key serves it.
 *
 * A killed posting still resolves, through the same LEFT JOIN the slug lookup
 * uses, because a tracker's whole job is to say what happened to a posting that
 * is no longer live. An id with no row simply does not come back, and the
 * caller renders the absence rather than inventing a fate for it.
 */
export async function listBoardJobsByIds(ids: readonly string[]): Promise<BoardRow[]> {
  const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];
  if (wanted.length === 0) return [];
  const { rows } = await db().query<BoardRow>(
    `SELECT ${BOARD_COLUMNS}, ${KILL_COLUMNS}
       FROM jobs j LEFT JOIN board_kills k ON k.id = j.kill_id
      WHERE j.id = ANY($1::text[])`,
    [wanted]
  );
  return rows;
}

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
            0 AS detail_total, NULL::jsonb AS detail_components, 'tracked' AS source, NULL::text AS description,
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
