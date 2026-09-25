/**
 * comp-top-sql.test.ts: proves compTopSql() (job-store.ts) against a real
 * Postgres, not just the JS-side compTop() in data.test.ts.
 *
 * WHY THIS EXISTS. compTop() and job-store.ts's comp_top column used to be
 * two hand-written regexes that quietly disagreed (see data.ts's
 * COMP_TOP_PATTERN comment). Now they share one pattern, but the SQL side
 * also does its own numeric work — replace(), the ::numeric cast, and the
 * CASE that divides a bare figure by 1000 — that data.test.ts's compTop()
 * assertions cannot exercise, because Postgres' regexp_matches(), its NULL
 * handling for an unmatched optional group, and its numeric division are not
 * things a JS test can stand in for. This runs compTopSql() itself, through
 * a real connection, against the same strings data.test.ts checks compTop()
 * against, and asserts the two give the same numbers.
 *
 * It needs a database. Without a connection string it skips rather than
 * passing, so a green run on a machine with no database cannot be mistaken
 * for a proof (same rule as jobs-data-agg.test.ts).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { db, isConfigured } from './db';
import { compTopSql } from './job-store';
import { compTop, type Job } from './data';

const HAVE_DB = isConfigured();
const d = HAVE_DB ? describe : describe.skip;

const CASES: (string | null)[] = [
  '$150,000',
  '$150,000 - $250,000',
  '$150k',
  '$150K',
  '$150.5k',
  'USD $150,000 - $250,000 DOE',
  'Compensation commensurate with experience',
  null,
  '$204k-$348k',
  '$300k-$450k + equity',
  '$45/hr'
];

function job(comp_posted: string | null): Job {
  // compTop() only reads comp_posted, so the rest of Job is irrelevant to
  // this test and left undefined via a cast rather than dragged in fixture
  // by fixture.
  return { comp_posted } as Job;
}

d('compTopSql(): the SQL comp_top expression, executed for real', () => {
  afterAll(async () => {
    if (HAVE_DB) await db().end();
  });

  it('gives the same number as compTop() for every case, including the fix (comma, no "k")', async () => {
    const { rows } = await db().query(
      `SELECT t.text, ${compTopSql('t.text')} AS comp_top FROM (VALUES ${CASES.map((_, i) => `($${i + 1}::text)`).join(', ')}) AS t(text)`,
      CASES
    );
    expect(rows).toHaveLength(CASES.length);
    for (const row of rows) {
      const text: string | null = row.text;
      const sqlValue = row.comp_top === null ? null : Number(row.comp_top);
      const tsValue = compTop(job(text));
      expect(sqlValue, `mismatch for ${JSON.stringify(text)}`).toBe(tsValue);
    }
  });

  it('pins the fixed values directly, so a future change to the pattern fails loudly here too', async () => {
    const { rows } = await db().query(`SELECT ${compTopSql('$1::text')} AS comp_top`, ['$150,000 - $250,000']);
    expect(Number(rows[0].comp_top)).toBe(250);
    const bare = await db().query(`SELECT ${compTopSql('$1::text')} AS comp_top`, ['$150,000']);
    expect(Number(bare.rows[0].comp_top)).toBe(150);
    const none = await db().query(`SELECT ${compTopSql('$1::text')} AS comp_top`, ['Compensation commensurate with experience']);
    expect(none.rows[0].comp_top).toBeNull();
  });
});
