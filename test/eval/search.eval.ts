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
import { DEFAULT_PER_PAGE, defaultSortFor } from '../../src/lib/board-query';
import { sweepDate } from '../../src/lib/data';
import { db } from '../../src/lib/db';
import { familyOf } from '../../src/lib/job-family.mjs';
import { foldForSearch, listBoardFiltered, type BoardFilter } from '../../src/lib/job-store';

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

  it('writes docs/search-engine-metrics.md and .json', async () => {
    const known = section('known_item') as Record<QueryType, { new: TypeStats; old_baseline: BaselineType; old_replica: TypeStats; exact_id_ceiling?: Ceiling }>;
    const data = section('data');
    const classifier = section('classifier');
    const parser = section('parser_table');
    const shapes = section('latency_board_shapes') as Record<string, { label: string; total: number; fuzzy: boolean; latency_ms: { p50: number; p95: number } }>;
    const precision = section('precision_at_10');
    const check = section('baseline_check');
    const environment = section('environment');

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

    /* ---- the JSON ------------------------------------------------------------ */
    // Not trimmed: a porcelain line starts with a space when only the work tree changed.
    const git = (args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.replace(/\n+$/, '');
    const full: Record<string, unknown> = {
      meta: {
        generated_by: 'npm run eval:search (test/eval/search.eval.ts)',
        measured_at: new Date().toISOString(),
        elapsed_s: Math.round((Date.now() - startedAt) / 1000),
        head: git(['rev-parse', '--short', 'HEAD']),
        engine_files_modified_in_tree: git(['status', '--porcelain', '--', 'src/lib/job-store.ts', 'src/lib/board-query.ts', 'src/lib/jobs-derived.mjs']).split('\n').filter(Boolean),
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
  targets: Target[];
  fingerprint: string;
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
  push('Not in this table: the suggest p95 and the counts contract, which the second half of ticket J adds.');

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

  push('## How to read this, and what it does not say');
  push(
    [
      '- The sample is 500 postings drawn by hash, so a percentage carries sampling noise of up to about four points at 95% confidence near 50% and about three near 90%. Both engines are scored on the same postings, which narrows the noise on the difference, but a gap of a point or two is not a finding.',
      '- Known-item retrieval asks for a posting by its own title. It rewards an engine for finding what the person already knows exists. It does not measure whether a vague query ("designer") returns the best jobs, and no number here does.',
      '- The exact-id measure is strict when titles repeat; the title-equivalent measure is lenient about which of several identical postings comes first. Read them together.',
      '- Old-engine figures labelled "baseline file" are the committed numbers; the ones labelled "replica" were produced by this run through a restatement of the old query, which is checked against the baseline above.',
      '- **Old latency is not comparable with new latency.** The old column is the baseline file\'s, taken before db/219 added the trigram and full-text indexes. The replica returns identical rows but now runs against those indexes, so its own latency (about a millisecond, rows only) is not the old engine\'s and is deliberately not shown. Compare the new column with the 150 ms target, not with the old column.',
      `- Reproduce: \`npm run eval:search\`. Everything except latency, load and timestamps is deterministic; fingerprint of the deterministic part: \`${r.fingerprint}\`.`
    ].join('\n')
  );
  return out.join('\n');
}
