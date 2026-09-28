import { describe, expect, it } from 'vitest';
import {
  COLUMNS_PER_ROW,
  MAX_ROWS_PER_STATEMENT,
  assertBatchFits,
  upsertSql
} from './upsert-sql.mjs';

/**
 * The ingest sent one INSERT per posting. At 1,900 rows from a build container
 * that was fine; at the whole crawl, run from the mini over a home connection,
 * it is thousands of sequential round trips with the TRUNCATE held for all of
 * them. These tests pin the batched statement's shape, because a placeholder
 * off by one would bind the wrong column to the wrong row and write plausible
 * nonsense rather than failing.
 */

describe('upsertSql', () => {
  // 30 since 2026-09-23: db/207 added the eight derived columns the Jobs Data
  // page filters on, written at ingest by src/lib/jobs-derived.mjs.
  // 31 since 2026-09-27: db/212 added derived_fam_source, which says whether
  // the family came from the employer's department or from reading the title.
  it('binds 31 placeholders for a single row, starting at $1', () => {
    const sql = upsertSql(1);
    expect(sql).toContain(
      '($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,' +
      '$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31'
    );
    expect(sql).not.toContain('$32');
  });

  it('numbers each row consecutively with no gaps or repeats', () => {
    const rows = 7;
    const sql = upsertSql(rows);
    const seen = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const expected = Array.from({ length: rows * COLUMNS_PER_ROW }, (_, i) => i + 1);
    expect(seen).toEqual(expected);
  });

  it('emits one VALUES tuple per row', () => {
    for (const n of [1, 2, 250]) {
      const tuples = upsertSql(n).match(/\(\$\d+,/g) ?? [];
      expect(tuples.length, `for ${n} rows`).toBe(n);
    }
  });

  it('keeps every row live, unkilled and freshly stamped, as the per-row form did', () => {
    const sql = upsertSql(3);
    expect(sql.match(/'live', NULL, now\(\)/g)).toHaveLength(3);
  });

  it('updates from EXCLUDED, which is what the numbered form meant one row at a time', () => {
    const sql = upsertSql(2);
    expect(sql).toContain('ON CONFLICT (id) DO UPDATE SET');
    expect(sql).toContain('company=EXCLUDED.company');
    expect(sql).toContain('description=EXCLUDED.description');
    // status and kill_id are reset outright, not carried from the incoming row.
    expect(sql).toContain("status='live', kill_id=NULL, ingested_at=now()");
  });

  it('writes every column values() binds, and no others', () => {
    const cols = upsertSql(1).slice(0, upsertSql(1).indexOf('VALUES'))
      .replace(/[\s\S]*INSERT INTO jobs \(/, '').replace(/\)[\s\S]*/, '')
      .split(',').map((c) => c.trim());
    // The bound columns plus the three written literally.
    expect(cols).toHaveLength(COLUMNS_PER_ROW + 3);
    expect(cols.slice(-3)).toEqual(['status', 'kill_id', 'ingested_at']);
  });

  it('refuses a batch Postgres would reject, before anything is sent', () => {
    // 65535 / 31 columns. It was 2184 at 30 columns; a wider row means fewer
    // rows fit in one statement, and the ingest's batch size is derived from
    // this rather than guessed.
    expect(MAX_ROWS_PER_STATEMENT).toBe(2114);
    expect(() => upsertSql(MAX_ROWS_PER_STATEMENT)).not.toThrow();
    expect(() => upsertSql(MAX_ROWS_PER_STATEMENT + 1)).toThrow(/65535/);
    expect(() => assertBatchFits(10_000)).toThrow(/Lower --batch/);
  });

  it('refuses an empty or nonsense batch rather than building invalid SQL', () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(() => upsertSql(bad), String(bad)).toThrow();
    }
  });

  it('the default batch of 250 is well inside the ceiling', () => {
    expect(250 * COLUMNS_PER_ROW).toBeLessThan(65535);
    expect(() => upsertSql(250)).not.toThrow();
  });
});
