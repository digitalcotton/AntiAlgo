/**
 * board-edition.test.mjs: proving the build can tell this site's board file from
 * the other site's.
 *
 * THE FILES THIS IS WRITTEN AGAINST. The _meta blocks below are copied verbatim
 * out of the two real exports of the 2026-09-30 crawl, which are both still in
 * this repository's git history: 438b0a0 carries the curated edition (2,893 rows)
 * and 78c68d7 carries the everything edition (52,739 rows), same crawl, same
 * filename, same field order. The only difference a build can see is the one
 * string this module reads, which is exactly why reading it has to be right.
 *
 * WHY THE FIXTURES ARE BUILT HERE AND NOT COMMITTED. The real everything export
 * is 46 MB compressed. The property worth testing is that the reader finds _meta
 * in a prefix of a file far larger than the prefix it reads, and a few hundred
 * KiB of gzip written into a temporary directory proves that without putting a
 * board in the repo (which 9dda746 removed for good reason).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVERYTHING_EDITION, metaFrom, readBoardMeta } from '../src/lib/board-edition.mjs';

/** The everything export's _meta, verbatim from 78c68d7. */
const EVERYTHING_META = {
  source: 'mini all-jobs tracker, every role',
  generated_from: '2026-09-30T01:27:21Z',
  boards_swept: 2998,
  postings_observed: 55862,
  stages: {
    read: '2026-09-30T11:27:49Z',
    verify: '2026-09-30T11:53:55Z',
    kill: '2026-09-30T11:53:59Z',
    save: '2026-09-30T11:53:59Z'
  },
  count: 52739,
  with_description: 48637,
  note: 'every role the crawl read, no title filter; the site narrows on request'
};

/** The curated export's _meta, verbatim from 438b0a0. This is the file that got
 *  loaded over the full board on 2026-10-01. */
const CURATED_META = {
  source: 'mini all-jobs tracker, full in-scope (design+AI+UXR)',
  generated_from: '2026-09-30T01:27:21Z',
  boards_swept: 2998,
  postings_observed: 55862,
  count: 2893,
  with_description: 2792,
  note: 'full in-scope export for the board DB ingest; ingest-jobs.mjs narrows further'
};

/** A board document of the real shape: _meta first, then the rows. The rows are
 *  varied rather than repeated so the gzip does not collapse to nothing and the
 *  file genuinely exceeds the 64 KiB the reader looks at. */
function document(meta, rows = 4000) {
  const jobs = [];
  for (let i = 0; i < rows; i += 1) {
    jobs.push({
      id: `greenhouse|${i}-${(i * 2654435761) % 1_000_003}`,
      company: `Company ${i} of ${rows}`,
      title: `Staff Something ${i}`,
      apply_url: `https://boards.example/${i}/apply?src=${(i * 7919) % 99991}`,
      description_html: `<p>Role ${i}, team ${i % 37}, in city ${i % 211}.</p>`
    });
  }
  return JSON.stringify({ _meta: meta, jobs });
}

let dir;
const paths = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'board-edition-'));
  const write = async (name, body) => {
    const path = join(dir, name);
    await writeFile(path, name.endsWith('.gz') ? gzipSync(body) : body);
    paths[name] = path;
    return path;
  };
  await write('everything.json.gz', document(EVERYTHING_META));
  await write('curated.json.gz', document(CURATED_META));
  await write('no-meta.json.gz', JSON.stringify({ jobs: [] }));
  await write('bare-array.json.gz', JSON.stringify([{ id: 'x' }]));
  await write('plain.json', document(EVERYTHING_META, 20));
  await write('truncated.gz', gzipSync('not json at all'));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('readBoardMeta()', () => {
  it('finds _meta in a gzipped board far larger than the prefix it reads', async () => {
    const { meta, why } = await readBoardMeta(paths['everything.json.gz']);
    expect(why).toBeUndefined();
    expect(meta.source).toBe(EVERYTHING_EDITION);
    expect(meta.count).toBe(52_739);
    // The nested object has to survive the brace walk, because board_stats
    // .stage_log is read from it downstream.
    expect(meta.stages.save).toBe('2026-09-30T11:53:59Z');
  });

  it('reads the curated edition correctly, and it is not the one this site serves', async () => {
    const { meta } = await readBoardMeta(paths['curated.json.gz']);
    expect(meta.source).toBe('mini all-jobs tracker, full in-scope (design+AI+UXR)');
    expect(meta.source).not.toBe(EVERYTHING_EDITION);
    expect(meta.count).toBe(2_893);
  });

  it('reads a plain uncompressed file too', async () => {
    const { meta } = await readBoardMeta(paths['plain.json']);
    expect(meta.source).toBe(EVERYTHING_EDITION);
  });

  it('gives a reason, not a crash, for a file with no _meta', async () => {
    const { meta, why } = await readBoardMeta(paths['no-meta.json.gz']);
    expect(meta).toBeUndefined();
    expect(why).toContain('_meta');
  });

  it('gives a reason for a bare array of rows, which declares no edition', async () => {
    const { meta, why } = await readBoardMeta(paths['bare-array.json.gz']);
    expect(meta).toBeUndefined();
    expect(why).toContain('_meta');
  });

  it('gives a reason for a file that is not a board at all', async () => {
    const { meta, why } = await readBoardMeta(paths['truncated.gz']);
    expect(meta).toBeUndefined();
    expect(typeof why).toBe('string');
  });

  it('gives a reason for a file that is not there, rather than throwing', async () => {
    const { meta, why } = await readBoardMeta(join(dir, 'absent.json.gz'));
    expect(meta).toBeUndefined();
    expect(why).toContain('could not be read');
  });
});

describe('metaFrom(), the brace walk', () => {
  it('is not fooled by a brace inside a string value', () => {
    // The note field is free prose written by a person. The day one of them
    // contains a brace, a naive counter stops at the wrong character and the
    // parse fails, which would read as "this file has no edition" on a file that
    // does. That is a check failing open on the wrong input.
    const text = `{"_meta": {"source": "a {b} c", "note": "} not the end"}, "jobs": [`;
    expect(metaFrom(text).meta.source).toBe('a {b} c');
  });

  it('is not fooled by an escaped quote', () => {
    const text = `{"_meta": {"source": "say \\"everything\\"", "count": 3}, "jobs": [`;
    expect(metaFrom(text).meta.count).toBe(3);
  });

  it('refuses a _meta that runs past the prefix instead of guessing', () => {
    const { meta, why } = metaFrom('{"_meta": {"source": "mini all-jobs tracker, every');
    expect(meta).toBeUndefined();
    expect(why).toContain('runs past the prefix');
  });

  it('refuses a _meta that is not an object', () => {
    const { meta, why } = metaFrom('{"_meta": null, "jobs": []}');
    expect(meta).toBeUndefined();
    expect(why).toBeTruthy();
  });
});

describe('EVERYTHING_EDITION', () => {
  it('is the exact string the mini writes', () => {
    // A literal assertion against a literal constant, deliberately. This is the
    // ratchet: the constant is the whole check, and "relax the string until the
    // build goes green" is the obvious wrong fix for a red deploy. Changing it
    // has to mean changing this line too, with a reason.
    expect(EVERYTHING_EDITION).toBe('mini all-jobs tracker, every role');
  });
});
