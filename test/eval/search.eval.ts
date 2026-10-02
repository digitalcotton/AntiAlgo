/**
 * search.eval.ts: how well the search works, measured. Run it with
 * `npm run eval:search`; it writes docs/search-engine-metrics.md (for people)
 * and docs/search-engine-metrics.json (for diffing).
 *
 * WHY THIS IS A VITEST FILE AND NOT A SCRIPT. The engine under test is
 * src/lib/job-store.ts, which imports its neighbours without extensions, and
 * Node cannot resolve those. Running the real TypeScript engine is the point: a
 * harness that measured a re-implementation would measure the re-implementation.
 * It is NOT part of the normal suite. vitest.config.ts only picks up `*.test.*`
 * files, this one is `*.eval.ts`, and vitest.eval.config.ts is the only config
 * that names it.
 *
 * THE CONTRACT IS THE COMMITTED BASELINE. docs/search-engine-baseline-search.json
 * measured the OLD engine (ILIKE substring, ordered by detail_total) on a fixed
 * sample of live postings, and states its own sample rule, query rules and
 * metric rules. This file reads those rules from that file and reuses them
 * exactly (same salt, same sample SQL, same five query constructions, same rank,
 * hit and MRR definitions), so an Old column and a New column are the same
 * measurement on the same 500 postings.
 *
 * AND THE OLD ENGINE IS RE-RUN, NOT ONLY QUOTED. The old engine no longer
 * exists in the tree, so its query is restated below (`oldEngine`) from the code
 * at 0caebff: `title ILIKE '%q%' OR company ILIKE '%q%'`, wildcards escaped,
 * live rows, `ORDER BY detail_total DESC, company ASC, title ASC, id ASC`. It is
 * trusted only because it is CHECKED: every run replays all five query types
 * through it and compares n, hit@1, hit@10, MRR and zero-result rate to the
 * committed baseline, and says so at the top of the report. The measurements the
 * baseline does not hold (title-equivalent hits, the precision of the top ten)
 * are taken from this replica, so both columns are measured the same way.
 *
 * DETERMINISM. Nothing here is random. The sample is `ORDER BY md5(id||salt)`,
 * the engine's order ends in `id`, and "today" is pinned to the sweep's own day
 * (sweepDate(), what the board passes) rather than the calendar's, because the
 * best-match order breaks ties on age. Two runs on one database produce the same
 * numbers; only latency, load and timestamps move. The JSON carries a
 * `fingerprint` over everything that must not move so a re-run can be checked
 * with one comparison.
 *
 * PART TWO MEASURES THE SUGGEST ENDPOINT (docs/search-engine-plan.md tickets I
 * and J): typeahead recall for titles, places and companies, the counts contract
 * over 500 seeded cases (every suggestion's count against the total the board
 * shows at its address), the strip's sum invariants, suggest latency cold and
 * warm, and the cache key. It calls the route's own GET handler in this process;
 * the board is the oracle, never the code under test. Its draws are seeded, so
 * its numbers are in the fingerprint too; only its latency is not.
 *
 * WHAT IT NEVER DOES. It reads; it writes no row of any table. It refuses a
 * database that is not on this machine unless EVAL_ALLOW_REMOTE=1, because the
 * latency numbers mean "local Postgres" and the report says so.
 */
import '../../load-local-env.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeFor } from '../../src/data/nav';
import { GET as suggestEndpoint } from '../../src/pages/board/suggest';
import { DEFAULT_PER_PAGE, defaultSortFor, parseBoardQuery, type BoardQuery } from '../../src/lib/board-query';
import { sweepDate } from '../../src/lib/data';
import { db } from '../../src/lib/db';
import { FAMILY_IDS, familyOf } from '../../src/lib/job-family.mjs';
import { boardRowsLoadedAt, foldForSearch, getBoardStats, listBoardFiltered, type BoardFilter } from '../../src/lib/job-store';
import { formatPlaceKey } from '../../src/lib/place-key';
import { forgetLexicon, getLexicon, type BoardLexicon } from '../../src/lib/search-lexicon';
import { boardFilterFromQuery, canonicalSearchTarget, forgetSuggestMemo, SUGGEST_GROUP_MAX, type SuggestBody, type SuggestGroupType, type SuggestItem } from '../../src/lib/search-suggest';

/* ---- inputs ------------------------------------------------------------------ */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const at = (relative: string) => join(ROOT, relative);

/** The five query constructions, in the baseline's order. */
const TYPES = ['title', 'title_company', 'title_lower', 'words_reordered', 'one_typo'] as const;
type QueryType = (typeof TYPES)[number];

/** The sample SQL as the baseline states it. The salt and the size are read from
    the baseline file; this string is checked against its `sample.rule` so the two
    cannot drift apart without the harness saying so. */
const SAMPLE_RULE = "SELECT id FROM jobs WHERE status='live' AND length(title)>=4 ORDER BY md5(id||salt) LIMIT 500";

/** The classifier coverage before the repair, from the commit that repaired it
    (job-family.test.ts: "90.51% -> 90.45%"). */
const CLASSIFIER_BEFORE = 0.9051;
const CLASSIFIER_FLOOR = 0.9;
const CLASSIFIER_FIXTURE = 'test/fixtures/family-corpus.json.gz';

/** Rows asked for per known-item query: the baseline ranks within the first 100. */
const RANK_DEPTH = 100;
const PRECISION_QUERIES = 40;
const LATENCY_RUNS = 50;
const LATENCY_WARMUP = 3;

interface BaselineType {
  n: number;
  hit1: number;
  hit10: number;
  mrr: number;
  zero_results: number;
  latency_ms: { p50: number; p95: number; p99: number };
}
interface Baseline {
  engine: string;
  measured_at: string;
  sample: { salt: string; rule: string; size: number };
  query_rules: Record<string, string>;
  metric_rules: string;
  results: Record<QueryType, BaselineType>;
}
interface DataBaseline {
  taken_at: string;
  live_rows: number;
  rows_with_country: number;
  derived_region: Record<string, number>;
  non_us_country_in_us_region: number;
}

const baseline = JSON.parse(readFileSync(at('docs/search-engine-baseline-search.json'), 'utf8')) as Baseline;
const dataBaseline = JSON.parse(readFileSync(at('docs/search-engine-baseline.json'), 'utf8')) as DataBaseline;

/* ---- small helpers ----------------------------------------------------------- */

/** A share as a percentage with one decimal, the baseline's own precision. */
const pct1 = (k: number, n: number) => (n === 0 ? 0 : Math.round((1000 * k) / n) / 10);
const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function latency(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: round(percentile(sorted, 0.5), 1),
    p95: round(percentile(sorted, 0.95), 1),
    p99: round(percentile(sorted, 0.99), 1),
    max: round(sorted[sorted.length - 1] ?? 0, 1)
  };
}

/** A title as the tier ladder compares it: folded the way the vector is, then
    every run of anything that is not a letter, mark or digit made one space. */
const fold = (text: string) => foldForSearch(text).replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

const num = (n: number) => n.toLocaleString('en-US');

/* ---- the five query constructions (the baseline's query_rules) --------------- */

interface Sample {
  id: string;
  title: string;
  company: string;
}

const titleWords = (title: string) => title.split(/\s+/).filter(Boolean);

const QUERY_RULES: Record<QueryType, (row: Sample) => string | null> = {
  // the exact title
  title: (row) => row.title,
  // title + space + company
  title_company: (row) => `${row.title} ${row.company}`,
  // title lower-cased
  title_lower: (row) => row.title.toLowerCase(),
  // last title word moved to the front (titles of 2+ words only)
  words_reordered: (row) => {
    const words = titleWords(row.title);
    return words.length < 2 ? null : [words[words.length - 1], ...words.slice(0, -1)].join(' ');
  },
  // middle character deleted from the longest title word of length >= 5
  one_typo: (row) => {
    const words = titleWords(row.title);
    let longest: string | null = null;
    for (const word of words) if (word.length >= 5 && (longest === null || word.length > longest.length)) longest = word;
    if (longest === null) return null;
    const middle = Math.floor(longest.length / 2);
    const typo = longest.slice(0, middle) + longest.slice(middle + 1);
    return words.map((word) => (word === longest ? typo : word)).join(' ');
  }
};

/* ---- the two engines --------------------------------------------------------- */

interface Hit {
  id: string;
  title: string;
}
interface Answer {
  hits: Hit[];
  fuzzy: boolean;
}
type Engine = (q: string, depth: number) => Promise<Answer>;

let SWEEP = '';
const BOARD: Omit<BoardFilter, 'q' | 'sort'> = {
  location: 'all',
  comp: 'all',
  freshness: 'all',
  page: 1,
  perPage: DEFAULT_PER_PAGE,
  sweepDate: '',
  ageMin: null,
  ageMax: null
};

/** The new engine: the board's own entry point, with the sort the board would
    choose for these words. */
const newEngine: Engine = async (q, depth) => {
  const result = await listBoardFiltered({ ...BOARD, sweepDate: SWEEP, q, sort: defaultSortFor(q), perPage: depth });
  return { hits: result.rows.map((row) => ({ id: row.id, title: row.title })), fuzzy: result.fuzzy };
};

/** The old engine's match, as a bound pattern: the wildcards a person typed are
    literal (job-store.ts likePattern at 0caebff). */
function likePattern(q: string): string | null {
  const trimmed = q.trim();
  return trimmed ? `%${trimmed.replace(/[\\%_]/g, '\\$&')}%` : null;
}

/** The old engine, restated from 0caebff (see the file header). */
const oldEngine: Engine = async (q, depth) => {
  const { rows } = await db().query<Hit>(
    `SELECT id, title FROM jobs
      WHERE status = 'live' AND (title ILIKE $1 ESCAPE '\\' OR company ILIKE $1 ESCAPE '\\')
      ORDER BY detail_total DESC, company ASC, title ASC, id ASC
      LIMIT $2`,
    [likePattern(q), depth]
  );
  return { hits: rows, fuzzy: false };
};

/* ---- known-item retrieval ---------------------------------------------------- */

interface Probe {
  rank: number;
  zero: boolean;
  fuzzy: boolean;
  /** The top ten holds any row whose folded title is the sampled posting's. */
  titleTop10: boolean;
  ms: number;
}
interface TypeStats {
  n: number;
  hit1: number;
  hit10: number;
  hit100: number;
  mrr: number;
  zero_results: number;
  fuzzy_rate: number | null;
  title_equivalent_hit10: number;
  latency_ms: { p50: number; p95: number; p99: number; max: number };
}
interface Miss {
  id: string;
  title: string;
  query: string;
  rank: number;
  top3: string[];
}
/** What an engine that cannot tell identical titles apart could score on the
    exact-id measure: a posting whose folded title is shared by k live postings
    is found at rank 1 with probability 1/k and in the top ten with probability
    min(1, 10/k), because the title queries leave nothing else to choose between
    them. */
interface Ceiling {
  hit1: number;
  hit10: number;
  share_of_sample_with_a_title_shared_by_more_than_ten: number;
}

function summarise(probes: readonly Probe[], withFuzzy: boolean): TypeStats {
  const n = probes.length;
  const ranks = probes.map((p) => p.rank);
  return {
    n,
    hit1: pct1(ranks.filter((r) => r === 1).length, n),
    hit10: pct1(ranks.filter((r) => r >= 1 && r <= 10).length, n),
    hit100: pct1(ranks.filter((r) => r >= 1).length, n),
    mrr: round(ranks.reduce((sum, r) => sum + (r > 0 ? 1 / r : 0), 0) / (n || 1), 3),
    zero_results: pct1(probes.filter((p) => p.zero).length, n),
    fuzzy_rate: withFuzzy ? pct1(probes.filter((p) => p.fuzzy).length, n) : null,
    title_equivalent_hit10: pct1(probes.filter((p) => p.titleTop10).length, n),
    latency_ms: latency(probes.map((p) => p.ms))
  };
}

async function probeType(engine: Engine, sample: readonly Sample[], type: QueryType): Promise<{ probes: Probe[]; misses: Miss[] }> {
  const probes: Probe[] = [];
  const misses: Miss[] = [];
  for (const row of sample) {
    const q = QUERY_RULES[type](row);
    if (q === null) continue;
    const started = performance.now();
    const answer = await engine(q, RANK_DEPTH);
    const ms = performance.now() - started;
    const rank = answer.hits.findIndex((hit) => hit.id === row.id) + 1;
    const wanted = fold(row.title);
    const titleTop10 = answer.hits.slice(0, 10).some((hit) => fold(hit.title) === wanted);
    probes.push({ rank, zero: answer.hits.length === 0, fuzzy: answer.fuzzy, titleTop10, ms });
    if (!titleTop10 && misses.length < 8) {
      misses.push({ id: row.id, title: row.title, query: q, rank, top3: answer.hits.slice(0, 3).map((hit) => hit.title) });
    }
  }
  return { probes, misses };
}

/** Does the replica of the old engine reproduce the committed baseline? */
function replicaMismatches(replica: Record<QueryType, TypeStats>): string[] {
  const out: string[] = [];
  for (const type of TYPES) {
    const want = baseline.results[type];
    const got = replica[type];
    for (const field of ['n', 'hit1', 'hit10', 'mrr', 'zero_results'] as const) {
      if (want[field] !== got[field]) out.push(`${type}.${field}: baseline ${want[field]}, replica ${got[field]}`);
    }
  }
  return out;
}

/* ---- precision of the top ten for real queries ------------------------------- */

interface PrecisionRow {
  query: string;
  live_rows: number;
  new: { returned: number; precise: number };
  old: { returned: number; precise: number };
}
function precisionSummary(rows: readonly PrecisionRow[], engine: 'new' | 'old') {
  const returned = rows.reduce((sum, r) => sum + r[engine].returned, 0);
  const precise = rows.reduce((sum, r) => sum + r[engine].precise, 0);
  const answered = rows.filter((r) => r[engine].returned > 0);
  const shares = answered.map((r) => r[engine].precise / r[engine].returned);
  return {
    queries: rows.length,
    rows_examined: returned,
    rows_precise: precise,
    pooled_precision_at_10: pct1(precise, returned),
    mean_precision_at_10: pct1(shares.reduce((a, b) => a + b, 0), shares.length),
    queries_all_precise: shares.filter((s) => s === 1).length,
    queries_with_no_results: rows.length - answered.length
  };
}

/* ---- the data metrics -------------------------------------------------------- */

interface PlaceHoldout {
  held_out: number;
  resolved: number;
  correct: number;
  accuracy_pct: number;
  misses_where_text_names_the_other_country: number;
  table_only: { rows: number; placed: number; correct: number };
}

function parsePlaceReport(stdout: string) {
  const block = (from: string, to: string | null) => {
    const start = stdout.indexOf(from);
    if (start < 0) throw new Error(`build-place-table.mjs output has no "${from}" section`);
    const end = to ? stdout.indexOf(to, start + from.length) : stdout.length;
    return stdout.slice(start, end < 0 ? stdout.length : end);
  };
  const grab = (text: string, pattern: RegExp, label: string) => {
    const m = pattern.exec(text);
    if (!m) throw new Error(`build-place-table.mjs output: could not read ${label}`);
    return m.slice(1).map((v) => Number(v));
  };
  const holdout = (text: string): PlaceHoldout => {
    const [heldOut] = grab(text, /held out\s+(\d+) rows/, 'held out');
    const [resolved] = grab(text, /country resolved\s+(\d+) \(/, 'country resolved');
    const [correct, of] = grab(text, /country correct\s+(\d+) of (\d+) resolved/, 'country correct');
    const [misses, contradicted] = grab(text, /of the (\d+) misses, (\d+) are rows/, 'misses');
    const [tableRows, placed, right] = grab(text, /table-only rows\s+(\d+) the string alone cannot place; the table placed (\d+) \([\d.]+%\), (\d+) correct/, 'table-only rows');
    if (of !== resolved || misses !== resolved - correct) throw new Error('build-place-table.mjs output: holdout numbers do not agree with each other');
    return {
      held_out: heldOut,
      resolved,
      correct,
      accuracy_pct: round((100 * correct) / resolved, 2),
      misses_where_text_names_the_other_country: contradicted,
      table_only: { rows: tableRows, placed, correct: right }
    };
  };
  const a = block('holdout A', 'holdout B');
  const b = block('holdout B', 'coverage over every live row');
  const cov = block('coverage over every live row', null);
  const [upstream, upstreamOf] = grab(cov, /upstream country\s+(\d+) of (\d+)/, 'upstream coverage');
  const [placed, placedOf] = grab(cov, /placeOf country\s+(\d+) of (\d+)/, 'placeOf coverage');
  const [newly, noUpstream, byTable] = grab(cov, /newly resolved\s+(\d+) of the (\d+) rows with no upstream country \([\d.]+%\), (\d+) of them only because of the learned table/, 'newly resolved');
  const [learned] = grab(stdout, /learned (\d+) cities/, 'learned cities');
  const unresolved = [...cov.matchAll(/^\s+(\d+)\s+("(?:[^"\\]|\\.)*")$/gm)].slice(0, 10).map((m) => ({ location: JSON.parse(m[2]) as string, rows: Number(m[1]) }));
  return {
    cities_learned: learned,
    holdout_by_row: holdout(a),
    holdout_by_string: holdout(b),
    coverage: {
      rows: upstreamOf,
      upstream_country: upstream,
      placeof_country: placed,
      placeof_rows: placedOf,
      newly_resolved: newly,
      rows_without_upstream: noUpstream,
      resolved_only_by_learned_table: byTable,
      largest_unresolved: unresolved
    }
  };
}

/* ---- board shapes for latency ------------------------------------------------ */

interface Shape {
  key: string;
  label: string;
  filter: Partial<BoardFilter>;
}
const SHAPES: readonly Shape[] = [
  { key: 'no_q', label: 'no words', filter: {} },
  { key: 'one_word', label: 'one word: designer', filter: { q: 'designer' } },
  { key: 'three_words', label: 'three words: senior product designer', filter: { q: 'senior product designer' } },
  { key: 'typo', label: 'a typo: prodct desiner', filter: { q: 'prodct desiner' } },
  { key: 'words_place_remote_pay', label: 'words + place + remote + pay: product designer, US, remote, $150k+', filter: { q: 'product designer', place: 'US', remote: ['remote'], payMin: 150 } },
  { key: 'broad_word', label: 'a broad word: engineer', filter: { q: 'engineer' } }
];

/* ---- the report -------------------------------------------------------------- */

interface Target {
  measure: string;
  target: string;
  measured: string;
  verdict: 'PASS' | 'MISS' | 'NOT MEASURED';
  note?: string;
}

// Everything the sections below fill in. Typed loosely on purpose: it is a
// document, written once to JSON, and read back by nothing in this repo.
const report: Record<string, any> = {};

const section = (name: string) => {
  if (!(name in report)) throw new Error(`the "${name}" section was not measured, so no report is written`);
  return report[name];
};

/** Everything that must not move between two runs on one database: the report
    without its metadata, its targets (some are latency verdicts) and any latency. */
function fingerprintOf(full: Record<string, unknown>): string {
  const { meta: _meta, targets: _targets, fingerprint: _fingerprint, ...rest } = full;
  return sha256(JSON.stringify(canonical(rest)));
}

/** The same value with every object's keys in sorted order and every `latency_ms`
    dropped. Postgres is free to return the rows of a GROUP BY in any order (the
    region counts came back in a different order on two runs over unchanged
    data), and an order that is not part of the answer must not be part of the
    fingerprint. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'latency_ms')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, canonical(v)])
    );
  }
  return value;
}

/* ---- part 2: the typeahead, the counts contract, the suggest latency --------- */

/**
 * Everything from here to the report measures the suggest endpoint
 * (src/pages/board/suggest.ts) through its own GET handler, called in this
 * process the way Astro calls it, with the two parts of the context it reads
 * (`url`, `locals`). So the request is parsed, the filters are read by the
 * board's reader, the crawl instant is read from the database, the answer is
 * built and serialised and its Cache-Control is chosen by the real code. What it
 * does not include is a network, a CDN and a browser: a number here is the
 * function's, not a reader's.
 *
 * THE ORACLE IS THE BOARD. A count is never checked against the code that
 * produced it. Each item's `href` is read back by parseBoardQuery (the board's
 * reader) and counted by listBoardFiltered (the call board.astro makes), and
 * what the board would show for the text as typed is decided the way the page
 * decides it (canonicalSearchTarget, then the same count). The filter the store
 * is handed is boardFilterFromQuery's, which is also the page's.
 *
 * EVERY DRAW IS SEEDED. The generators below are a PRNG with a fixed seed over
 * pools that are `ORDER BY md5(id||salt), id` samples of the live rows, so two
 * runs on one database ask the same questions and give the same answers.
 */
const BOARD_PATH = routeFor('board');
const SUGGEST_PATH = routeFor('board-suggest');

const TYPEAHEAD_ROWS = 200;
const TYPEAHEAD_CONCURRENCY = 4;
const CONTRACT_CASES = 500;
const CONTRACT_SEED = 20261002;
const LATENCY_CASES = 200;
const LATENCY_SEED = 20261003;
const LATENCY_WARMUP_CASES = 5;
/** Items checked against the board at once. Each is one `listBoardFiltered`. */
const ORACLE_CONCURRENCY = 4;
const SUGGEST_P95_TARGET_MS = 100;
/** The cut of cold requests by how many rows the board shows for the typed text.
    The first is its own cut because words that match nothing make the board ask
    whether they are a misspelling (job-store.ts countGroup), which is a read of its own. */
const ROWS_BUCKETS = [
  { label: 'no rows', lo: 0, hi: 1 },
  { label: '1 to 99 rows', lo: 1, hi: 100 },
  { label: '100 to 999 rows', lo: 100, hi: 1000 },
  { label: '1,000 rows or more', lo: 1000, hi: Infinity }
];
const MISMATCHES_LISTED = 20;

/** A seeded generator (mulberry32), so a case names itself and can be replayed. */
function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] as T };
}

/** `fn` over `items`, `limit` at a time, results in the order of `items`. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, at: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const at = next++;
        if (at >= items.length) return;
        out[at] = await fn(items[at] as T, at);
      }
    })
  );
  return out;
}

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/** The crawl instant the board is on, and the vocabulary built for it. */
let V = '';
let LEXICON: BoardLexicon;
let POOLS: Pools;

interface Asked {
  status: number;
  cacheControl: string | null;
  body: SuggestBody;
  ms: number;
}

/** One request to the endpoint's own handler. `v` is the crawl instant the page
    would send; pass null to send none. Only the handler is timed. */
async function askSuggest(text: string, search = '', v: string | null = V): Promise<Asked> {
  const params = new URLSearchParams(search);
  params.set('q', text);
  if (v !== null) params.set('v', v);
  const url = new URL(`https://antialgo.test${SUGGEST_PATH}?${params.toString()}`);
  const started = performance.now();
  const response = await suggestEndpoint({ url, locals: { viewer: null } } as never);
  const ms = performance.now() - started;
  return { status: response.status, cacheControl: response.headers.get('Cache-Control'), body: (await response.json()) as SuggestBody, ms };
}

const itemsOf = (body: SuggestBody, type: SuggestGroupType): SuggestItem[] => body.groups.find((g) => g.type === type)?.items ?? [];

/** The query an address means: the board's reader, with a placeholder origin. */
const queryOfHref = (href: string): BoardQuery => parseBoardQuery(new URL(href, 'https://board.invalid').searchParams);

/** What the board shows at an address (the store's total for the query it means). */
const boardFilterOf = (query: BoardQuery): BoardFilter => boardFilterFromQuery(query, { sweepDate: SWEEP });
const boardTotals = new Map<string, Promise<number>>();
function boardTotalAt(href: string): Promise<number> {
  let held = boardTotals.get(href);
  if (held === undefined) {
    held = listBoardFiltered(boardFilterOf(queryOfHref(href))).then((r) => r.total);
    boardTotals.set(href, held);
  }
  return held;
}

/** Where pressing Enter on `text` lands, decided as board.astro decides it: the
    address is read, and text that states facts is sent to the address that holds
    them. The query returned is the board that is then shown. */
function landingFor(text: string, search: string): BoardQuery {
  const params = new URLSearchParams(search);
  params.set('q', text);
  const parsed = parseBoardQuery(params);
  const target = canonicalSearchTarget(text.trim(), parsed, LEXICON, BOARD_PATH);
  return queryOfHref(target ?? `${BOARD_PATH}?${params.toString()}`);
}

/* ---- typeahead recall ----------------------------------------------------------- */

interface TypeaheadProbe {
  rank: number;
  none: boolean;
  chip: boolean;
  eligible: boolean;
}
interface TypeaheadMiss {
  title: string;
  typed: string;
  completions: number;
  top3: string[];
}
const COMPLETIONS_SHOWN = 8;

function recallStats(probes: readonly TypeaheadProbe[]) {
  const n = probes.length;
  const found = probes.filter((p) => p.rank > 0).map((p) => p.rank);
  return {
    n,
    missed: n - found.length,
    in_top_8: pct1(found.length, n),
    at_1: pct1(found.filter((r) => r === 1).length, n),
    in_top_3: pct1(found.filter((r) => r <= 3).length, n),
    median_rank_when_found: median(found),
    mrr: round(probes.reduce((sum, p) => sum + (p.rank > 0 ? 1 / p.rank : 0), 0) / (n || 1), 3),
    no_completions: pct1(probes.filter((p) => p.none).length, n),
    typed_text_read_as_a_chip: probes.filter((p) => p.chip).length,
    missed_where_the_typed_text_was_read_as_a_chip: probes.filter((p) => p.rank === 0 && p.chip).length
  };
}

/** The first `n` characters of a word, or the whole word when it is shorter. */
const head = (word: string, n: number) => word.slice(0, n);

const TYPEAHEAD_RULES: Record<string, (row: Sample) => string> = {
  // the title's earlier words, then the first four characters of its last word
  last_word_4: (row) => {
    const words = titleWords(row.title);
    return [...words.slice(0, -1), head(words[words.length - 1] as string, 4)].join(' ');
  },
  // only the first 3, 4 and 6 characters of the first word
  first_word_3: (row) => head(titleWords(row.title)[0] as string, 3),
  first_word_4: (row) => head(titleWords(row.title)[0] as string, 4),
  first_word_6: (row) => head(titleWords(row.title)[0] as string, 6)
};

/* ---- the generators for the counts contract and the latency ---------------------- */

interface Pools {
  titles: string[];
  companies: string[];
  cities: string[];
  /** (country, admin1, city) of live rows with a resolved place; a filter takes one at a level. */
  places: { country: string; admin1: string | null; city: string | null }[];
}

async function drawPools(): Promise<Pools> {
  const column = async (sqlText: string): Promise<string[]> => (await db().query(sqlText)).rows.map((r) => String(Object.values(r)[0]));
  const { rows: places } = await db().query<{ country: string; admin1: string | null; city: string | null }>(
    `SELECT place_country AS country, place_admin1 AS admin1, place_city AS city FROM jobs
      WHERE status = 'live' AND place_country IS NOT NULL ORDER BY md5(id || 'suggest-place'), id LIMIT 300`
  );
  return {
    titles: await column(`SELECT title FROM jobs WHERE status = 'live' ORDER BY md5(id || 'suggest-title'), id LIMIT 400`),
    companies: await column(`SELECT company FROM jobs WHERE status = 'live' ORDER BY md5(id || 'suggest-company'), id LIMIT 200`),
    cities: await column(`SELECT place_city FROM jobs WHERE status = 'live' AND place_city IS NOT NULL ORDER BY md5(id || 'suggest-city'), id LIMIT 200`),
    places
  };
}

const FILTER_KINDS = ['place', 'remote', 'pay', 'company', 'family', 'age'] as const;
type FilterKind = (typeof FILTER_KINDS)[number];

interface Case {
  text: string;
  /** The board's parameters, as an address carries them. */
  search: string;
  filters: FilterKind[];
}

/**
 * A partial query and a filter state, the way a reader produces them: a prefix
 * of a real title word, two words and a prefix, a place or a company cut short,
 * a pay, remote or age phrase beside a word, a title with a letter missing; and
 * between none and four of the six filters (place, remote list, pay floor or
 * "not listed", company, family, age), at a level the data has. At most four,
 * and four rarely: stacked, the filters leave nothing on a board this size and a
 * wall of zeros agrees with the board but proves little, so the report says how
 * many of the items count something.
 */
function caseGenerator(seed: number, pools: Pools) {
  const rnd = seeded(seed);
  const cut = (word: string, lo: number, hi: number) => word.slice(0, Math.min(word.length, lo + rnd.int(hi - lo + 1)));
  const wordsOf = (title: string) => title.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

  const text = (): string => {
    const title = wordsOf(rnd.pick(pools.titles));
    const first = title[0] ?? 'engineer';
    switch (rnd.int(13)) {
      case 0: return cut(first, 2, 5);
      case 1: return `${first} ${cut(title[1] ?? 'manager', 2, 5)}`;
      case 2: return cut(rnd.pick(pools.companies), 2, 4);
      case 3: return cut(rnd.pick(pools.cities), 2, 4);
      case 4: return `${first} ${cut(rnd.pick(pools.cities), 2, 4)}`;
      case 5: return `${first} remote`;
      case 6: return `${rnd.pick(['150k', '$120k', 'remote', 'hybrid', 'on-site', 'today', 'this week', 'last 14 days', '100-200k', '150,000'])} ${cut(first, 3, 5)}`;
      case 7: return title.slice(0, 3).join(' ');
      case 8: return first.length >= 6 ? first.slice(0, 2) + first.slice(3) : first; // a letter out: a typo
      case 9: return title.slice(0, 2).join(' ');
      case 10: return `${title.slice(0, 2).join(' ')} in ${cut(rnd.pick(pools.cities), 3, 5)}`;
      case 11: return rnd.pick(pools.companies);
      default: return `${title.slice(0, 2).join(' ')} ${cut(rnd.pick(pools.cities), 3, 4)} ${rnd.pick(['', 'remote', '150k'])}`.trim();
    }
  };

  const filter: Record<FilterKind, () => string> = {
    place: () => {
      const p = rnd.pick(pools.places);
      // A country, a country and region, or a city, whichever the row has at that level.
      const level = rnd.int(3);
      let key = p.country;
      if (level === 1 && p.admin1 !== null) key = `${p.country}-${p.admin1}`;
      if (level === 2 && p.city !== null) key = formatPlaceKey({ country: p.country, admin1: p.admin1, city: p.city });
      return `place=${encodeURIComponent(key)}`;
    },
    remote: () => {
      const kinds = rnd.pick([['remote'], ['remote'], ['hybrid'], ['onsite'], ['unstated'], ['remote', 'hybrid'], ['hybrid', 'onsite'], ['remote', 'onsite'], ['onsite', 'unstated'], ['remote', 'hybrid', 'onsite']]);
      // The old single-valued name is still read, so it is still asked.
      return kinds.length === 1 && rnd.int(5) === 0 ? `location=${kinds[0]}` : `remote=${kinds.join(',')}`;
    },
    pay: () => {
      const roll = rnd.int(20);
      if (roll < 14) return `pay_min=${rnd.pick([50, 100, 150, 200, 250, 300])}`;
      return roll < 17 ? 'pay_min=not-listed' : 'comp=not-listed';
    },
    company: () => `company=${encodeURIComponent(rnd.pick(pools.companies))}`,
    family: () => {
      const ids = [...FAMILY_IDS, 'unplaced'];
      return rnd.int(5) === 0 ? `fam=${rnd.pick(ids)}&fam=${rnd.pick(ids)}` : `fam=${rnd.pick(ids)}`;
    },
    age: () => {
      const roll = rnd.int(10);
      if (roll < 6) return `age_max=${rnd.pick([1, 3, 7, 14, 30, 60, 90])}`;
      if (roll < 8) return `age_min=${rnd.pick([1, 2, 3, 7])}&age_max=${rnd.pick([14, 30, 60])}`;
      return `age_min=${rnd.pick([7, 14, 30])}`;
    }
  };

  return (): Case => {
    const t = text();
    const count = rnd.pick([0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4]);
    const pool: FilterKind[] = [...FILTER_KINDS];
    const chosen: FilterKind[] = [];
    for (let k = 0; k < count; k += 1) chosen.push(pool.splice(rnd.int(pool.length), 1)[0] as FilterKind);
    chosen.sort((a, b) => FILTER_KINDS.indexOf(a) - FILTER_KINDS.indexOf(b));
    return { text: t, search: chosen.map((kind) => filter[kind]()).join('&'), filters: chosen };
  };
}

/* ---- the counts contract ---------------------------------------------------------- */

interface Mismatch {
  case: number;
  kind: 'item' | 'total';
  text: string;
  search: string;
  group?: string;
  id?: string;
  label?: string;
  href?: string;
  count: number;
  board: number;
}
interface StripViolation {
  case: number;
  invariant: string;
  text: string;
  search: string;
  sum: number;
  expected: number;
}
interface CaseOutcome {
  items: number;
  disabled: number;
  byGroup: Record<string, number>;
  countingByGroup: Record<string, number>;
  mismatches: Mismatch[];
  shape: string[];
  strip: StripViolation[];
  stripChecked: Record<string, number>;
  landingTotal: number;
  fuzzy: boolean;
  chips: boolean;
  offers: boolean;
  response: SuggestBody;
}

const addUp = (xs: Iterable<number>) => {
  let total = 0;
  for (const x of xs) total += x;
  return total;
};

/* ---- the run ----------------------------------------------------------------- */

let sample: Sample[] = [];
const startedAt = Date.now();
const log = (message: string) => process.stderr.write(`[eval ${String(Math.round((Date.now() - startedAt) / 1000)).padStart(4)}s] ${message}\n`);

describe('search engine evaluation', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set (.env.local supplies it locally). The harness will not pass by skipping.');
    const host = new URL(url).hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) && process.env.EVAL_ALLOW_REMOTE !== '1') {
      throw new Error(`DATABASE_URL points at ${host}, not at this machine. The latency figures mean "local Postgres"; set EVAL_ALLOW_REMOTE=1 to run anyway.`);
    }
    SWEEP = sweepDate();
    expect(SAMPLE_RULE, 'the sample rule coded here must be the one the baseline states').toBe(baseline.sample.rule);
    expect(Object.keys(baseline.query_rules), 'the five query types must be the baseline\'s').toEqual([...TYPES]);
    log(`sweep day ${SWEEP}, local database ${host}`);
  });

  afterAll(async () => {
    // beforeAll may have refused to start (no database, or not a local one).
    try {
      await db().end();
    } catch {
      /* no pool was ever made */
    }
  });

  it('draws the baseline\'s sample', async () => {
    // The rule, with the salt and the size bound instead of spliced in. The
    // columns beyond `id` are what the query constructions read.
    const { rows } = await db().query<Sample>(
      `SELECT id, title, company FROM jobs WHERE status='live' AND length(title)>=4 ORDER BY md5(id||$1) LIMIT $2`,
      [baseline.sample.salt, baseline.sample.size]
    );
    sample = rows;
    expect(sample).toHaveLength(baseline.sample.size);
    const { rows: live } = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE status='live'`);
    report.environment = {
      database: 'local Postgres (DATABASE_URL host is this machine)',
      live_rows: live[0].n,
      live_rows_at_baseline: dataBaseline.live_rows,
      sweep_date: SWEEP,
      sample: { salt: baseline.sample.salt, size: sample.length, rule: baseline.sample.rule },
      known_item_rows_fetched_per_query: RANK_DEPTH,
      board_page_size_for_latency_shapes: DEFAULT_PER_PAGE
    };
  });

  it('measures known-item retrieval, new engine and the old replica', async () => {
    // Warm both engines on queries that are not scored, so the first scored
    // query is not the one that pays for a cold plan cache.
    for (const row of sample.slice(0, 30)) await newEngine(row.title, RANK_DEPTH);
    for (const row of sample.slice(0, 10)) await oldEngine(row.title, RANK_DEPTH);

    const fresh: Record<string, TypeStats> = {};
    const replica: Record<string, TypeStats> = {};
    const misses: Record<string, Miss[]> = {};
    for (const type of TYPES) {
      const measured = await probeType(newEngine, sample, type);
      fresh[type] = summarise(measured.probes, true);
      misses[type] = measured.misses;
      log(`new  ${type.padEnd(16)} n=${fresh[type].n} hit@1=${fresh[type].hit1} hit@10=${fresh[type].hit10} title-eq@10=${fresh[type].title_equivalent_hit10} mrr=${fresh[type].mrr} zero=${fresh[type].zero_results} fuzzy=${fresh[type].fuzzy_rate} p50=${fresh[type].latency_ms.p50}ms`);
    }
    for (const type of TYPES) {
      replica[type] = summarise((await probeType(oldEngine, sample, type)).probes, false);
      log(`old  ${type.padEnd(16)} n=${replica[type].n} hit@1=${replica[type].hit1} hit@10=${replica[type].hit10} title-eq@10=${replica[type].title_equivalent_hit10} mrr=${replica[type].mrr} zero=${replica[type].zero_results} p50=${replica[type].latency_ms.p50}ms`);
    }

    // The ceiling for the two query types whose words ARE the title, from how
    // many live postings share each sampled title.
    const { rows: liveTitles } = await db().query<{ title: string }>(`SELECT title FROM jobs WHERE status='live'`);
    const sharing = new Map<string, number>();
    for (const { title } of liveTitles) sharing.set(fold(title), (sharing.get(fold(title)) ?? 0) + 1);
    const shared = sample.map((row) => sharing.get(fold(row.title)) ?? 1);
    const ceiling: Ceiling = {
      hit1: pct1(shared.reduce((sum, k) => sum + 1 / k, 0), sample.length),
      hit10: pct1(shared.reduce((sum, k) => sum + Math.min(1, 10 / k), 0), sample.length),
      share_of_sample_with_a_title_shared_by_more_than_ten: pct1(shared.filter((k) => k > 10).length, sample.length)
    };

    const mismatches = replicaMismatches(replica as Record<QueryType, TypeStats>);
    report.baseline_check = {
      replica_reproduces_committed_baseline: mismatches.length === 0,
      mismatches,
      checked: ['n', 'hit1', 'hit10', 'mrr', 'zero_results'],
      note: 'Every query type is replayed through the restated old engine and compared with docs/search-engine-baseline-search.json.'
    };
    report.known_item = Object.fromEntries(
      TYPES.map((type) => [
        type,
        {
          new: fresh[type],
          old_baseline: baseline.results[type],
          old_replica: replica[type],
          ...(type === 'title' || type === 'title_lower' ? { exact_id_ceiling: ceiling } : {}),
          new_title_misses: misses[type]
        }
      ])
    );
    // Not an assertion: a board that has changed since the baseline is a fact
    // about the board, not a defect in the harness. The report says it loudly.
    if (mismatches.length) log(`WARNING: the old-engine replica does not reproduce the committed baseline: ${mismatches.join('; ')}`);
  });

  it('measures the precision of the top ten for the most frequent live titles', async () => {
    const { rows: titles } = await db().query<{ t: string; n: number }>(
      `SELECT lower(btrim(title)) AS t, count(*)::int AS n FROM jobs WHERE status='live' GROUP BY 1 ORDER BY n DESC, t ASC LIMIT $1`,
      [PRECISION_QUERIES]
    );
    const rows: PrecisionRow[] = [];
    for (const { t, n } of titles) {
      const words = fold(t).split(' ').filter(Boolean);
      const precise = (hits: readonly Hit[]) => hits.filter((hit) => {
        const folded = fold(hit.title);
        return words.every((word) => folded.includes(word));
      }).length;
      const fresh = (await newEngine(t, 10)).hits;
      const old = (await oldEngine(t, 10)).hits;
      rows.push({ query: t, live_rows: n, new: { returned: fresh.length, precise: precise(fresh) }, old: { returned: old.length, precise: precise(old) } });
    }
    report.precision_at_10 = {
      definition: 'the share of the top-10 rows whose folded title contains every query word (as a substring of the folded title)',
      queries: 'the 40 most frequent distinct live titles (grouped by lower-cased, trimmed title; ties by title), each queried as typed',
      new: precisionSummary(rows, 'new'),
      old: precisionSummary(rows, 'old'),
      below_100: rows
        .filter((r) => r.new.precise < r.new.returned || r.old.precise < r.old.returned)
        .map((r) => ({ query: r.query, live_rows: r.live_rows, new: `${r.new.precise}/${r.new.returned}`, old: `${r.old.precise}/${r.old.returned}` })),
      per_query: rows
    };
    log(`precision@10 new ${report.precision_at_10.new.pooled_precision_at_10}% old ${report.precision_at_10.old.pooled_precision_at_10}%`);
  });

  it('measures the data: country coverage, regions, holdout accuracy, the classifier', async () => {
    const q = async <T extends Record<string, unknown>>(sql: string) => (await db().query<T>(sql)).rows;
    const [counts] = await q<{ live: number; upstream: number; placed: number }>(
      `SELECT count(*)::int AS live,
              count(*) FILTER (WHERE country ~ '^[A-Z]{2}$')::int AS upstream,
              count(*) FILTER (WHERE place_country IS NOT NULL)::int AS placed
         FROM jobs WHERE status='live'`
    );
    const regionRows = await q<{ derived_region: string | null; n: number }>(
      `SELECT derived_region, count(*)::int AS n FROM jobs WHERE status='live' GROUP BY 1`
    );
    const region: Record<string, number> = {};
    for (const r of [...regionRows].sort((a, b) => b.n - a.n || String(a.derived_region).localeCompare(String(b.derived_region)))) region[r.derived_region ?? '(null)'] = r.n;
    const [residual] = await q<{ upstream_coded: number; resolved: number; canada_upstream: number; canada_resolved: number; remote_unresolved: number }>(
      `SELECT count(*) FILTER (WHERE country ~ '^[A-Z]{2}$' AND country <> 'US' AND derived_region LIKE 'US %')::int AS upstream_coded,
              count(*) FILTER (WHERE place_country IS NOT NULL AND place_country <> 'US' AND derived_region LIKE 'US %')::int AS resolved,
              count(*) FILTER (WHERE country = 'CA' AND derived_region LIKE 'US %')::int AS canada_upstream,
              count(*) FILTER (WHERE place_country = 'CA' AND derived_region LIKE 'US %')::int AS canada_resolved,
              count(*) FILTER (WHERE country = 'remote_unresolved' AND derived_region LIKE 'US %')::int AS remote_unresolved
         FROM jobs WHERE status='live'`
    );
    const upstreamErrors = await q<{ country: string; place_country: string | null; derived_region: string; location: string; n: number }>(
      `SELECT country, place_country, derived_region, location, count(*)::int AS n
         FROM jobs WHERE status='live' AND country ~ '^[A-Z]{2}$' AND country <> 'US' AND derived_region LIKE 'US %'
        GROUP BY 1, 2, 3, 4 ORDER BY n DESC, location ASC, country ASC, derived_region ASC LIMIT 8`
    );

    // The place script, in report-only mode. It must not write a file: its own
    // --dry-run says it does not, and this checks that it did not, by hash and by git.
    const placeFile = at('src/data/place-cities.json');
    const before = sha256(readFileSync(placeFile));
    const run = spawnSync(process.execPath, ['scripts/build-place-table.mjs', '--dry-run'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`build-place-table.mjs --dry-run exited ${run.status}: ${run.stderr}`);
    const after = sha256(readFileSync(placeFile));
    const gitClean = spawnSync('git', ['diff', '--quiet', '--', 'src/data/place-cities.json'], { cwd: ROOT }).status === 0;
    const place = parsePlaceReport(run.stdout);

    // The classifier, computed the way job-family.test.ts computes it: each
    // distinct department/title pair weighted by the postings behind it.
    const doc = JSON.parse(gunzipSync(readFileSync(at(CLASSIFIER_FIXTURE))).toString()) as {
      pairs?: ReadonlyArray<readonly [string | null, string | null, number]>;
      jobs?: ReadonlyArray<{ department?: string | null; title?: string | null }>;
    };
    const weighted = doc.pairs
      ? doc.pairs.map(([department, title, weight]) => ({ department, title, weight }))
      : (doc.jobs ?? []).map((r) => ({ ...r, weight: 1 }));
    let total = 0;
    let classified = 0;
    for (const r of weighted) {
      total += r.weight;
      if (familyOf(r.department ?? null, r.title ?? null)) classified += r.weight;
    }

    report.data = {
      live_rows: { now: counts.live, baseline: dataBaseline.live_rows },
      country_coverage: {
        resolved_now: { rows: counts.placed, of: counts.live, pct: pct1(counts.placed, counts.live), source: 'jobs.place_country IS NOT NULL (what the board serves)' },
        upstream_code_now: { rows: counts.upstream, of: counts.live, pct: pct1(counts.upstream, counts.live), source: 'jobs.country is a two-letter code (the baseline\'s definition)' },
        upstream_code_baseline: { rows: dataBaseline.rows_with_country, of: dataBaseline.live_rows, pct: pct1(dataBaseline.rows_with_country, dataBaseline.live_rows) },
        script_agrees_with_column: place.coverage.placeof_country === counts.placed
      },
      place_script: place,
      place_script_output: run.stdout.split('\n').filter(Boolean),
      place_cities_json_unchanged: before === after && gitClean,
      place_cities_json_sha256: after,
      region_distribution: { now: region, baseline: dataBaseline.derived_region },
      non_us_country_in_a_us_region: {
        by_resolved_country_now: residual.resolved,
        by_upstream_code_now: residual.upstream_coded,
        by_upstream_code_baseline: dataBaseline.non_us_country_in_us_region,
        largest_upstream_code_cases: upstreamErrors
      },
      canada_in_a_us_region: { by_resolved_country_now: residual.canada_resolved, by_upstream_code_now: residual.canada_upstream },
      remote_unresolved_rows_in_a_us_region: residual.remote_unresolved
    };
    report.classifier = {
      source: CLASSIFIER_FIXTURE,
      postings: total,
      classified,
      coverage_now: round(classified / total, 4),
      coverage_before: CLASSIFIER_BEFORE,
      floor: CLASSIFIER_FLOOR,
      delta_points: round((100 * classified) / total - 100 * CLASSIFIER_BEFORE, 2)
    };
    log(`country coverage ${report.data.country_coverage.resolved_now.pct}%, classifier ${report.classifier.coverage_now}`);
    expect(place.coverage.placeof_country, 'the place script and the column must agree').toBe(counts.placed);
    expect(before, 'place-cities.json must be byte-identical after a dry run').toBe(after);
    expect(gitClean, 'git must see no change in place-cities.json').toBe(true);
  });

  it('runs the parser table', async () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('VITEST')) env[key] = value;
    const run = spawnSync(process.execPath, [at('node_modules/vitest/vitest.mjs'), 'run', 'src/lib/search-parse.test.ts', '--reporter=json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024
    });
    const start = run.stdout.indexOf('{"numTotalTestSuites"');
    if (start < 0) {
      report.parser_table = { measured: false, error: `no JSON from vitest (exit ${run.status})` };
      return;
    }
    const result = JSON.parse(run.stdout.slice(start)) as { numTotalTests: number; numPassedTests: number; numFailedTests: number };
    report.parser_table = { measured: true, file: 'src/lib/search-parse.test.ts', total: result.numTotalTests, passed: result.numPassedTests, failed: result.numFailedTests };
    log(`parser table ${result.numPassedTests}/${result.numTotalTests}`);
  });

  it('measures latency on the board\'s own shapes, warm', async () => {
    const load = { at_start: loadavg()[0] };
    const shapes: Record<string, unknown> = {};
    for (const shape of SHAPES) {
      const run = () => {
        const q = shape.filter.q ?? '';
        return listBoardFiltered({ ...BOARD, sweepDate: SWEEP, ...shape.filter, q, sort: defaultSortFor(q) });
      };
      for (let i = 0; i < LATENCY_WARMUP; i++) await run();
      const samples: number[] = [];
      let last = await run();
      for (let i = 0; i < LATENCY_RUNS; i++) {
        const started = performance.now();
        last = await run();
        samples.push(performance.now() - started);
      }
      shapes[shape.key] = { label: shape.label, runs: LATENCY_RUNS, total: last.total, fuzzy: last.fuzzy, latency_ms: latency(samples) };
      log(`latency ${shape.key.padEnd(24)} total=${last.total} fuzzy=${last.fuzzy} p50=${latency(samples).p50}ms p95=${latency(samples).p95}ms`);
    }
    report.latency_board_shapes = shapes;
    report.latency_load = { ...load, at_end: loadavg()[0], cpu_count: cpus().length };
  });

  it('reads the crawl instant and the vocabulary the suggest endpoint answers from', async () => {
    V = boardRowsLoadedAt(await getBoardStats()) ?? '';
    if (V === '') throw new Error('board_stats has no swept_at, so the board has no crawl instant: the suggest cache key and the counts cannot be measured');
    forgetLexicon();
    const built = performance.now();
    LEXICON = await getLexicon(V);
    const lexiconMs = performance.now() - built;
    POOLS = await drawPools();
    const { assembleMs: _assembleMs, loadMs: _loadMs, ...vocabulary } = LEXICON.stats;
    report.suggest_setup = {
      crawl_instant: V,
      vocabulary,
      pools: { titles: POOLS.titles.length, companies: POOLS.companies.length, cities: POOLS.cities.length, places: POOLS.places.length },
      latency_ms: { lexicon_build: round(lexiconMs, 1), lexicon_assemble: LEXICON.stats.assembleMs, lexicon_read: LEXICON.stats.loadMs }
    };
    log(`crawl instant ${V}, ${LEXICON.stats.titles} titles, ${LEXICON.stats.companies} companies, ${LEXICON.stats.cities} city keys; lexicon built in ${round(lexiconMs, 0)} ms`);
  });

  it('measures typeahead recall: is the posting\'s title among the completions', async () => {
    const variants: Record<string, unknown> = {};
    for (const [name, rule] of Object.entries(TYPEAHEAD_RULES)) {
      const misses: TypeaheadMiss[] = [];
      const probes = await mapLimit(sample, TYPEAHEAD_CONCURRENCY, async (row) => {
        const typed = rule(row);
        const { body } = await askSuggest(typed);
        const completions = itemsOf(body, 'titles');
        const wanted = fold(row.title);
        const rank = completions.findIndex((item) => fold(item.label) === wanted) + 1;
        const probe: TypeaheadProbe = {
          rank,
          none: completions.length === 0,
          chip: body.parsed.chips.length > 0,
          eligible: /[\p{L}\p{N}]/u.test(typed.split(/\s+/).pop() ?? '')
        };
        const miss: TypeaheadMiss | null = rank > 0 ? null : { title: row.title, typed, completions: completions.length, top3: completions.slice(0, 3).map((item) => item.label) };
        return { probe, miss };
      });
      for (const { miss } of probes) if (miss && misses.length < 8) misses.push(miss);
      const all = probes.map((p) => p.probe);
      variants[name] = { ...recallStats(all), where_the_typed_fragment_has_a_letter_or_digit: recallStats(all.filter((p) => p.eligible)), misses };
      const s = variants[name] as ReturnType<typeof recallStats>;
      log(`typeahead ${name.padEnd(12)} n=${s.n} top8=${s.in_top_8}% top1=${s.at_1}% median rank=${s.median_rank_when_found} none=${s.no_completions}%`);
    }
    report.typeahead_titles = {
      sample: sample.length,
      shown: COMPLETIONS_SHOWN,
      rules: {
        last_word_4: 'the title\'s words but the last, then the first four characters of its last word (whitespace-separated words, as the known-item rules cut them)',
        first_word_3: 'the first three characters of the title\'s first word',
        first_word_4: 'the first four characters of the title\'s first word',
        first_word_6: 'the first six characters of the title\'s first word'
      },
      hit: 'the sampled posting\'s folded title (the harness\'s fold) equals the folded label of an item in the response\'s titles group, which holds at most eight; rank is the 1-based position of that item',
      variants
    };
  });

  it('measures place and company typeahead', async () => {
    const rnd = seeded(20261004);
    const query = async <T extends Record<string, unknown>>(text: string, params: unknown[]) => (await db().query<T>(text, params)).rows;
    interface NameProbeOut {
      n: number;
      found: number;
      found_pct: number;
      at_1_pct: number;
      median_rank_when_found: number | null;
      by_letters: Record<string, { n: number; found_pct: number }>;
      misses: { typed: string; wanted: string; offered: string[] }[];
    }
    const summarise = (probes: { typed: string; wanted: string; rank: number; letters: number; offered: string[] }[]): NameProbeOut => {
      const found = probes.filter((p) => p.rank > 0);
      const byLetters: NameProbeOut['by_letters'] = {};
      for (const letters of [...new Set(probes.map((p) => p.letters))].sort()) {
        const own = probes.filter((p) => p.letters === letters);
        byLetters[String(letters)] = { n: own.length, found_pct: pct1(own.filter((p) => p.rank > 0).length, own.length) };
      }
      return {
        n: probes.length,
        found: found.length,
        found_pct: pct1(found.length, probes.length),
        at_1_pct: pct1(found.filter((p) => p.rank === 1).length, probes.length),
        median_rank_when_found: median(found.map((p) => p.rank)),
        by_letters: byLetters,
        misses: probes.filter((p) => p.rank === 0).slice(0, 8).map((p) => ({ typed: p.typed, wanted: p.wanted, offered: p.offered.slice(0, 3) }))
      };
    };
    const placeProbe = async (row: { country: string; admin1: string | null; city: string }, letters: number) => {
      const key = formatPlaceKey({ country: row.country, admin1: row.admin1 || null, city: row.city });
      const typed = row.city.slice(0, letters).trim();
      const { body } = await askSuggest(typed);
      const offered = itemsOf(body, 'places');
      return { typed, wanted: key, rank: offered.findIndex((i) => i.id === `place:${key}`) + 1, letters, offered: offered.map((i) => i.id.slice('place:'.length)) };
    };
    const companyProbe = async (row: { company: string }, letters: number) => {
      const typed = row.company.slice(0, letters).trim();
      const { body } = await askSuggest(typed);
      const offered = itemsOf(body, 'companies');
      return { typed, wanted: row.company, rank: offered.findIndex((i) => i.id === `company:${row.company}`) + 1, letters, offered: offered.map((i) => i.label) };
    };

    // Rows: 200 live rows with a resolved city, drawn by hash. A big city or company is
    // as likely as its share of the board, which is how a reader meets one.
    const placeRows = await query<{ country: string; admin1: string | null; city: string }>(
      `SELECT place_country AS country, place_admin1 AS admin1, place_city AS city FROM jobs
        WHERE status = 'live' AND place_country IS NOT NULL AND place_city IS NOT NULL AND length(place_city) >= 3
        ORDER BY md5(id || $1), id LIMIT $2`,
      ['typeahead-place', TYPEAHEAD_ROWS]
    );
    const companyRows = await query<{ company: string }>(
      `SELECT company FROM jobs WHERE status = 'live' AND length(company) >= 4 ORDER BY md5(id || $1), id LIMIT $2`,
      ['typeahead-company', TYPEAHEAD_ROWS]
    );
    // Distinct names, each equally likely: a small city or a rare company is as likely as London,
    // which is the harder question, because a prefix of a rare name is shared with many bigger ones.
    const placeNames = await query<{ country: string; admin1: string | null; city: string }>(
      `SELECT place_country AS country, place_admin1 AS admin1, place_city AS city FROM jobs
        WHERE status = 'live' AND place_country IS NOT NULL AND place_city IS NOT NULL AND length(place_city) >= 3
        GROUP BY place_country, place_admin1, place_city
        ORDER BY md5(place_country || '|' || coalesce(place_admin1, '') || '|' || place_city || $1), place_country, place_admin1, place_city LIMIT $2`,
      ['typeahead-place-distinct', TYPEAHEAD_ROWS]
    );
    const companyNames = await query<{ company: string }>(
      `SELECT company FROM jobs WHERE status = 'live' AND length(company) >= 4 GROUP BY company ORDER BY md5(company || $1), company LIMIT $2`,
      ['typeahead-company-distinct', TYPEAHEAD_ROWS]
    );

    const lettersFor = (n: number) => Array.from({ length: n }, () => 3 + rnd.int(3));
    const placeLetters = lettersFor(placeRows.length);
    const placeNameLetters = lettersFor(placeNames.length);
    const placeByRow = summarise(await mapLimit(placeRows, TYPEAHEAD_CONCURRENCY, (row, at) => placeProbe(row, placeLetters[at] as number)));
    const placeByName = summarise(await mapLimit(placeNames, TYPEAHEAD_CONCURRENCY, (row, at) => placeProbe(row, placeNameLetters[at] as number)));
    const companyByRow = summarise(await mapLimit(companyRows, TYPEAHEAD_CONCURRENCY, (row) => companyProbe(row, 4)));
    const companyByName = summarise(await mapLimit(companyNames, TYPEAHEAD_CONCURRENCY, (row) => companyProbe(row, 4)));
    report.typeahead_names = {
      place: {
        rule: 'the first 3, 4 or 5 characters of the city (chosen by the seeded generator), typed alone; hit when the response\'s places group holds the row\'s place key (country, region when it has one, city exactly as stored)',
        by_row: placeByRow,
        by_distinct_name: placeByName,
        distinct_names_in_the_row_sample: new Set(placeRows.map((r) => formatPlaceKey({ country: r.country, admin1: r.admin1 || null, city: r.city }))).size
      },
      company: {
        rule: 'the first 4 characters of the company name, typed alone; hit when the response\'s companies group holds that exact name',
        by_row: companyByRow,
        by_distinct_name: companyByName,
        distinct_names_in_the_row_sample: new Set(companyRows.map((r) => r.company)).size
      },
      group_size: SUGGEST_GROUP_MAX
    };
    log(`place typeahead by row ${placeByRow.found_pct}% (${placeByName.found_pct}% by distinct name); company by row ${companyByRow.found_pct}% (${companyByName.found_pct}% by distinct name)`);
  });

  it('holds the counts contract at scale: every count is the rows its row returns', async () => {
    const next = caseGenerator(CONTRACT_SEED, POOLS);
    const cases = Array.from({ length: CONTRACT_CASES }, next);
    boardTotals.clear();

    const outcomes: CaseOutcome[] = [];
    for (const [i, c] of cases.entries()) {
      // Cold: every count in this answer is taken from the store, none from the memo.
      forgetSuggestMemo();
      const asked = await askSuggest(c.text, c.search);
      const body = asked.body;
      const shape: string[] = [];
      const mismatches: Mismatch[] = [];
      if (asked.status !== 200) shape.push(`status ${asked.status}`);
      if (body.v !== V) shape.push(`v is ${JSON.stringify(body.v)}, not the crawl instant`);
      if (body.q !== c.text) shape.push('q is not the text sent');
      if (body.groups.map((g) => g.type).join() !== 'titles,places,companies,facts') shape.push('the groups are not titles, places, companies, facts in that order');

      // What the board shows for the text as typed, and its strip's counts.
      const landing = landingFor(c.text, c.search);
      const filter = boardFilterOf(landing);
      const page = await listBoardFiltered(filter);
      if (body.total !== page.total) mismatches.push({ case: i, kind: 'total', text: c.text, search: c.search, count: body.total, board: page.total });

      const flat = body.groups.flatMap((g) => g.items.map((item) => ({ group: g.type, item })));
      const boardCounts = await mapLimit(flat, ORACLE_CONCURRENCY, async ({ item }) => boardTotalAt(item.href));
      const byGroup: Record<string, number> = {};
      const countingByGroup: Record<string, number> = {};
      let disabled = 0;
      for (const [at, { group, item }] of flat.entries()) {
        byGroup[group] = (byGroup[group] ?? 0) + 1;
        if (item.disabled) disabled += 1;
        else countingByGroup[group] = (countingByGroup[group] ?? 0) + 1;
        if (item.count !== boardCounts[at]) {
          mismatches.push({ case: i, kind: 'item', text: c.text, search: c.search, group, id: item.id, label: item.label, href: item.href, count: item.count, board: boardCounts[at] as number });
        }
        if (item.disabled !== (item.count === 0)) shape.push(`${item.id}: disabled is ${item.disabled} for a count of ${item.count}`);
      }
      for (const g of body.groups) if (g.items.length > SUGGEST_GROUP_MAX) shape.push(`${g.type} holds ${g.items.length} items`);

      // The strip's invariants on the board the text lands on. Each total taken with the control
      // let go is the board's own, and when the control is not set it is the page's total.
      const strip: StripViolation[] = [];
      const stripChecked: Record<string, number> = {};
      const totalWith = async (over: Partial<BoardFilter>) => (await listBoardFiltered({ ...filter, ...over })).total;
      const check = (invariant: string, got: number, expected: number) => {
        stripChecked[invariant] = (stripChecked[invariant] ?? 0) + 1;
        if (got !== expected) strip.push({ case: i, invariant, text: c.text, search: c.search, sum: got, expected });
      };
      const remoteSet = landing.remote.length > 0;
      const placeSet = landing.place !== null;
      const paySet = landing.payMin !== null || landing.compNotListed || landing.comp !== 'all';
      const kinds = page.counts.remote;
      check(remoteSet ? 'remote kinds sum to the remote-free total (remote set)' : 'remote kinds sum to the total (no remote filter)', kinds.remote + kinds.hybrid + kinds.onsite + kinds.unstated, remoteSet ? await totalWith({ remote: [], location: 'all' }) : page.total);
      check(placeSet ? 'countries + not stated sum to the place-free total (place set)' : 'countries + not stated sum to the total (no place filter)', addUp(Object.values(page.counts.place.countries)) + page.counts.place.notStated, placeSet ? await totalWith({ place: null }) : page.total);
      check(paySet ? 'pay any equals the pay-free total (pay set)' : 'pay any equals the total (no pay filter)', page.counts.pay.any, paySet ? await totalWith({ payMin: null, comp: 'all', compNotListed: false }) : page.total);

      const parse = body.parsed;
      outcomes.push({
        items: flat.length,
        disabled,
        byGroup,
        countingByGroup,
        mismatches,
        shape,
        strip,
        stripChecked,
        landingTotal: page.total,
        fuzzy: page.fuzzy,
        chips: parse.chips.length > 0,
        offers: parse.offers.length > 0,
        response: body
      });
      if ((i + 1) % 100 === 0) log(`contract ${i + 1}/${CONTRACT_CASES}: ${addUp(outcomes.map((o) => o.items))} items, ${addUp(outcomes.map((o) => o.mismatches.length))} mismatches`);
    }

    // The memo must be invisible. Every case again, the memo emptied once and then
    // left to fill as it would in a process that serves them all: each answer must be
    // the one the cold pass gave (and the cold pass's items were each checked above).
    forgetSuggestMemo();
    const differing: { case: number; text: string; search: string }[] = [];
    for (const [i, c] of cases.entries()) {
      const again = await askSuggest(c.text, c.search);
      if (again.status !== 200 || JSON.stringify(again.body) !== JSON.stringify((outcomes[i] as CaseOutcome).response)) differing.push({ case: i, text: c.text, search: c.search });
    }

    const allMismatches = outcomes.flatMap((o) => o.mismatches);
    const itemMismatches = allMismatches.filter((m) => m.kind === 'item');
    const stripViolations = outcomes.flatMap((o) => o.strip);
    const stripChecked: Record<string, number> = {};
    for (const o of outcomes) for (const [k, n] of Object.entries(o.stripChecked)) stripChecked[k] = (stripChecked[k] ?? 0) + n;
    const countingByGroup: Record<string, number> = {};
    for (const o of outcomes) for (const [g, n] of Object.entries(o.countingByGroup)) countingByGroup[g] = (countingByGroup[g] ?? 0) + n;
    const violationsBy: Record<string, number> = {};
    for (const v of stripViolations) violationsBy[v.invariant] = (violationsBy[v.invariant] ?? 0) + 1;
    const byGroup: Record<string, number> = {};
    for (const o of outcomes) for (const [g, n] of Object.entries(o.byGroup)) byGroup[g] = (byGroup[g] ?? 0) + n;
    const byNumber: Record<string, number> = {};
    const byKind: Record<string, number> = Object.fromEntries(FILTER_KINDS.map((k) => [k, 0]));
    for (const c of cases) {
      byNumber[String(c.filters.length)] = (byNumber[String(c.filters.length)] ?? 0) + 1;
      for (const k of c.filters) byKind[k] = (byKind[k] ?? 0) + 1;
    }
    const items = addUp(outcomes.map((o) => o.items));
    report.counts_contract = {
      definition: 'for every item of every group, item.count must equal the total the board shows at the item\'s href (parseBoardQuery of the href, then listBoardFiltered); the response\'s total must equal what the board shows for the text as typed (landing as board.astro decides it); and item.disabled must be count === 0',
      seed: CONTRACT_SEED,
      cases: cases.length,
      memo: 'emptied before each case (every count comes from the store); a second pass leaves it to fill',
      filter_states: { by_number_of_filters: byNumber, by_kind: byKind, cases_with_no_filter: byNumber['0'] ?? 0 },
      text: {
        cases_whose_text_states_a_fact: outcomes.filter((o) => o.chips).length,
        cases_with_an_offer: outcomes.filter((o) => o.offers).length,
        cases_the_board_answers_on_the_typo_path: outcomes.filter((o) => o.fuzzy).length,
        cases_whose_total_is_zero: outcomes.filter((o) => o.landingTotal === 0).length
      },
      totals_checked: outcomes.length,
      total_mismatches: allMismatches.length - itemMismatches.length,
      items_checked: items,
      items_by_group: byGroup,
      items_that_count_something_by_group: countingByGroup,
      items_with_count_zero: addUp(outcomes.map((o) => o.disabled)),
      distinct_addresses_counted_by_the_board: boardTotals.size,
      item_mismatches: itemMismatches.length,
      mismatches: allMismatches.length,
      first_mismatches: allMismatches.slice(0, MISMATCHES_LISTED),
      shape_violations: outcomes.flatMap((o, i) => o.shape.map((s) => `case ${i}: ${s}`)).slice(0, MISMATCHES_LISTED),
      shape_violation_count: addUp(outcomes.map((o) => o.shape.length)),
      memo_pass: { cases: cases.length, identical_to_the_cold_answer: cases.length - differing.length, differing: differing.slice(0, MISMATCHES_LISTED) },
      strip_invariants: {
        definition: 'on the board each case\'s text lands on, from listBoardFiltered\'s counts: remote kinds (remote + hybrid + onsite + unstated) sum to the total with no remote filter; country counts + the not-stated count sum to the total with no place filter; pay.any is the total with no pay filter. When the control IS set, the comparison is with the same board taken with that control let go.',
        checked: stripChecked,
        states_checked: outcomes.length,
        violations: stripViolations.length,
        violations_by_invariant: violationsBy,
        first_violations: stripViolations.slice(0, MISMATCHES_LISTED)
      }
    };
    if (allMismatches.length) log(`WARNING: the counts contract has ${allMismatches.length} mismatches (${itemMismatches.length} items); the first is ${JSON.stringify(allMismatches[0])}`);
    if (stripViolations.length) log(`WARNING: ${stripViolations.length} strip invariant violations; the first is ${JSON.stringify(stripViolations[0])}`);
    log(`counts contract: ${cases.length} cases, ${items} items, ${allMismatches.length} mismatches; strip ${addUp(Object.values(stripChecked))} checks, ${stripViolations.length} violations; memo pass ${cases.length - differing.length}/${cases.length} identical`);
  });

  it('measures suggest latency, cold and warm', async () => {
    const next = caseGenerator(LATENCY_SEED, POOLS);
    const cases = Array.from({ length: LATENCY_CASES }, next);
    const warmup = caseGenerator(LATENCY_SEED + 1, POOLS);
    const load = { at_start: loadavg()[0] };
    for (let i = 0; i < LATENCY_WARMUP_CASES; i++) {
      const c = warmup();
      await askSuggest(c.text, c.search);
    }
    // Cold: the in-process memo emptied before each request, so every count is taken from the
    // store. The process itself is warm (the vocabulary is built, the connections are open).
    const cold: { ms: number; text: string; search: string; rows: number }[] = [];
    let failed = 0;
    for (const c of cases) {
      forgetSuggestMemo();
      const r = await askSuggest(c.text, c.search);
      if (r.status !== 200) failed += 1;
      cold.push({ ms: r.ms, text: c.text, search: c.search, rows: r.body.total });
    }
    // Warm: the same request asked straight after an identical one, so the memo holds its counts.
    const warm: number[] = [];
    for (const c of cases) {
      await askSuggest(c.text, c.search);
      const r = await askSuggest(c.text, c.search);
      if (r.status !== 200) failed += 1;
      warm.push(r.ms);
    }
    const shown = (samples: readonly number[]) => ({ ...latency(samples), share_under_100_ms: pct1(samples.filter((x) => x < 100).length, samples.length) });
    const byNumber: Record<string, number> = {};
    for (const c of cases) byNumber[String(c.filters.length)] = (byNumber[String(c.filters.length)] ?? 0) + 1;
    // What decides a cold request's cost is the rows its words match (every count that
    // carries them reads those rows), so the same requests are also cut by that.
    const buckets = ROWS_BUCKETS.map((b) => ({ ...b, own: cold.filter((x) => x.rows >= b.lo && x.rows < b.hi) }));
    report.suggest_latency = {
      seed: LATENCY_SEED,
      cold_requests_by_rows_the_board_shows: Object.fromEntries(buckets.map((b) => [b.label, b.own.length])),
      queries: cases.length,
      queries_with_a_filter: cases.filter((c) => c.filters.length > 0).length,
      by_number_of_filters: byNumber,
      requests_that_failed: failed,
      latency_ms: {
        cold: shown(cold.map((x) => x.ms)),
        warm: shown(warm),
        cold_by_rows_the_board_shows: Object.fromEntries(buckets.map((b) => [b.label, b.own.length > 0 ? shown(b.own.map((x) => x.ms)) : null])),
        slowest_cold: [...cold].sort((a, b) => b.ms - a.ms).slice(0, 5).map((x) => ({ text: x.text, search: x.search, ms: round(x.ms, 1) })),
        load: { ...load, at_end: loadavg()[0], cpu_count: cpus().length }
      }
    };
    const l = report.suggest_latency.latency_ms;
    log(`suggest latency cold p50=${l.cold.p50} p95=${l.cold.p95} p99=${l.cold.p99} under100=${l.cold.share_under_100_ms}%; warm p50=${l.warm.p50} p95=${l.warm.p95}`);
  });

  it('checks the cache key: v is the crawl instant, a stale v is answered no-store', async () => {
    const instant = boardRowsLoadedAt(await getBoardStats());
    const SHARED = 'public, max-age=60, s-maxage=86400, stale-while-revalidate=600';
    const STALE_V = '2020-01-01T00:00:00.000Z';
    const current = await askSuggest('des');
    const again = await askSuggest('des');
    const stale = await askSuggest('des', '', STALE_V);
    const none = await askSuggest('des', '', null);
    const empty = await askSuggest('des', '', '');
    const titled = await askSuggest('des', `title=${encodeURIComponent('Product Designer')}`);
    const cases = [
      { request: 'v is the current crawl instant', r: current, cache: SHARED },
      { request: `v is a stale instant (${STALE_V})`, r: stale, cache: 'no-store' },
      { request: 'no v at all', r: none, cache: 'no-store' },
      { request: 'v is empty', r: empty, cache: 'no-store' },
      { request: 'v is current but the address names a Desk title, so the answer depends on who asks', r: titled, cache: 'private, no-store' }
    ].map(({ request, r, cache }) => ({
      request,
      status: r.status,
      cache_control: r.cacheControl,
      expected_cache_control: cache,
      body_v: r.body.v,
      ok: r.status === 200 && r.cacheControl === cache && r.body.v === instant
    }));
    const checks = [
      { check: 'the response carries the board load instant (boardRowsLoadedAt of board_stats) as v', ok: instant !== null && current.body.v === instant },
      { check: 'the same request asked twice gets the same body', ok: JSON.stringify(current.body) === JSON.stringify(again.body) },
      { check: 'a stale-v request is answered with the current counts, not the stale ones', ok: JSON.stringify(stale.body) === JSON.stringify(current.body) }
    ];
    report.suggest_cache_key = {
      how: 'The endpoint\'s own GET handler is called in this process and the Cache-Control header it returns is read. A CDN honouring it is not part of this.',
      board_load_instant: instant,
      cases,
      checks,
      all_pass: cases.every((c) => c.ok) && checks.every((c) => c.ok)
    };
    log(`cache key: ${cases.filter((c) => c.ok).length}/${cases.length} requests and ${checks.filter((c) => c.ok).length}/${checks.length} checks ok`);
  });

  it('writes docs/search-engine-metrics.md and .json', async () => {
    const known = section('known_item') as Record<QueryType, { new: TypeStats; old_baseline: BaselineType; old_replica: TypeStats; exact_id_ceiling?: Ceiling }>;
    const data = section('data');
    const classifier = section('classifier');
    const parser = section('parser_table');
    const shapes = section('latency_board_shapes') as Record<string, { label: string; total: number; fuzzy: boolean; latency_ms: { p50: number; p95: number } }>;
    const precision = section('precision_at_10');
    const check = section('baseline_check');
    const environment = section('environment');
    const suggestSetup = section('suggest_setup');
    const typeahead = section('typeahead_titles');
    const names = section('typeahead_names');
    const contract = section('counts_contract');
    const suggestLatency = section('suggest_latency');
    const cacheKey = section('suggest_cache_key');

    /* ---- the targets table -------------------------------------------------- */
    const targets: Target[] = [];
    const verdict = (ok: boolean): 'PASS' | 'MISS' => (ok ? 'PASS' : 'MISS');

    const resolved = data.country_coverage.resolved_now;
    targets.push({
      measure: 'live rows with a resolved country',
      target: 'from 42% to >= 85%',
      measured: `${resolved.pct}% (${num(resolved.rows)} of ${num(resolved.of)}); the baseline file says ${data.country_coverage.upstream_code_baseline.pct}%, not 42%`,
      verdict: verdict(resolved.rows / resolved.of >= 0.85),
      note: 'The largest unresolved strings are "Multiple Locations", "N Locations", "Remote", blank and "Worldwide": places the text does not name.'
    });
    const holdoutA = data.place_script.holdout_by_row as PlaceHoldout;
    const holdoutB = data.place_script.holdout_by_string as PlaceHoldout;
    targets.push({
      measure: 'place holdout accuracy',
      target: '>= 97%',
      measured: `${holdoutA.accuracy_pct}% by row (${holdoutA.correct}/${holdoutA.resolved}); ${holdoutB.accuracy_pct}% by never-seen string (${holdoutB.correct}/${holdoutB.resolved})`,
      verdict: verdict(holdoutA.correct / holdoutA.resolved >= 0.97 && holdoutB.correct / holdoutB.resolved >= 0.97),
      note: `Against the upstream code. ${holdoutA.misses_where_text_names_the_other_country} of ${holdoutA.resolved - holdoutA.correct} and ${holdoutB.misses_where_text_names_the_other_country} of ${holdoutB.resolved - holdoutB.correct} misses are rows where the text spells out the other country (Albuquerque, New Mexico coded MX), so the upstream code is the likelier error.`
    });
    const nonUs = data.non_us_country_in_a_us_region;
    targets.push({
      measure: 'non-US countries in a US region',
      target: '0',
      measured: `${nonUs.by_resolved_country_now} by resolved country; ${nonUs.by_upstream_code_now} by upstream code (baseline ${num(nonUs.by_upstream_code_baseline)})`,
      verdict: verdict(nonUs.by_resolved_country_now === 0),
      note: 'Judged on the resolved country, which is what the region now reads. The upstream-code residue is rows whose text names a US place (see the data section).'
    });

    const oldReplica = (type: QueryType) => known[type].old_replica;
    for (const type of TYPES) {
      const k = known[type];
      const cap = k.exact_id_ceiling;
      targets.push({
        measure: `known-item hit@10, ${type} (exact id)`,
        target: '>= 95%, and >= old',
        measured: `${k.new.hit10}% (old ${k.old_baseline.hit10}%)`,
        verdict: verdict(k.new.hit10 >= 95 && k.new.hit10 >= k.old_baseline.hit10),
        note: cap
          ? `No engine can reach the target by exact id on this sample: ${cap.share_of_sample_with_a_title_shared_by_more_than_ten}% of the sampled postings share their title with more than ten others, which caps hit@10 at ${cap.hit10}%.`
          : undefined
      });
    }
    const titleNew = known.title.new;
    targets.push({
      measure: 'known-item hit@10, title (title-equivalent)',
      target: '>= 95%, and >= old',
      measured: `${titleNew.title_equivalent_hit10}% (old ${oldReplica('title').title_equivalent_hit10}%)`,
      verdict: verdict(titleNew.title_equivalent_hit10 >= 95 && titleNew.title_equivalent_hit10 >= oldReplica('title').title_equivalent_hit10),
      note: 'Counts a hit when the top ten holds any posting with the same folded title: many postings share one title, so the exact id can sit past ten among identical rows.'
    });
    const typo = known.one_typo;
    targets.push({
      measure: 'typo hit@10, new (exact id)',
      target: '>= 80%',
      measured: `${typo.new.hit10}% (old ${typo.old_baseline.hit10}%)`,
      verdict: verdict(typo.new.hit10 >= 80)
    });
    targets.push({
      measure: 'typo hit@10, new (title-equivalent)',
      target: '>= 80%',
      measured: `${typo.new.title_equivalent_hit10}% (old ${oldReplica('one_typo').title_equivalent_hit10}%)`,
      verdict: verdict(typo.new.title_equivalent_hit10 >= 80)
    });
    targets.push(
      parser.measured
        ? { measure: 'parser table', target: '100%', measured: `${parser.passed} of ${parser.total} cases pass`, verdict: verdict(parser.failed === 0 && parser.total > 0) }
        : { measure: 'parser table', target: '100%', measured: parser.error, verdict: 'NOT MEASURED' }
    );
    targets.push({
      measure: 'classifier coverage floor',
      target: '>= 0.90',
      measured: `${classifier.coverage_now} (was ${classifier.coverage_before})`,
      verdict: verdict(classifier.classified / classifier.postings >= CLASSIFIER_FLOOR)
    });
    const slow = Object.entries(shapes).filter(([, s]) => s.latency_ms.p95 > 150);
    targets.push({
      measure: 'search p95, local',
      target: '<= 150 ms',
      measured: Object.values(shapes).map((s) => `${s.latency_ms.p95}`).join(' / ') + ' ms across the six shapes',
      verdict: verdict(slow.length === 0),
      note: slow.length ? `Over: ${slow.map(([, s]) => s.label).join('; ')}.` : undefined
    });
    const cold = suggestLatency.latency_ms.cold;
    const warm = suggestLatency.latency_ms.warm;
    targets.push({
      measure: 'suggest p95, local',
      target: `<= ${SUGGEST_P95_TARGET_MS} ms`,
      measured: `${cold.p95} ms cold (memo emptied before each of ${suggestLatency.queries} requests), ${warm.p95} ms warm; ${cold.share_under_100_ms}% of cold requests under 100 ms`,
      verdict: verdict(cold.p95 <= SUGGEST_P95_TARGET_MS && suggestLatency.requests_that_failed === 0),
      note: 'Judged on the cold figure, the slower of the two: it is the first request for text the process has not counted before. Warm is a repeat of a request just made. Local Postgres, the handler called in process: no network, no CDN.'
    });
    const checksMade = contract.items_checked + contract.totals_checked;
    targets.push({
      measure: 'counts contract exactness',
      target: '100%',
      measured: `${num(checksMade - contract.mismatches)} of ${num(checksMade)} exact (${num(contract.items_checked)} items, ${num(contract.totals_checked)} totals, ${contract.cases} seeded cases); ${contract.mismatches} mismatches, ${contract.shape_violation_count} shape violations, ${contract.memo_pass.identical_to_the_cold_answer} of ${contract.memo_pass.cases} memo answers identical to the cold ones`,
      verdict: verdict(contract.mismatches === 0 && contract.shape_violation_count === 0 && contract.memo_pass.identical_to_the_cold_answer === contract.memo_pass.cases && contract.items_checked > 0)
    });
    targets.push({
      measure: 'strip invariants (exclusive groups sum to the total)',
      target: '0 violations',
      measured: `${contract.strip_invariants.violations} violations in ${num(addUp(Object.values(contract.strip_invariants.checked) as number[]))} checks over ${contract.strip_invariants.states_checked} boards`,
      verdict: verdict(contract.strip_invariants.violations === 0 && contract.strip_invariants.states_checked > 0)
    });
    targets.push({
      measure: 'suggest cache key',
      target: 'v is the board load instant; a stale v is answered no-store with the current v',
      measured: `${cacheKey.cases.filter((c: { ok: boolean }) => c.ok).length} of ${cacheKey.cases.length} requests and ${cacheKey.checks.filter((c: { ok: boolean }) => c.ok).length} of ${cacheKey.checks.length} checks as expected`,
      verdict: verdict(cacheKey.all_pass === true),
      note: 'Through the route\'s own GET handler called in process; the header it returns is read, a CDN honouring it is not tested.'
    });

    /* ---- the JSON ------------------------------------------------------------ */
    // Not trimmed: a porcelain line starts with a space when only the work tree changed.
    const git = (args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.replace(/\n+$/, '');
    const full: Record<string, unknown> = {
      meta: {
        generated_by: 'npm run eval:search (test/eval/search.eval.ts)',
        measured_at: new Date().toISOString(),
        elapsed_s: Math.round((Date.now() - startedAt) / 1000),
        head: git(['rev-parse', '--short', 'HEAD']),
        engine_files_modified_in_tree: git(['status', '--porcelain', '--', 'src/lib/job-store.ts', 'src/lib/board-query.ts', 'src/lib/jobs-derived.mjs', 'src/lib/search-suggest.ts', 'src/lib/search-lexicon.ts', 'src/pages/board/suggest.ts']).split('\n').filter(Boolean),
        node: process.version,
        load: report.latency_load
      },
      environment,
      contract: {
        baseline_file: 'docs/search-engine-baseline-search.json',
        baseline_measured_at: baseline.measured_at,
        baseline_engine: baseline.engine,
        query_rules: baseline.query_rules,
        metric_rules: baseline.metric_rules,
        percentiles: 'nearest rank'
      },
      baseline_check: check,
      known_item: report.known_item,
      precision_at_10: precision,
      data,
      classifier,
      parser_table: parser,
      latency_board_shapes: shapes,
      suggest_setup: suggestSetup,
      typeahead_titles: typeahead,
      typeahead_names: names,
      counts_contract: contract,
      suggest_latency: suggestLatency,
      suggest_cache_key: cacheKey,
      targets
    };
    full.fingerprint = fingerprintOf(full);
    writeFileSync(at('docs/search-engine-metrics.json'), JSON.stringify(full, null, 2) + '\n');
    writeFileSync(at('docs/search-engine-metrics.md'), renderMarkdown(full as unknown as Rendered));
    log(`wrote docs/search-engine-metrics.{md,json}, fingerprint ${String(full.fingerprint).slice(0, 12)}`);
  });
});

/* ---- the markdown ------------------------------------------------------------ */

interface Rendered {
  meta: { measured_at: string; elapsed_s: number; head: string; engine_files_modified_in_tree: string[]; node: string; load: { at_start: number; at_end: number; cpu_count: number } };
  environment: { live_rows: number; live_rows_at_baseline: number; sweep_date: string; sample: { salt: string; size: number }; board_page_size_for_latency_shapes: number };
  contract: { baseline_measured_at: string; baseline_engine: string; query_rules: Record<string, string>; metric_rules: string };
  baseline_check: { replica_reproduces_committed_baseline: boolean; mismatches: string[] };
  known_item: Record<QueryType, { new: TypeStats; old_baseline: BaselineType; old_replica: TypeStats; exact_id_ceiling?: Ceiling; new_title_misses: Miss[] }>;
  precision_at_10: { new: ReturnType<typeof precisionSummary>; old: ReturnType<typeof precisionSummary>; below_100: { query: string; live_rows: number; new: string; old: string }[] };
  data: any;
  classifier: { source: string; postings: number; classified: number; coverage_now: number; coverage_before: number; floor: number; delta_points: number };
  parser_table: { measured: boolean; total?: number; passed?: number; failed?: number; error?: string };
  latency_board_shapes: Record<string, { label: string; total: number; fuzzy: boolean; latency_ms: { p50: number; p95: number; p99: number; max: number } }>;
  suggest_setup: { crawl_instant: string; vocabulary: Record<string, number>; latency_ms: { lexicon_build: number; lexicon_assemble: number; lexicon_read: number } };
  typeahead_titles: {
    sample: number;
    shown: number;
    rules: Record<string, string>;
    variants: Record<string, RecallRow & { where_the_typed_fragment_has_a_letter_or_digit: RecallRow; misses: TypeaheadMiss[] }>;
  };
  typeahead_names: Record<'place' | 'company', { by_row: NameRow; by_distinct_name: NameRow; distinct_names_in_the_row_sample: number }>;
  counts_contract: any;
  suggest_latency: { queries: number; queries_with_a_filter: number; by_number_of_filters: Record<string, number>; cold_requests_by_rows_the_board_shows: Record<string, number>; requests_that_failed: number; latency_ms: { cold: LatencyRow; warm: LatencyRow; cold_by_rows_the_board_shows: Record<string, LatencyRow | null>; slowest_cold: { text: string; search: string; ms: number }[]; load: { at_start: number; at_end: number; cpu_count: number } } };
  suggest_cache_key: { how: string; board_load_instant: string | null; cases: { request: string; status: number; cache_control: string | null; expected_cache_control: string; body_v: string; ok: boolean }[]; checks: { check: string; ok: boolean }[]; all_pass: boolean };
  targets: Target[];
  fingerprint: string;
}
type RecallRow = ReturnType<typeof recallStats>;
interface NameRow {
  n: number;
  found: number;
  found_pct: number;
  at_1_pct: number;
  median_rank_when_found: number | null;
  by_letters: Record<string, { n: number; found_pct: number }>;
  misses: { typed: string; wanted: string; offered: string[] }[];
}
interface LatencyRow {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  share_under_100_ms: number;
}

function table(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

const f1 = (x: number) => x.toFixed(1);
const f3 = (x: number) => x.toFixed(3);
const f4 = (x: number) => x.toFixed(4);
const ms = (x: number) => x.toFixed(1);
const signed = (x: number, places = 1) => `${x > 0 ? '+' : ''}${x.toFixed(places)}`;
const signedNum = (x: number) => `${x > 0 ? '+' : ''}${num(x)}`;
const cell = (text: string) => text.replace(/\|/g, '\\|');

const TYPE_LABEL: Record<QueryType, string> = {
  title: 'title (exact)',
  title_company: 'title + company',
  title_lower: 'title, lower-cased',
  words_reordered: 'last word moved first',
  one_typo: 'one typo'
};

function renderMarkdown(r: Rendered): string {
  const out: string[] = [];
  /** Each call is one block, followed by a blank line, so a table never abuts a paragraph. */
  const push = (...lines: string[]) => out.push(lines.join('\n'), '');

  const edited = r.meta.engine_files_modified_in_tree.map((l) => l.replace(/^\s*\S+\s+/, ''));
  push('# Search engine metrics');
  push(
    `Generated by \`npm run eval:search\` (test/eval/search.eval.ts) on ${r.meta.measured_at.slice(0, 10)} in ${r.meta.elapsed_s} s, at commit \`${r.meta.head}\`${edited.length ? ` with uncommitted edits to ${edited.join(', ')}` : ''}. Do not edit by hand: the harness writes every number here and overwrites this file on every run.`
  );
  push(
    `**Old** is the engine at 0caebff (\`ILIKE\` substring on title and company, ordered by Deets), as committed in docs/search-engine-baseline-search.json. **New** is \`listBoardFiltered\` in src/lib/job-store.ts as it is in the working tree. Both are measured on the same ${r.environment.sample.size} live postings (salt \`${r.environment.sample.salt}\`, drawn by \`ORDER BY md5(id||salt)\`) out of ${num(r.environment.live_rows)} live rows (${num(r.environment.live_rows_at_baseline)} when the baseline was taken), with the same five query constructions and the same rank, hit and MRR definitions.`
  );
  push(
    r.baseline_check.replica_reproduces_committed_baseline
      ? '**The old engine was re-run and reproduces the committed baseline exactly** (n, hit@1, hit@10, MRR and zero-result rate, all five query types). That is why the title-equivalent and precision figures for Old, which the baseline file does not hold, can be taken from the replica and set beside New.'
      : `**WARNING: the old-engine replica does NOT reproduce the committed baseline** (${r.baseline_check.mismatches.join('; ')}). The board has changed since the baseline was taken; Old columns taken from the file are not comparable with this run.`
  );

  push('## Targets (docs/search-engine-plan.md)');
  push(table(['measure', 'target', 'measured', 'verdict'], r.targets.map((t) => [t.measure, t.target, t.measured, `**${t.verdict}**`])));
  const notes = r.targets.filter((t) => t.note);
  if (notes.length) push(...notes.map((t) => `- *${t.measure}*: ${t.note}`));
  push('The typeahead recall figures have no target in the plan; they are in the typeahead sections below.');

  push('## Known-item retrieval: old against new');
  push(
    'A query is built from a sampled posting and the question is where that posting comes back. Rank is the 1-based position of the sampled id in the first 100 results; hit@1 and hit@10 are percentages; MRR is the mean of 1/rank, 0 when absent. `zero` is the share of queries that returned nothing; `fuzzy` is the share answered by the typo path (new only). Latency is one `listBoardFiltered` call for a page of 100, which includes the facet counts the board also needs. The old latency is the baseline file\'s and is not comparable with the new one: see the note at the end.'
  );
  const rows: (string | number)[][] = [];
  for (const type of TYPES) {
    const k = r.known_item[type];
    rows.push([TYPE_LABEL[type], 'old', k.old_baseline.n, f1(k.old_baseline.hit1), f1(k.old_baseline.hit10), f3(k.old_baseline.mrr), f1(k.old_baseline.zero_results), '', ms(k.old_baseline.latency_ms.p50), ms(k.old_baseline.latency_ms.p95), ms(k.old_baseline.latency_ms.p99)]);
    rows.push(['', '**new**', k.new.n, `**${f1(k.new.hit1)}**`, `**${f1(k.new.hit10)}**`, `**${f3(k.new.mrr)}**`, `**${f1(k.new.zero_results)}**`, f1(k.new.fuzzy_rate ?? 0), ms(k.new.latency_ms.p50), ms(k.new.latency_ms.p95), ms(k.new.latency_ms.p99)]);
  }
  push(table(['query', 'engine', 'n', 'hit@1 %', 'hit@10 %', 'MRR', 'zero %', 'fuzzy %', 'p50 ms', 'p95 ms', 'p99 ms'], rows));

  const ceiling = r.known_item.title.exact_id_ceiling;
  if (ceiling) {
    push(
      `**What the exact-id measure can reach.** On the title queries the words ARE the title, so an engine cannot tell identical titles apart, and a posting whose title is shared by k live postings is found in the top ten with probability at most min(1, 10/k). ${f1(ceiling.share_of_sample_with_a_title_shared_by_more_than_ten)}% of the sample has a title shared by more than ten live postings, and the ceiling over the whole sample is **${f1(ceiling.hit10)}% at hit@10 and ${f1(ceiling.hit1)}% at hit@1**. The new engine scores ${f1(r.known_item.title.new.hit10)}% and ${f1(r.known_item.title.new.hit1)}%: at the ceiling, give or take what 500 postings put either side of an expectation. ${ceiling.hit10 < 95 ? 'A target of 95% at hit@10 by exact id is above that ceiling, so no engine can meet it on this sample by exact id; the any-same-title measure below is the one that can.' : ''}`
    );
  }

  push('## Title-equivalent hit@10');
  push(
    'Many postings share a title ("Transportation Security Officer" is on the board 159 times), so the exact id can sit past rank 10 among identical rows and still be a correct answer to the question "does the right kind of job surface". The **exact id** column is the strict measure above. The **any same title** column counts a hit when the top ten holds ANY posting whose folded title (lower-cased, accents folded, punctuation read as a space) equals the sampled posting\'s. **Old (replica)** is the old `ILIKE` query run now by this harness; **old (baseline file)** is the committed exact-id figure. Both engines are scored by the same code.'
  );
  push(
    table(
      ['query', 'new, exact id', 'new, any same title', 'old (baseline file), exact id', 'old (replica), exact id', 'old (replica), any same title'],
      TYPES.map((type) => {
        const k = r.known_item[type];
        return [TYPE_LABEL[type], f1(k.new.hit10), `**${f1(k.new.title_equivalent_hit10)}**`, f1(k.old_baseline.hit10), f1(k.old_replica.hit10), f1(k.old_replica.title_equivalent_hit10)];
      })
    )
  );
  push(
    'Read the first three rows with care: there the query is the sampled title itself, and the best-match order puts "the title is exactly the words" first, so a new-engine score near 100% is close to how the ranking is built. The reordered and typo rows are the informative ones. A reordered-words miss is usually a title with the same words in another order (the query "Physician Primary Care" for the sampled "Primary Care Physician" returns "Physician - Primary Care" first), which the folded-title rule counts as a miss although a person would not.'
  );
  const misses = r.known_item.title.new_title_misses;
  if (misses.length) {
    push(
      `Where the new engine's top ten has no posting with the sampled title (up to eight of the title queries, in sample order; full lists for every type are in the JSON):`
    );
    push(table(['sampled title', 'rank of the sampled id', 'top three returned'], misses.map((m) => [cell(m.title), m.rank || 'not in 100', m.top3.map(cell).join(' / ')])));
  }

  push('## Precision of the top ten for real queries');
  push(
    `The ${r.precision_at_10.new.queries} most frequent distinct live titles, each typed as a query (lower-cased). **Title precision@10** is the share of the top-10 rows whose folded title contains every query word. Pooled counts every row returned; the mean is per query.`
  );
  const pn = r.precision_at_10.new;
  const po = r.precision_at_10.old;
  push(
    table(
      ['engine', 'rows examined', 'rows with every word in the title', 'pooled precision@10 %', 'mean per query %', 'queries at 100%'],
      [
        ['old', po.rows_examined, po.rows_precise, f1(po.pooled_precision_at_10), f1(po.mean_precision_at_10), `${po.queries_all_precise} of ${po.queries}`],
        ['**new**', pn.rows_examined, pn.rows_precise, `**${f1(pn.pooled_precision_at_10)}**`, f1(pn.mean_precision_at_10), `${pn.queries_all_precise} of ${pn.queries}`]
      ]
    )
  );
  if (r.precision_at_10.below_100.length) {
    push('Queries where either engine returned a row without every word in its title:');
    push(table(['query', 'live rows with this title', 'new', 'old'], r.precision_at_10.below_100.map((b) => [cell(b.query), b.live_rows, b.new, b.old])));
  } else {
    push('Both engines are at 100% on every query, so this measure cannot tell them apart. That is expected, not a sign the measure is working: a title typed in full is a substring of the titles that carry it and a word match for them alike, and the new engine ranks "the title is the words" first. It would take a vaguer query (one common word, a prefix) to separate them, and that is not what this set asks.');
  }

  const d = r.data;
  push('## Data');
  push(
    table(
      ['measure', 'baseline', 'now'],
      [
        ['live rows', num(d.live_rows.baseline), num(d.live_rows.now)],
        ['live rows with a country (the baseline counts the upstream code)', `${num(d.country_coverage.upstream_code_baseline.rows)} (${f1(d.country_coverage.upstream_code_baseline.pct)}%)`, `${num(d.country_coverage.upstream_code_now.rows)} upstream code (${f1(d.country_coverage.upstream_code_now.pct)}%)`],
        ['live rows with a RESOLVED country (place_country)', 'n/a', `**${num(d.country_coverage.resolved_now.rows)} (${f1(d.country_coverage.resolved_now.pct)}%)**`],
        ['non-US country in a US region, by upstream code', num(d.non_us_country_in_a_us_region.by_upstream_code_baseline), String(d.non_us_country_in_a_us_region.by_upstream_code_now)],
        ['non-US country in a US region, by resolved country', 'n/a', `**${d.non_us_country_in_a_us_region.by_resolved_country_now}**`],
        ['Canada in a US region, by upstream code CA', 'n/a (979 non-US codes were in a US region)', String(d.canada_in_a_us_region.by_upstream_code_now)],
        ['Canada in a US region, by resolved country', 'n/a', String(d.canada_in_a_us_region.by_resolved_country_now)],
        ['`remote_unresolved` upstream code in a US region (not a country)', 'n/a', String(d.remote_unresolved_rows_in_a_us_region)]
      ]
    )
  );
  const regions = [...new Set([...Object.keys(d.region_distribution.baseline), ...Object.keys(d.region_distribution.now)])].sort((a, b) => (d.region_distribution.now[b] ?? 0) - (d.region_distribution.now[a] ?? 0));
  push('Region distribution (live rows):');
  push(
    table(
      ['region', 'baseline', 'now', 'change'],
      regions.map((region) => {
        const was = d.region_distribution.baseline[region] ?? 0;
        const now = d.region_distribution.now[region] ?? 0;
        return [region, num(was), num(now), signedNum(now - was)];
      })
    )
  );
  const ps = d.place_script;
  const ha: PlaceHoldout = ps.holdout_by_row;
  const hb: PlaceHoldout = ps.holdout_by_string;
  push('Place holdout (`node scripts/build-place-table.mjs --dry-run`, which writes nothing; learned on 80%, the country blanked on the other 20%, scored against the upstream code):');
  push(
    table(
      ['holdout', 'held out', 'resolved', 'correct', 'accuracy %', 'misses where the text names the other country', 'rows only the table can place: placed / correct'],
      [
        ['by row (seed 220)', num(ha.held_out), num(ha.resolved), num(ha.correct), f1(ha.accuracy_pct), `${ha.misses_where_text_names_the_other_country} of ${ha.resolved - ha.correct}`, `${ha.table_only.rows}: ${ha.table_only.placed} / ${ha.table_only.correct}`],
        ['by never-seen string', num(hb.held_out), num(hb.resolved), num(hb.correct), f1(hb.accuracy_pct), `${hb.misses_where_text_names_the_other_country} of ${hb.resolved - hb.correct}`, `${hb.table_only.rows}: ${hb.table_only.placed} / ${hb.table_only.correct}`]
      ]
    )
  );
  push(
    `The table holds ${ps.cities_learned} learned cities. Of ${num(ps.coverage.rows_without_upstream)} live rows with no upstream country, ${num(ps.coverage.newly_resolved)} now resolve, ${num(ps.coverage.resolved_only_by_learned_table)} of them only because of the learned table. src/data/place-cities.json is ${d.place_cities_json_unchanged ? 'byte-identical after the run (checked by hash and by git)' : '**CHANGED by the run: investigate**'}.`
  );
  push(`Largest strings still unresolved: ${ps.coverage.largest_unresolved.map((u: { location: string; rows: number }) => `${JSON.stringify(u.location)} (${num(u.rows)})`).join(', ')}.`);
  if (d.non_us_country_in_a_us_region.largest_upstream_code_cases.length) {
    push('What the upstream-code residue is (non-US upstream code, a US region, largest groups): the text names a US place and the upstream code is the odd one out.');
    push(
      table(
        ['upstream code', 'resolved country', 'region', 'location', 'rows'],
        d.non_us_country_in_a_us_region.largest_upstream_code_cases.map((c: { country: string; place_country: string | null; derived_region: string; location: string; n: number }) => [c.country, c.place_country ?? 'none', c.derived_region, cell(c.location), c.n])
      )
    );
  }

  push('## Classifier');
  push(
    table(
      ['measure', 'before the repair', 'now'],
      [[`coverage over test/fixtures/family-corpus.json.gz (${num(r.classifier.postings)} postings, computed as job-family.test.ts does)`, f4(r.classifier.coverage_before), `${f4(r.classifier.coverage_now)} (${signed(r.classifier.delta_points, 2)} points; floor ${r.classifier.floor.toFixed(2)})`]]
    )
  );

  push('## Latency on the board\'s own shapes');
  push(
    `Warm: three unscored runs, then ${LATENCY_RUNS} timed runs of the same request, one \`listBoardFiltered\` call each (rows and every facet count, a page of ${r.environment.board_page_size_for_latency_shapes}, the sort the board would pick). **Local Postgres on a development machine, not Neon**: these are local numbers and say nothing about production latency. Nearest-rank percentiles; with ${LATENCY_RUNS} runs the p99 IS the slowest run. Load average at start ${r.meta.load.at_start.toFixed(2)}, at end ${r.meta.load.at_end.toFixed(2)} on ${r.meta.load.cpu_count} cores, with other work on the machine.`
  );
  push(
    table(
      ['shape', 'rows matched', 'typo path', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms'],
      Object.values(r.latency_board_shapes).map((s) => [cell(s.label), num(s.total), s.fuzzy ? 'yes' : 'no', ms(s.latency_ms.p50), ms(s.latency_ms.p95), ms(s.latency_ms.p99), ms(s.latency_ms.max)])
    )
  );

  const ta = r.typeahead_titles;
  const taRows = Object.entries(ta.variants);
  const typedLabel: Record<string, string> = {
    last_word_4: 'earlier words + first 4 characters of the last word',
    first_word_3: 'first 3 characters of the first word',
    first_word_4: 'first 4 characters of the first word',
    first_word_6: 'first 6 characters of the first word'
  };
  push('## Typeahead: is the title among the completions');
  push(
    `The same ${ta.sample} postings. For each, the text is sent to the suggest endpoint with no filter set, and the question is whether the posting's folded title is the folded label of an item in the response's **titles** group, which holds at most ${ta.shown}. Rank is the 1-based position among the completions; the median is over the postings that were found. A completion is a title the typed words already match (every word, the last as a prefix), listed most rows first, so a title few postings carry needs more of its words typed before it makes the eight.`
  );
  push(
    table(
      ['what is typed', 'n', 'in the top 8 %', 'at 1 %', 'in the top 3 %', 'median rank when found', 'MRR', 'no completions %', 'typed text read as a chip'],
      taRows.map(([name, v]) => [typedLabel[name] ?? name, v.n, `**${f1(v.in_top_8)}**`, f1(v.at_1), f1(v.in_top_3), v.median_rank_when_found ?? 'n/a', f3(v.mrr), f1(v.no_completions), v.typed_text_read_as_a_chip])
    )
  );
  const lastWord = ta.variants.last_word_4;
  if (lastWord) {
    const eligible = lastWord.where_the_typed_fragment_has_a_letter_or_digit;
    push(
      `The first row is the one the plan names. Where the last whitespace-separated word of the title has no letter or digit in it (a lone "-", "&" or "/"), the typed fragment is punctuation: over the ${eligible.n} postings where it is not, the top-8 recall is ${f1(eligible.in_top_8)}%. "Read as a chip" counts typed texts the parser turned into a fact (a place named inside the title, a short last word that is a pay or a remote word): those words leave the title words and narrow the completions to the rows in that place. ${lastWord.missed_where_the_typed_text_was_read_as_a_chip} of the ${lastWord.missed} misses of the first row are texts read that way.`
    );
    if (lastWord.misses.length) {
      push('Misses of the first row (up to eight, in sample order; every variant\'s are in the JSON):');
      push(table(['title', 'typed', 'completions offered', 'top three offered'], lastWord.misses.map((m) => [cell(m.title), cell(m.typed), m.completions, m.top3.map(cell).join(' / ') || 'none'])));
    }
  }

  const tn = r.typeahead_names;
  push('## Typeahead: places and companies');
  push(
    `A place or company is completed from the trailing fragment of the text. Each case types the fragment alone and asks whether the right place (or company) is among the items of the **places** (or **companies**) group, at most ${SUGGEST_GROUP_MAX}, chosen by how many live rows carry each name before any filter. **By row** is ${TYPEAHEAD_ROWS} live rows drawn by hash, so a name is as likely as its share of the board; **by distinct name** is ${TYPEAHEAD_ROWS} distinct names, each as likely as any other, which is the harder question because a prefix of a rare name is shared with larger ones. A place is the row's key (country, region when it has one, city as stored), typed as the first 3, 4 or 5 characters of the city; a company is typed as its first 4 characters.`
  );
  const nameRow = (kind: string, how: string, v: NameRow) => [kind, how, v.n, `**${f1(v.found_pct)}**`, f1(v.at_1_pct), v.median_rank_when_found ?? 'n/a', ...['3', '4', '5'].map((k) => (v.by_letters[k] ? `${f1(v.by_letters[k].found_pct)} (n ${v.by_letters[k].n})` : 'n/a'))];
  push(
    table(
      ['kind', 'sample', 'n', 'found in the group %', 'at 1 %', 'median rank when found', '3 letters %', '4 letters %', '5 letters %'],
      [
        nameRow('place', `by row (${tn.place.distinct_names_in_the_row_sample} distinct)`, tn.place.by_row),
        nameRow('place', 'by distinct name', tn.place.by_distinct_name),
        nameRow('company', `by row (${tn.company.distinct_names_in_the_row_sample} distinct)`, tn.company.by_row),
        nameRow('company', 'by distinct name', tn.company.by_distinct_name)
      ]
    )
  );
  const nameMisses = [
    ...tn.place.by_distinct_name.misses.slice(0, 4).map((m) => ['place', m.typed, m.wanted, m.offered.join(' / ') || 'none']),
    ...tn.company.by_distinct_name.misses.slice(0, 4).map((m) => ['company', m.typed, cell(m.wanted), m.offered.map(cell).join(' / ') || 'none'])
  ];
  if (nameMisses.length) {
    push('Some misses by distinct name (the first four of each kind, in sample order):');
    push(table(['kind', 'typed', 'wanted', 'first three offered'], nameMisses));
  }

  const cc = r.counts_contract;
  push('## Counts contract at scale (ticket I)');
  push(
    `**Every count is the rows its row returns.** ${cc.cases} seeded cases (seed ${cc.seed}): a partial query drawn from real title words, places, companies and pay, remote and age phrases, under a random filter state (place, remote list, pay floor or "not listed", company, family, age; none to four of them). The suggest endpoint is asked, with its memo emptied first so every count comes from the store. Then, for every item of every group, the item's \`href\` is read back by the board's own reader and counted by \`listBoardFiltered\`, the call the board makes; the response's \`total\` is compared with what the board shows for the text as typed (landing where the page would send it); and \`disabled\` must be exactly \`count === 0\`. The board is the oracle: nothing here is checked against the code that produced it.`
  );
  push(
    table(
      ['measure', 'value'],
      [
        ['cases', cc.cases],
        ['items checked, all groups', `**${num(cc.items_checked)}**`],
        ['by group (of which count something)', Object.entries(cc.items_by_group as Record<string, number>).map(([g, n]) => `${g} ${num(n)} (${num((cc.items_that_count_something_by_group as Record<string, number>)[g] ?? 0)})`).join(', ')],
        ['items that count something', num(cc.items_checked - cc.items_with_count_zero)],
        ['items that count zero (returned, disabled)', num(cc.items_with_count_zero)],
        ['totals checked (one per case)', `${cc.totals_checked} (${cc.totals_checked - cc.text.cases_whose_total_is_zero} on a board with rows, ${cc.text.cases_whose_total_is_zero} on an empty one)`],
        ['distinct addresses counted by the board', num(cc.distinct_addresses_counted_by_the_board)],
        ['**item mismatches**', `**${cc.item_mismatches}**`],
        ['**total mismatches**', `**${cc.total_mismatches}**`],
        ['shape violations (disabled flag, group order, group size, v, q, status)', cc.shape_violation_count],
        ['answers the memo gave, identical to the cold ones', `${cc.memo_pass.identical_to_the_cold_answer} of ${cc.memo_pass.cases}`]
      ]
    )
  );
  push(
    `The cases cover: filters set ${Object.entries(cc.filter_states.by_number_of_filters as Record<string, number>).map(([k, n]) => `${k} at a time in ${n}`).join(', ')}; by kind ${Object.entries(cc.filter_states.by_kind as Record<string, number>).map(([k, n]) => `${k} ${n}`).join(', ')}. Of the texts, ${cc.text.cases_whose_text_states_a_fact} state a fact (read as a chip), ${cc.text.cases_with_an_offer} carry an offer, ${cc.text.cases_the_board_answers_on_the_typo_path} are answered by the board on its typo path, and ${cc.text.cases_whose_total_is_zero} land on an empty board.`
  );
  if (cc.first_mismatches.length) {
    push(`**Mismatches (the first ${cc.first_mismatches.length}):**`);
    push(
      table(
        ['case', 'kind', 'typed', 'filters', 'item', 'suggested count', 'board total'],
        cc.first_mismatches.map((m: Mismatch) => [m.case, m.kind, cell(m.text), cell(m.search || 'none'), m.id ? cell(`${m.group}: ${m.id}`) : 'total', m.count, m.board])
      )
    );
  }
  if (cc.shape_violations.length) push(`Shape violations (the first ${cc.shape_violations.length}): ${cc.shape_violations.map((v: string) => cell(v)).join('; ')}.`);
  const si = cc.strip_invariants;
  push('**The strip invariants**, on the board each of the same cases lands on, from `listBoardFiltered`\'s own counts. Where the control is set, the comparison is with the same board taken with that control let go; where it is not, with the board\'s total.');
  push(
    table(
      ['invariant', 'checked', 'violations'],
      Object.entries(si.checked as Record<string, number>).map(([name, n]) => [name, n, (si.violations_by_invariant as Record<string, number>)[name] ?? 0])
    )
  );
  if (si.first_violations.length) {
    push(`**Violations (the first ${si.first_violations.length}):**`);
    push(table(['case', 'invariant', 'typed', 'filters', 'sum', 'expected'], si.first_violations.map((v: StripViolation) => [v.case, v.invariant, cell(v.text), cell(v.search || 'none'), v.sum, v.expected])));
  }

  const sl = r.suggest_latency;
  push('## Suggest latency');
  push(
    `${sl.queries} partial queries drawn the way the contract's are (seed ${LATENCY_SEED}; ${sl.queries_with_a_filter} of them under at least one filter), each sent to the endpoint's handler, timed from the call to the finished response (the board stamp read, the vocabulary looked up, the answer built, the header chosen). **Cold**: the in-process memo of counts emptied before each request, so every count is taken from the store, in a process that is otherwise warm (vocabulary built, connections open, ${LATENCY_WARMUP_CASES} unscored requests first). **Warm**: the same request asked straight after an identical one, so the memo holds its counts; this is a repeat, and a repeat that reached the function at all (a CDN would answer it first). **Local Postgres on a development machine, not Neon.** Load average at start ${sl.latency_ms.load.at_start.toFixed(2)}, at end ${sl.latency_ms.load.at_end.toFixed(2)} on ${sl.latency_ms.load.cpu_count} cores.`
  );
  push(
    table(
      ['', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'under 100 ms %'],
      [
        ['cold', ms(sl.latency_ms.cold.p50), `**${ms(sl.latency_ms.cold.p95)}**`, ms(sl.latency_ms.cold.p99), ms(sl.latency_ms.cold.max), f1(sl.latency_ms.cold.share_under_100_ms)],
        ['warm', ms(sl.latency_ms.warm.p50), ms(sl.latency_ms.warm.p95), ms(sl.latency_ms.warm.p99), ms(sl.latency_ms.warm.max), f1(sl.latency_ms.warm.share_under_100_ms)]
      ]
    )
  );
  push(
    `Cold requests cut by the rows the board shows for the typed text (what its words match decides what every count that carries them has to read):`
  );
  push(
    table(
      ['rows shown', 'requests', 'p50 ms', 'p95 ms', 'max ms', 'under 100 ms %'],
      Object.entries(sl.latency_ms.cold_by_rows_the_board_shows).map(([label, row]) => [label, sl.cold_requests_by_rows_the_board_shows[label] ?? 0, row ? ms(row.p50) : 'n/a', row ? ms(row.p95) : 'n/a', row ? ms(row.max) : 'n/a', row ? f1(row.share_under_100_ms) : 'n/a'])
    )
  );
  push(`Slowest cold requests: ${sl.latency_ms.slowest_cold.map((x) => `${JSON.stringify(x.text)}${x.search ? ` with ${x.search}` : ''} (${ms(x.ms)} ms)`).join('; ')}. The first request after a crawl also builds the vocabulary once (${r.suggest_setup.vocabulary.titles ? num(r.suggest_setup.vocabulary.titles) : '?'} distinct titles, ${num(r.suggest_setup.vocabulary.companies)} companies, ${num(r.suggest_setup.vocabulary.cities)} city keys): ${ms(r.suggest_setup.latency_ms.lexicon_build)} ms here, of which ${ms(r.suggest_setup.latency_ms.lexicon_read)} ms is the three reads.`);

  const ck = r.suggest_cache_key;
  push('## Suggest cache key');
  push(
    `The crawl instant the board is on is \`${ck.board_load_instant ?? 'none'}\`. ${ck.how}`
  );
  push(table(['request', 'status', 'Cache-Control returned', 'v in the body', 'as expected'], ck.cases.map((c) => [cell(c.request), c.status, `\`${c.cache_control ?? 'none'}\``, c.body_v === ck.board_load_instant ? 'the current instant' : `\`${c.body_v}\``, c.ok ? '**yes**' : '**NO**'])));
  push(table(['check', 'result'], ck.checks.map((c) => [cell(c.check), c.ok ? '**yes**' : '**NO**'])));

  push('## How to read this, and what it does not say');
  push(
    [
      '- The sample is 500 postings drawn by hash, so a percentage carries sampling noise of up to about four points at 95% confidence near 50% and about three near 90%. Both engines are scored on the same postings, which narrows the noise on the difference, but a gap of a point or two is not a finding.',
      '- Known-item retrieval asks for a posting by its own title. It rewards an engine for finding what the person already knows exists. It does not measure whether a vague query ("designer") returns the best jobs, and no number here does.',
      '- The exact-id measure is strict when titles repeat; the title-equivalent measure is lenient about which of several identical postings comes first. Read them together.',
      '- Old-engine figures labelled "baseline file" are the committed numbers; the ones labelled "replica" were produced by this run through a restatement of the old query, which is checked against the baseline above.',
      '- **Old latency is not comparable with new latency.** The old column is the baseline file\'s, taken before db/219 added the trigram and full-text indexes. The replica returns identical rows but now runs against those indexes, so its own latency (about a millisecond, rows only) is not the old engine\'s and is deliberately not shown. Compare the new column with the 150 ms target, not with the old column.',
      '- The typeahead and contract sections call the suggest route\'s own GET handler in this process, against local Postgres. They measure the function, its queries and its answers; a browser, a network and a CDN are not in them. The contract\'s cases and the latency queries are seeded draws from the live rows, so they are the same on every run, and they are samples: a count that matches 500 cases is evidence the contract holds, not a proof for every text.',
      '- The suggest latency target is judged on the cold figure. The warm figure is a repeat of a request the memo already holds. A cold request pays for every count it prints, and every count is the board\'s own (that is what makes it exact): a word that matches thousands of rows costs what a board search for it costs (the "a broad word" row of the board shapes above), and words that match nothing add the board\'s question of whether they are a misspelling.',
      `- Reproduce: \`npm run eval:search\`. Everything except latency, load and timestamps is deterministic; fingerprint of the deterministic part: \`${r.fingerprint}\`.`
    ].join('\n')
  );
  return out.join('\n');
}
