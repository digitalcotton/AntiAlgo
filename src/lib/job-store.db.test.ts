/**
 * job-store.db.test.ts: the board's search proved against a real Postgres.
 *
 * job-store.test.ts checks the SQL TEXT with no database. This file checks what
 * the SQL DOES, which a mock cannot: that the tsquery the builder writes is one
 * Postgres accepts for anything a person can type, that a title finds itself, that
 * a typo finds its title, that every predicate keeps the rows it says it keeps,
 * that the age strip, the counts and the rows are one population, and, the owner's
 * hardest requirement, that EVERY COUNT EQUALS THE ROWS THE OPTION RETURNS.
 *
 * It needs the board in a local database with db/219 (jobs.search and the trigram
 * indexes), db/220 (jobs.place_*) and db/221 (jobs.search_tc) applied. Without a connection string it
 * skips rather than passing, so a green run on a machine with no database cannot
 * be mistaken for a proof (same rule as jobs-data-agg.test.ts and
 * comp-top-sql.test.ts). It reads and never writes a row of any real table.
 *
 * TWO PHASES, ONE CONNECTION. The first half runs on the real columns. The
 * second shadows `jobs` with a SESSION-LOCAL view that is the real table with
 * place_country, place_admin1, place_city and place_label replaced by a fixed
 * spread (a hash of the id), so the place predicate and the place counts are
 * tested against known places whatever state the real backfill is in, and the
 * place invariant is checked on rows that really carry places. The view lives and
 * dies with this connection and nothing else can see it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

const URL = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;

// ONE dedicated connection stands in for the pool, so the temp view of phase two
// is visible to the code under test, and every statement it sends can be seen.
const shared = vi.hoisted(() => ({
  client: null as null | { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  sent: [] as { sql: string; params: unknown[] | undefined }[]
}));
vi.mock('./db', () => {
  // One connection runs one statement at a time. The store asks for its counts and its rows at the
  // same time (it has a pool to do that on), so here they wait their turn rather than overlap.
  let tail: Promise<unknown> = Promise.resolve();
  const run = (sql: string, params?: unknown[]) => {
    shared.sent.push({ sql, params });
    const result = tail.then(() => shared.client!.query(sql, params));
    tail = result.catch(() => undefined);
    return result;
  };
  return { db: () => ({ query: run, connect: async () => ({ query: run, release: () => undefined }) }), isConfigured: () => true };
});

import { FUZZY_WORD_THRESHOLD, PAY_FLOORS_K, buildSearchQuery, compileMatch, countBoardTotals, foldForSearch, listBoardAgeHistogram, listBoardFiltered, listBoardTitleCandidates, type BoardFilter } from './job-store';
import { REMOTE_KINDS } from './board-query';
import { COMP_BANDS } from './data';
import { FAMILY_IDS } from './job-family.mjs';

/** Is there a database with the columns this ticket reads? Asked once, before any test is declared. */
async function haveSchema(): Promise<boolean> {
  if (!URL) return false;
  const probe = new pg.Client({ connectionString: URL });
  try {
    await probe.connect();
    const { rows } = await probe.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'jobs'
          AND column_name IN ('search', 'search_tc', 'place_country', 'place_admin1', 'place_city', 'place_label')`
    );
    return rows[0].n === 6;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}
const READY = await haveSchema();
const d = READY ? describe : describe.skip;
if (!READY) console.warn('job-store.db.test.ts: skipped. It needs DATABASE_URL and a jobs table with search, search_tc and place_* (db/219, db/220, db/221).');

let conn: pg.Client;
const SWEEP = new Date().toISOString().slice(0, 10);
const BASE: BoardFilter = { q: '', location: 'all', comp: 'all', freshness: 'all', sort: 'fit', page: 1, perPage: 1, sweepDate: SWEEP, ageMin: null, ageMax: null };
const list = (over: Partial<BoardFilter> = {}) => listBoardFiltered({ ...BASE, ...over });
const sql = async (text: string, params: unknown[] = []) => (await conn.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => Object.values((await sql(text, params))[0])[0] as number;

/** A seeded generator, so a failure names a combination that can be replayed. */
function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] };
}

beforeAll(async () => {
  if (!READY) return;
  conn = new pg.Client({ connectionString: URL });
  await conn.connect();
  shared.client = conn;
});
afterAll(async () => {
  if (READY) await conn.end();
});

/* ===================================================================== */
d('the tsquery: whatever is typed, Postgres accepts it and the vector agrees', () => {
  it('accepts every form of the words the builder writes, for hostile text and for random text', async () => {
    const hostile = [
      'a & b', 'a | b', '!a', '(a)', 'a:*', 'a<->b', "a'b", "'", "''", '\\', "'; DROP TABLE jobs; --", 'foo:*bar & (baz | !qux)', 'ab&cd', 'ab(cd)ef',
      'ab\\cd', "d'angelo", 'node.js', 'ai/ml', 'u.s.a.', 'c++', 'full-stack', 'e-mail', '24/7', '$150k', '🚀 rocket', 'a\u0000b', '\ud800x', '全角　スペース', 'Ærø Zürich Łódź'
    ];
    const rnd = seeded(11);
    const alphabet = "ab AB 12 &|!():*'\\\"<>-./_@#$%^+=[]{}~`\t\n,;?é字";
    for (let i = 0; i < 300; i++) hostile.push(Array.from({ length: 1 + rnd.int(30) }, () => alphabet[rnd.int(alphabet.length)]).join(''));
    let built = 0;
    for (const text of hostile) {
      const sq = buildSearchQuery(text);
      if (!sq) continue;
      built += 1;
      for (const form of [sq.all, sq.a, sq.ab, sq.abc, ...(sq.fuzzy?.short ? [sq.fuzzy.short] : [])]) {
        // A syntax error here would be a 500 on the board for whatever someone typed.
        await expect(conn.query('SELECT to_tsquery($1::regconfig, $2)', ['simple', form]), `${JSON.stringify(text)} -> ${form}`).resolves.toBeTruthy();
      }
    }
    expect(built).toBeGreaterThan(250);
  });

  it('folds exactly the characters the vector folded, on every letter and digit the board holds', async () => {
    // The vector was built by f_unaccent and to_tsvector. For every non-ASCII
    // character that is a letter or digit in any title, company or department,
    // the word 'a<c>a' must come out of foldForSearch as the one lexeme Postgres
    // indexed it as. normalisePhrase disagreed on 62 of 382 characters (й, Hangul,
    // kana with a voicing mark); this must disagree on none.
    const chars: string[] = (await sql(
      `SELECT DISTINCT ch FROM (SELECT regexp_split_to_table(title || ' ' || company || ' ' || coalesce(department, ''), '') AS ch FROM jobs) t
        WHERE ch ~ '[^\\x00-\\x7F]'`
    )).map((r) => r.ch);
    expect(chars.length).toBeGreaterThan(50);
    const words = chars.filter((c) => /[\p{L}\p{N}]/u.test(c)).map((c) => `a${c}a`);
    const lexemes = await sql(`SELECT w, to_tsvector('simple', f_unaccent(w))::text AS v FROM unnest($1::text[]) w`, [words]);
    const disagree: string[] = [];
    for (const { w, v } of lexemes) {
      const indexed = [...String(v).matchAll(/'((?:[^']|'')*)':\d+/g)].map((m) => m[1].replace(/''/g, "'"));
      if (indexed.length !== 1 || foldForSearch(w) !== indexed[0]) disagree.push(`${w} fold=${foldForSearch(w)} pg=${indexed.join(',')}`);
    }
    expect(disagree).toEqual([]);
  });

  it('finds every posting by its own title, including the 10% whose titles carry a dot or slash between letters', async () => {
    const plain = await sql(`SELECT id, title FROM jobs WHERE status <> 'killed' ORDER BY md5(id || 'self') LIMIT 400`);
    const compound = await sql(
      `SELECT id, title FROM jobs WHERE status <> 'killed' AND title ~ '[[:alnum:]][./][[:alnum:]]' ORDER BY md5(id || 'compound') LIMIT 150`
    );
    expect(compound.length).toBeGreaterThan(50);
    const missed: string[] = [];
    for (const { id, title } of [...plain, ...compound]) {
      const sq = buildSearchQuery(title);
      const hit = sq ? await one(`SELECT count(*)::int FROM jobs WHERE id = $1 AND search @@ to_tsquery('simple', $2)`, [id, sq.all]) : 0;
      if (hit !== 1) missed.push(title);
    }
    // `ai/ml` is one lexeme in the vector. Split on every non-letter, `Software Engineer, AI/ML Infrastructure`
    // typed in full finds nothing; this is the reason compound chunks are offered whole.
    expect(missed).toEqual([]);
  });

  it('matches the same words in any order, and whole-or-prefix in the title but never a description prefix', { timeout: 120_000 }, async () => {
    const [row] = await sql(`SELECT id, title FROM jobs WHERE status <> 'killed' AND title ~ '^[A-Za-z]+ [A-Za-z]+ [A-Za-z]+$' ORDER BY md5(id || 'order') LIMIT 1`);
    const words = String(row.title).split(' ');
    for (const order of [words, [...words].reverse(), [words[1], words[2], words[0]]]) {
      const sq = buildSearchQuery(order.join(' '))!;
      expect(await one(`SELECT count(*)::int FROM jobs WHERE id = $1 AND search @@ to_tsquery('simple', $2)`, [row.id, sq.all])).toBe(1);
    }
    // THE `:*AB` RESTRICTION. A bare prefix `desi:*` matched 12,644 live rows through "desired"
    // in descriptions. The row below has "desired" in its description and no word starting
    // "desi" in its title, company or department: it must NOT be found by "desi".
    const [far] = await sql(
      `SELECT id FROM jobs WHERE status <> 'killed' AND search @@ to_tsquery('simple', 'desired')
          AND description ~* '\\mdesired\\M'
          AND title !~* '\\mdesi' AND company !~* '\\mdesi' AND coalesce(department, '') !~* '\\mdesi'
          AND description !~* '\\mdesi(?!red)' ORDER BY md5(id) LIMIT 1`
    );
    expect(far, 'the board holds no description-only "desired" row to test with').toBeTruthy();
    const bare = await one(`SELECT count(*)::int FROM jobs WHERE status <> 'killed' AND search @@ to_tsquery('simple', $$'desi':*$$)`);
    const restricted = await list({ q: 'desi', perPage: 1 });
    expect(restricted.total).toBeLessThan(bare / 5);
    const ids = new Set<string>();
    for (let page = 1; page <= Math.ceil(restricted.total / 100); page++) (await list({ q: 'desi', perPage: 100, page })).rows.forEach((r) => ids.add(r.id));
    expect(ids.size).toBe(restricted.total);
    expect(ids.has(far.id)).toBe(false);
  });
});

/* ===================================================================== */
d('the words: ranking, the tier ladder, and the facts each row carries', () => {
  it('finds a posting from its title and company in the first three, and always in the first ten', async () => {
    const rows = await sql(
      `SELECT id, title, company FROM (SELECT id, title, company, count(*) OVER (PARTITION BY title, company) AS n FROM jobs WHERE status <> 'killed') t
        WHERE n = 1 AND array_length(regexp_split_to_array(title, '\\s+'), 1) BETWEEN 2 AND 8 ORDER BY md5(id || 'known') LIMIT 25`
    );
    let top3 = 0;
    for (const r of rows) {
      const res = await list({ q: `${r.title} ${r.company}`, sort: 'best', perPage: 10 });
      const at = res.rows.findIndex((x) => x.id === r.id);
      expect(at, `${r.title} @ ${r.company} (of ${res.total})`).toBeGreaterThanOrEqual(0);
      if (at < 3) top3 += 1;
    }
    // Measured 59 of 60 in the first three, 60 of 60 in the first ten; the one miss was fifth of eight.
    expect(top3 / rows.length).toBeGreaterThanOrEqual(0.9);
  });

  it('orders by tier first, puts a title that IS the words before every other, and reports the rung on every row', async () => {
    for (const q of ['designer', 'senior product designer', 'engineer', 'nurse practitioner']) {
      const first = await list({ q, sort: 'best', perPage: 100 });
      expect(first.total, q).toBeGreaterThan(0);
      const rows = first.rows;
      const tiers = rows.map((r) => r.match_tier as number);
      expect(tiers, q).toEqual([...tiers].sort((a, b) => a - b));
      const words = foldForSearch(q).split(' ');
      const tokens = (text: string | null) => foldForSearch(text ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const has = (pool: string[], w: string) => pool.some((p) => p === w || (w.length >= 3 && p.startsWith(w)));
      for (const r of rows) {
        const t = tokens(r.title);
        const inTitle = words.every((w) => has(t, w));
        const inTitleCompany = words.every((w) => has([...t, ...tokens(r.company)], w));
        const inThree = words.every((w) => has([...t, ...tokens(r.company), ...tokens(r.department)], w));
        const expected = t.join(' ') === words.join(' ') ? 0 : inTitle ? 1 : inTitleCompany ? 2 : 3;
        expect(r.match_tier, `${q}: ${r.title} @ ${r.company}`).toBe(expected);
        expect(r.match_field, `${q}: ${r.title}`).toBe(expected <= 1 ? 'title' : expected === 2 ? 'company' : inThree ? 'department' : 'description');
        expect(r.fuzzy_score).toBeNull();
      }
    }
    // A title that IS the words reports tier 0 / title, and is first.
    const [exact] = await sql(`SELECT title FROM jobs WHERE status <> 'killed' AND title ~ '^[A-Za-z]+ [A-Za-z]+$' GROUP BY title ORDER BY count(*) DESC, title LIMIT 1`);
    const res = await list({ q: exact.title.toLowerCase(), sort: 'best', perPage: 5 });
    expect(res.rows[0]).toMatchObject({ match_tier: 0, match_field: 'title' });
  });

  it('reports a description-only match as tier 3 / description, and says so only for rows that really are', { timeout: 120_000 }, async () => {
    let tested = false;
    for (const word of ['ebitda', 'kubernetes', 'cobol', 'quickbooks', 'hipaa', 'dermatology']) {
      const [only] = await sql(
        `SELECT id FROM jobs WHERE status <> 'killed' AND description ~* ('\\m' || $1 || '\\M')
            AND title !~* ('\\m' || $1) AND company !~* ('\\m' || $1) AND coalesce(department, '') !~* ('\\m' || $1) LIMIT 1`,
        [word]
      );
      if (!only) continue;
      const res = await list({ q: word, sort: 'best', perPage: 100 });
      const mine = res.rows.find((r) => r.id === only.id);
      // It may be past page one on a common word; the contract is for every row that IS there.
      for (const r of res.rows) {
        if (r.match_tier === 3) {
          expect(['department', 'description']).toContain(r.match_field);
          if (r.match_field === 'description') {
            // Not one word of the title, company or department is the word or starts with it.
            const pool = foldForSearch(`${r.title} ${r.company} ${r.department ?? ''}`).split(/[^\p{L}\p{N}]+/u);
            expect(pool.some((p) => p === word || p.startsWith(word)), `${r.title} @ ${r.company}`).toBe(false);
          }
        }
      }
      if (mine) expect(mine).toMatchObject({ match_tier: 3, match_field: 'description' });
      tested = tested || res.rows.some((r) => r.match_tier === 3 && r.match_field === 'description');
    }
    expect(tested, 'no candidate word was description-only on this board').toBe(true);
  });

  it('uses both GIN indexes for words, a BitmapOr per word, not a scan of every description', async () => {
    // Each of these was a read of every row the index named: "engineer" and
    // "des" most of all, because a prefix over every weight names thousands of
    // postings that carry the word only in their description. The plan is asked
    // for as the store asked for it: in the transaction, with the planner
    // setting, it sent the statement with (a words statement is planned under
    // random_page_cost, see runStatement), replayed from what it sent.
    for (const q of ['designer', 'engineer', 'des', 'product des', 'senior product designer', 'software engineer']) {
      shared.sent.length = 0;
      await list({ q, sort: 'best' });
      const count = shared.sent.find((s) => s.sql.includes('AS text_total'))!;
      const setting = shared.sent.find((s) => s.sql.includes("set_config('random_page_cost'"))!;
      expect(setting, `${q}: the statement was sent under the planner setting`).toBeTruthy();
      await conn.query('BEGIN');
      let plan: string;
      try {
        await conn.query(setting.sql, setting.params);
        plan = (await conn.query(`EXPLAIN (COSTS OFF) ${count.sql}`, count.params)).rows.map((r) => r['QUERY PLAN']).join('\n');
      } finally {
        await conn.query('ROLLBACK');
      }
      expect(plan, q).toContain('jobs_search_idx');
      expect(plan, q).toContain('jobs_search_tc_idx');
      expect(plan, q).toContain('BitmapOr');
      expect(plan, q).not.toContain('Seq Scan on jobs');
    }
  });
});

/* ===================================================================== */
d('the two vectors (db/221): the same rows, found through the small one', () => {
  it('search_tc is the title and company of search, positions and all, on every row', async () => {
    expect(await one(`SELECT count(*)::int FROM jobs WHERE search_tc IS NULL`)).toBe(0);
    // The A and B part of search, by weight, and the function the trigger calls.
    expect(await one(`SELECT count(*)::int FROM jobs WHERE search_tc IS DISTINCT FROM ts_filter(search, '{a,b}')`)).toBe(0);
    expect(await one(`SELECT count(*)::int FROM jobs WHERE search_tc IS DISTINCT FROM jobs_search_tc_vector(title, company)`)).toBe(0);
  });

  // The proof that a rewrite of the predicate changed no result: for each text, the rows the
  // word-by-word match finds, over EVERY row of the table (killed ones too, so no partial index or
  // status test can hide a difference), are the rows the one tsquery `all` finds, and the title
  // completions' form (`a`) finds the same rows in search_tc as it does in search.
  const idsOf = async (where: string, params: unknown[]): Promise<string[]> => (await sql(`SELECT id FROM jobs WHERE ${where} ORDER BY id`, params)).map((r) => String(r.id));

  async function holds(text: string): Promise<number> {
    const sq = buildSearchQuery(text);
    if (!sq) return 0;
    const match = compileMatch(sq.match, 1);
    const fast = await idsOf(match.sql({ search: 'search', tc: 'search_tc' }), match.params);
    const old = await idsOf(`search @@ to_tsquery('simple', $1::text)`, [sq.all]);
    expect(fast, `match for ${JSON.stringify(text)}`).toEqual(old);
    const titleOnly = await idsOf(`search_tc @@ to_tsquery('simple', $1::text)`, [sq.a]);
    expect(titleOnly, `title form for ${JSON.stringify(text)}`).toEqual(await idsOf(`search @@ to_tsquery('simple', $1::text)`, [sq.a]));
    return old.length;
  }

  it('finds exactly the rows `all` finds, for words, prefixes, compounds, short words and the odd', { timeout: 300_000 }, async () => {
    const texts = [
      'designer', 'des', 'desi', 'product des', 'engineer', 'eng', 'senior product designer', 'software engineer remote', 'nurse mar', 'engineer ber',
      'ai/ml', 'node.js', 'node js', 'full-stack', 'c', 'r', 'c++', 'ab', 'a designer', 'u.s.', "d'angelo", 'v2.0', '24/7', 'e-mail', 'ebitda',
      'kubernetes', 'zurich', 'zürich', 'amazon', 'ama', 'remote nu', 'sr. software engineer', 'ml/ai ops', '150k', '50%_x', 'foo:*bar & (baz | !qux)',
      'Ærø', '工程师', 'Инженер', 'xqzvw rkt', 'the', 'and', 'lead lea',
      // A long chunk with punctuation in it, so a long run of tests goes into one statement.
      'ab-cd-ef-gh-ij-kl-mn-op-qr-st-uv-wx-yz-ab-cd-ef-gh-ij-kl-mn-op-qr-st-uv-wx-yz-ab-cd-ef-gh-ij-kl-mn-op'
    ];
    let nonEmpty = 0;
    for (const text of texts) if ((await holds(text)) > 0) nonEmpty += 1;
    expect(nonEmpty, 'most of the texts must find something, or this proves little').toBeGreaterThan(30);
  });

  it('finds exactly the rows `all` finds, for 120 phrases cut from real titles mid-word', { timeout: 600_000 }, async () => {
    const titles = (await sql(`SELECT title FROM jobs ORDER BY md5(id || 'two-vectors') LIMIT 120`)).map((r) => String(r.title));
    const rnd = seeded(221);
    let found = 0;
    for (const title of titles) {
      const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const take = words.slice(0, 1 + rnd.int(3));
      const last = take.length - 1;
      const cut = take[last]!.slice(0, 2 + rnd.int(4));
      found += (await holds([...take.slice(0, last), cut].join(' '))) > 0 ? 1 : 0;
    }
    expect(found).toBeGreaterThan(100);
  });

  it('asks "do these words match anything" of the indexes, so a misspelling costs a probe and not a read of every vector', { timeout: 120_000 }, async () => {
    // The typo path begins with this question (readTextMatches, an EXISTS that ends at the first row).
    // Asked of the old single tsquery it was a sequential scan that read and decompressed all 37,765
    // vectors to learn that "desginer" is not there (126 to 253 ms); through the two indexes it is empty
    // before a heap page is read. Replayed as the store sent it, under the setting it sent it with.
    for (const q of ['desginer', 'marketng man', 'xqzvw rkt']) {
      shared.sent.length = 0;
      await countBoardTotals([{ ...BASE, q }]);
      const probe = shared.sent.find((x) => /SELECT EXISTS \(SELECT 1 FROM matched/.test(x.sql));
      expect(probe, `${q}: the question was asked`).toBeTruthy();
      const setting = shared.sent.find((x) => x.sql.includes("set_config('random_page_cost'"))!;
      await conn.query('BEGIN');
      let plan: string;
      try {
        await conn.query(setting.sql, setting.params);
        plan = (await conn.query(`EXPLAIN (COSTS OFF) ${probe!.sql}`, probe!.params)).rows.map((r) => r['QUERY PLAN']).join('\n');
      } finally {
        await conn.query('ROLLBACK');
      }
      expect(plan, q).toContain('jobs_search_tc_idx');
      expect(plan, q).not.toContain('Seq Scan on jobs');
    }
  });

  it('the board and its title completions read the same rows through the new predicate as through the old', async () => {
    for (const q of ['designer', 'des', 'product des', 'senior eng', 'ai/ml', 'node.js']) {
      const sq = buildSearchQuery(q)!;
      const expected = Number(await one(`SELECT count(*)::int FROM jobs WHERE status <> 'killed' AND search @@ to_tsquery('simple', $1::text)`, [sq.all]));
      expect((await list({ q })).total, q).toBe(expected);
      const completions = await listBoardTitleCandidates({ ...BASE, q }, 50);
      const inTitles = Number(await one(`SELECT count(*)::int FROM jobs WHERE status <> 'killed' AND search @@ to_tsquery('simple', $1::text)`, [sq.a]));
      expect(completions.reduce((n, c) => n + c.rows, 0), `${q}: completions`).toBeLessThanOrEqual(inTitles);
    }
  });
});

/* ===================================================================== */
d('the typo path', () => {
  it.each([
    ['prodct desiner', /^product designer/i],
    ['softwre enginer', /software engineer/i],
    ['registred nurse', /registered nurse/i],
    ['acount executive', /account executive/i]
  ])('finds the title for "%s", flags it, and puts the right title first', async (typo, wanted) => {
    const res = await list({ q: typo, sort: 'best', perPage: 25 });
    expect(res.fuzzy).toBe(true);
    expect(res.total).toBeGreaterThan(0);
    const firstTitles = res.rows.slice(0, 5).map((r) => r.title);
    expect(firstTitles.some((t) => wanted.test(t)), firstTitles.join(' | ')).toBe(true);
    expect(wanted.test(res.rows[0].title), res.rows[0].title).toBe(true);
    for (const r of res.rows) {
      expect(r.match_tier).toBeNull();
      expect(r.match_field).toBe('title');
      expect(r.fuzzy_score).toBeGreaterThan(0);
      expect(r.fuzzy_score).toBeLessThanOrEqual(1);
    }
    // Ordered by the score the rows report.
    const scores = res.rows.map((r) => r.fuzzy_score as number);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('is one population: every count, the places and the age strip are over the close spellings the rows are', async () => {
    const res = await list({ q: 'prodct desiner' });
    expect(res.fuzzy).toBe(true);
    const c = res.counts;
    expect(c.location.all).toBe(res.total);
    expect(c.remote.all).toBe(res.total);
    expect(c.comp.all).toBe(res.total);
    expect(c.pay.any).toBe(res.total);
    expect(c.freshness.all).toBe(res.total);
    expect(c.family.all).toBe(res.total);
    expect(Object.values(c.place.countries).reduce((a, b) => a + b, 0) + c.place.notStated).toBe(res.total);
    const strip = await listBoardAgeHistogram({ sweepDate: SWEEP, q: 'prodct desiner' });
    const measurable = (await list({ q: 'prodct desiner', ageMin: -100000, ageMax: 100000 })).total;
    expect(strip.total).toBe(measurable);
  });

  it('is not tried when the words match, or when nothing is close, and says so', async () => {
    expect((await list({ q: 'designer' })).fuzzy).toBe(false);
    const gibberish = await list({ q: 'xqzvw rkt' });
    expect(gibberish).toMatchObject({ fuzzy: false, total: 0 });
    // A real word under filters nothing meets is NOT a typo: the words matched, the filters did not.
    const filtered = await list({ q: 'designer', payMin: 2000 });
    expect(filtered.fuzzy).toBe(false);
    expect(filtered.total).toBe(0);
  });

  it('reads the title trigram index, and the threshold is set for the transaction that reads it', async () => {
    shared.sent.length = 0;
    await list({ q: 'prodct desiner', sort: 'best' });
    const config = shared.sent.find((s) => s.sql.includes("set_config('pg_trgm.word_similarity_threshold'"))!;
    expect(config.params).toEqual([String(FUZZY_WORD_THRESHOLD)]);
    const count = shared.sent.find((s) => s.sql.includes('AS text_total') && s.sql.includes('<% j.title'))!;
    await conn.query('BEGIN');
    await conn.query(`SELECT set_config('pg_trgm.word_similarity_threshold', $1, true)`, [String(FUZZY_WORD_THRESHOLD)]);
    const plan = (await sql(`EXPLAIN (COSTS OFF) ${count.sql}`, count.params)).map((r) => r['QUERY PLAN']).join('\n');
    await conn.query('ROLLBACK');
    expect(plan).toContain('jobs_title_trgm_idx');
    // And the set_config call did not leak: the session is back at the default.
    expect(await sql(`SELECT current_setting('pg_trgm.word_similarity_threshold', true) AS t`)).not.toEqual([{ t: String(FUZZY_WORD_THRESHOLD) }]);
  });
});

/* ===================================================================== */
d('the predicates, on the real columns', () => {
  it('keeps the arrangements it is given, as a list, and reads the old single value the same way', async () => {
    const kinds = ['remote', 'hybrid', 'onsite', 'unstated'] as const;
    const all = (await list()).total;
    const per = Object.fromEntries(await Promise.all(kinds.map(async (k) => [k, (await list({ remote: [k] })).total] as const)));
    expect(Object.values(per).reduce((a, b) => a + b, 0)).toBe(all);
    expect((await list({ remote: ['remote', 'hybrid'] })).total).toBe(per.remote + per.hybrid);
    expect((await list({ location: 'hybrid' })).total).toBe(per.hybrid);
    // The list wins over a conflicting single value.
    expect((await list({ location: 'hybrid', remote: ['remote'] })).total).toBe(per.remote);
  });

  it('keeps the postings at or above a pay floor by the Desk\'s own definition, and counts the floors the same', async () => {
    const result = await list();
    const live = `status <> 'killed'`;
    for (const k of PAY_FLOORS_K) {
      // desk-agg.ts: a numeric comp_range.min at or above the floor; a row with none fails it.
      const desk = await one(
        `SELECT count(*)::int FROM jobs WHERE ${live} AND jsonb_typeof(comp_range->'min') = 'number' AND (comp_range->>'min')::numeric >= $1::numeric`,
        [k * 1000]
      );
      expect((await list({ payMin: k })).total, `rows at ${k}k`).toBe(desk);
      expect(result.counts.pay.floors[String(k)], `count at ${k}k`).toBe(desk);
    }
    expect(result.counts.pay.notListed).toBe(
      await one(`SELECT count(*)::int FROM jobs WHERE ${live} AND (jsonb_typeof(comp_range->'min') IS DISTINCT FROM 'number' OR (comp_range->>'min')::numeric <= 0)`)
    );
    // Not-listed and a floor are exclusive: not-listed wins, and the floor is dropped.
    expect((await list({ compNotListed: true, payMin: 100 })).total).toBe(result.counts.pay.notListed);
    // A band outranks a floor while the strip still has bands.
    const band = COMP_BANDS[1];
    expect((await list({ comp: band.key, payMin: 300 })).total).toBe(result.counts.comp[band.key]);
  });

  it('keeps a company by its exact name', async () => {
    const [{ company, n }] = await sql(`SELECT company, count(*)::int AS n FROM jobs WHERE status <> 'killed' GROUP BY company ORDER BY n DESC, company LIMIT 1`);
    expect((await list({ company })).total).toBe(n);
    expect((await list({ company: company.toUpperCase() === company ? company.toLowerCase() : company.toUpperCase() })).total).toBe(0);
    expect((await list({ company: 'No Such Employer, Ltd.' })).total).toBe(0);
  });

  it('keeps the places the backfill has resolved, by country, region and city, and none that are not there', async () => {
    const [{ country }] = await sql(`SELECT place_country AS country FROM jobs WHERE status <> 'killed' AND place_country IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`).then((r) => (r.length ? r : [{ country: 'US' }]));
    expect((await list({ place: country })).total).toBe(await one(`SELECT count(*)::int FROM jobs WHERE status <> 'killed' AND place_country = $1`, [country]));
    expect((await list({ place: 'ZZ' })).total).toBe(0);
    expect((await list({ place: 'not a place' })).total).toBe((await list()).total);
  });

  it('draws the age strip over exactly the rows and counts the table shows, for exact words and filters alike', async () => {
    const cases: Partial<BoardFilter>[] = [
      {}, { q: 'designer' }, { q: 'senior engineer', remote: ['remote'] }, { q: 'nurse', payMin: 100 }, { q: 'manager', place: 'US' }, { remote: ['hybrid', 'onsite'], families: ['design'] }
    ];
    for (const over of cases) {
      const { sort, page, perPage, ageMin, ageMax, ...filters } = { ...BASE, ...over };
      void sort; void page; void perPage; void ageMin; void ageMax;
      const strip = await listBoardAgeHistogram({ ...filters });
      // The strip counts the rows with a measurable age, so the table, asked for exactly those, agrees.
      const table = await list({ ...over, ageMin: -100000, ageMax: 100000 });
      expect(strip.total, JSON.stringify(over)).toBe(table.total);
    }
  });
});

/* ===================================================================== */
/** One random combination of the controls, as a filter. Replayable from its seed. */
async function randomFilter(rnd: ReturnType<typeof seeded>, vocabulary: { countries: string[]; companies: string[] }, q?: string): Promise<Partial<BoardFilter>> {
  const f: Partial<BoardFilter> = {};
  // Words that find tens to hundreds of rows keep the sample fast; a few combinations are given the bare board and a broad word on purpose.
  f.q = q ?? rnd.pick(['designer', 'accountant', 'physician', 'architect', 'attorney', 'pharmacist', 'electrician', 'recruiter', 'product designer', 'senior analyst']);
  if (rnd.next() < 0.5) f.remote = REMOTE_KINDS.filter(() => rnd.next() < 0.4);
  const pay = rnd.next();
  if (pay < 0.3) f.payMin = rnd.pick(PAY_FLOORS_K);
  else if (pay < 0.4) f.compNotListed = true;
  else if (pay < 0.5) f.comp = rnd.pick(COMP_BANDS).key;
  if (rnd.next() < 0.3) f.freshness = rnd.pick(['fresh', 'older', 'unknown']);
  if (rnd.next() < 0.3) f.families = [rnd.pick([...FAMILY_IDS, 'unplaced'])];
  if (rnd.next() < 0.3) f.ageMax = rnd.pick([7, 30, 120, 400]);
  if (rnd.next() < 0.3 && vocabulary.countries.length) f.place = rnd.pick(vocabulary.countries);
  if (rnd.next() < 0.1 && vocabulary.companies.length) f.company = rnd.pick(vocabulary.companies);
  if (rnd.next() < 0.15) f.hasComp = true;
  return f;
}

/**
 * THE COUNTS CONTRACT. For a seeded random combination of the controls, every
 * count the store returns for a control's options equals the `total` of the
 * same board with that option chosen IN PLACE OF the control's current value.
 * Exactness, not closeness: the owner's hardest requirement is that a number
 * beside a choice is the number of rows the choice returns.
 */
async function checkCountsContract(filter: Partial<BoardFilter>, label: string, countryBudget = 4): Promise<number> {
  const rnd = seeded(label.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  const base = await list(filter);
  const c = base.counts;
  // A total is asked once per distinct question; several counts are the same question under two names.
  const asked = new Map<string, number>();
  const total = async (over: Partial<BoardFilter>) => {
    const key = JSON.stringify(over);
    if (!asked.has(key)) asked.set(key, (await list({ ...filter, ...over })).total);
    return asked.get(key)!;
  };
  let checked = 0;
  const expectEq = async (what: string, got: number, over: Partial<BoardFilter>) => {
    expect(got, `${label} :: ${what} :: ${JSON.stringify(filter)}`).toBe(await total(over));
    checked += 1;
  };
  const noArrangement = { remote: [] as string[], location: 'all' };
  const noPay = { comp: 'all', payMin: null, compNotListed: false };

  // The arrangement, both names: every kind and `all`.
  await expectEq('remote.all', c.remote.all, { ...noArrangement });
  await expectEq('location.all', c.location.all, { ...noArrangement });
  for (const k of REMOTE_KINDS) {
    await expectEq(`remote.${k}`, c.remote[k], { remote: [k], location: 'all' });
    expect(c.location[k]).toBe(c.remote[k]);
  }
  // The pay control: any, every floor, not listed, and every band the strip still shows.
  await expectEq('pay.any', c.pay.any, { ...noPay });
  for (const k of PAY_FLOORS_K) await expectEq(`pay.floors.${k}`, c.pay.floors[String(k)], { ...noPay, payMin: k });
  await expectEq('pay.notListed', c.pay.notListed, { ...noPay, compNotListed: true });
  await expectEq('comp.all', c.comp.all, { ...noPay });
  for (const band of [...COMP_BANDS.map((b) => b.key), 'not-listed']) await expectEq(`comp.${band}`, c.comp[band], { ...noPay, comp: band });
  // Freshness, and a sample of the families (every family would be twenty more calls a combination).
  for (const f of ['all', 'fresh', 'older', 'unknown']) await expectEq(`freshness.${f}`, c.freshness[f], { freshness: f });
  const families = [...FAMILY_IDS, 'unplaced'].filter((id) => c.family[id] > 0);
  for (const id of [...families].sort(() => rnd.next() - 0.5).slice(0, 3)) await expectEq(`family.${id}`, c.family[id], { families: [id] });
  await expectEq('family.all', c.family.all, { families: [] });
  // The places: each country's count is the rows with that country chosen; together with the
  // rows that have none they are the board with no place chosen.
  const noPlace = await total({ place: null });
  expect(Object.values(c.place.countries).reduce((a, b) => a + b, 0) + c.place.notStated, `${label} :: places sum`).toBe(noPlace);
  checked += 1;
  const countries = Object.keys(c.place.countries).sort(() => rnd.next() - 0.5).slice(0, countryBudget);
  for (const country of countries) await expectEq(`place.${country}`, c.place.countries[country], { place: country });
  // And the controls that have no options are consistent with the page they came with.
  expect(c.family.all, `${label} :: family.all is the total with no family`).toBe(await total({ families: [] }));
  return checked;
}

d('THE INVARIANT, on the real columns: every count equals the rows its option returns', () => {
  it('holds for 24 seeded random combinations of the controls, with and without words and typos', async () => {
    const vocabulary = {
      countries: (await sql(`SELECT place_country AS c FROM jobs WHERE status <> 'killed' AND place_country IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 8`)).map((r) => r.c as string),
      companies: (await sql(`SELECT company AS c FROM jobs WHERE status <> 'killed' GROUP BY 1 ORDER BY count(*) DESC LIMIT 12`)).map((r) => r.c as string)
    };
    const rnd = seeded(20261002);
    let checked = 0;
    let combos = 0;
    const seen = new Set<string>();
    // Three combinations on the bare board and one on a broad word, the rest on words of tens to hundreds of rows.
    const fixedQ: Record<number, string> = { 0: '', 8: '', 16: '', 5: 'engineer' };
    while (combos < 24) {
      const filter = await randomFilter(rnd, vocabulary, fixedQ[combos]);
      const key = JSON.stringify(filter);
      if (seen.has(key)) continue;
      seen.add(key);
      checked += await checkCountsContract(filter, `combo ${combos}`);
      combos += 1;
    }
    // Enough was compared, or the sample proved less than it claims.
    expect(combos).toBe(24);
    expect(checked).toBeGreaterThan(24 * 20);
  }, 300_000);

  it('holds for typo queries under filters, where the counts are over the close spellings', async () => {
    const vocabulary = { countries: ['US', 'GB', 'DE'], companies: [] as string[] };
    const rnd = seeded(77);
    let fuzzy = 0;
    for (let i = 0; i < 6; i++) {
      const filter = { ...(await randomFilter(rnd, vocabulary)), q: rnd.pick(['prodct desiner', 'softwre enginer', 'registred nurse']), company: undefined };
      expect((await list(filter)).fuzzy, JSON.stringify(filter)).toBe(true);
      fuzzy += 1;
      await checkCountsContract(filter, `typo ${i}`, 3);
    }
    expect(fuzzy).toBe(6);
  }, 300_000);
});

/* ===================================================================== */
d('THE INVARIANT and the place predicate, on a known spread of places', () => {
  beforeAll(async () => {
    // The real table with its four place columns replaced by a fixed spread. Session-local:
    // CREATE TEMP VIEW writes no row of any table, and `jobs` below this line means the view.
    const columns: string[] = (await sql(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs'
          AND column_name NOT IN ('place_country', 'place_admin1', 'place_city', 'place_label') ORDER BY ordinal_position`
    )).map((r) => `j.${r.column_name}`);
    const slot = `abs(hashtext(j.id)) % 10`;
    const pick = (values: (string | null)[]) =>
      `CASE ${slot} ${values.map((v, i) => `WHEN ${i} THEN ${v === null ? 'NULL::text' : `'${v.replace(/'/g, "''")}'`}`).join(' ')} END`;
    //                       0         1         2        3          4          5               6          7         8     9
    const country = pick(['US', 'US', 'US', 'US', 'GB', 'GB', 'CA', 'DE', null, null]);
    const admin = pick(['MD', 'MD', 'TX', 'CA', null, null, 'ON', null, null, null]);
    const city = pick(['Baltimore', 'Bethesda', 'Austin', 'San Francisco', 'London', 'Manchester', 'Toronto', 'Berlin', null, null]);
    const label = pick(['Baltimore, MD', 'Bethesda, MD', 'Austin, TX', 'San Francisco, CA', 'London, United Kingdom', 'Manchester, United Kingdom', 'Toronto, ON', 'Berlin, Germany', null, null]);
    await conn.query(`CREATE TEMP VIEW jobs AS SELECT ${columns.join(', ')}, ${country} AS place_country, ${admin} AS place_admin1, ${city} AS place_city, ${label} AS place_label FROM public.jobs j`);
  });
  afterAll(async () => {
    if (READY) await conn.query('DROP VIEW IF EXISTS pg_temp.jobs');
  });

  const live = `status <> 'killed'`;
  it('keeps a country, a region within it, and a city within that, and nothing with no place', async () => {
    const n = (where: string) => one(`SELECT count(*)::int FROM jobs WHERE ${live} AND ${where}`);
    expect((await list({ place: 'US' })).total).toBe(await n(`place_country = 'US'`));
    expect((await list({ place: 'US-MD' })).total).toBe(await n(`place_country = 'US' AND place_admin1 = 'MD'`));
    expect((await list({ place: 'US-MD/Baltimore' })).total).toBe(await n(`place_country = 'US' AND place_admin1 = 'MD' AND place_city = 'Baltimore'`));
    expect((await list({ place: 'GB/London' })).total).toBe(await n(`place_country = 'GB' AND place_city = 'London'`));
    // A city with a country that does not hold it, and a region on a country with none: nothing, not an error.
    expect((await list({ place: 'DE/London' })).total).toBe(0);
    expect((await list({ place: 'GB-MD' })).total).toBe(0);
    // Strict: a malformed key is dropped, and the board runs unnarrowed.
    const everything = (await list()).total;
    for (const bad of ['us', 'US-', 'GB/', '-MD', 'US MD', 'GB/ London']) expect((await list({ place: bad })).total, bad).toBe(everything);
    // An apostrophe is part of a city's name (O'Fallon), so this IS a key: a city that does not exist. It is bound, not interpolated.
    expect((await list({ place: "US-MD/Balti'; DROP TABLE jobs; --" })).total).toBe(0);
    // A place is a filter the rows with no place fail.
    expect((await list({ place: 'US' })).total + (await list({ place: 'GB' })).total + (await list({ place: 'CA' })).total + (await list({ place: 'DE' })).total).toBe(
      everything - (await n('place_country IS NULL'))
    );
  });

  it('counts the places over everything but the place filter, and tells the rows with none apart', async () => {
    const all = await list();
    expect(all.counts.place.countries).toEqual({
      US: await one(`SELECT count(*)::int FROM jobs WHERE ${live} AND place_country = 'US'`),
      GB: await one(`SELECT count(*)::int FROM jobs WHERE ${live} AND place_country = 'GB'`),
      CA: await one(`SELECT count(*)::int FROM jobs WHERE ${live} AND place_country = 'CA'`),
      DE: await one(`SELECT count(*)::int FROM jobs WHERE ${live} AND place_country = 'DE'`)
    });
    expect(all.counts.place.notStated).toBe(await one(`SELECT count(*)::int FROM jobs WHERE ${live} AND place_country IS NULL`));
    // With a place CHOSEN the counts are still over the board without it: each country says what choosing it would leave.
    const chosen = await list({ place: 'GB', remote: ['remote'], q: 'engineer' });
    const without = await list({ remote: ['remote'], q: 'engineer' });
    expect(chosen.counts.place).toEqual(without.counts.place);
  });

  it('holds the contract for 12 seeded combinations that include a place, checking every country', async () => {
    const rnd = seeded(555);
    const vocabulary = { countries: ['US', 'US-MD', 'US-MD/Baltimore', 'GB', 'GB/London', 'CA', 'DE'], companies: [] as string[] };
    for (let i = 0; i < 12; i++) {
      const filter = { ...(await randomFilter(rnd, vocabulary)), place: rnd.pick(vocabulary.countries), company: undefined };
      await checkCountsContract(filter, `place ${i}`, 4);
    }
  }, 300_000);
});
