/**
 * ingest-floor.test.mjs: the night over night floor, proven on the numbers that
 * produced it.
 *
 * WHY THESE NUMBERS AND NOT ROUND ONES. Every count below is a real count off
 * this pipeline, because the fraction in src/lib/ingest-floor.mjs was chosen from
 * them and a test written against 100 and 50 would still pass if somebody moved
 * the floor to a figure that re-admits the 2026-10-01 near miss. The cases are
 * the ones the floor exists to tell apart:
 *
 *   57,852  the board on 2026-10-01, the night this was written
 *   52,739  the board on 2026-09-30
 *   37,765  the board on 2026-09-28, and what this machine's dev database holds
 *    4,330  the curated edition that a production build loaded over 57,852 rows
 *            and that survived only by losing a two second race
 *    2,893  the curated edition on 2026-09-30, 5.5% of the full board
 *   10,000  usajobs, the largest adapter, 16.4% of the 61,012 postings pulled
 *    6,694  iCIMS, the next largest, 11.0%
 *
 * The two adapter numbers are here as the headroom case: the floor has to let the
 * biggest adapter die, and the two biggest die together, or it is a floor that
 * will be switched off the first time a vendor has a bad night.
 *
 * It also asserts on the MESSAGE, not only the verdict. The refusal has to name
 * the flag, both counts and the fraction, because jobmachine/publish/db.py hands
 * an operator the last six lines of stderr and nothing else; a refusal that is
 * right and unreadable sends somebody hunting through this repository at 4am.
 */
import { describe, expect, it } from 'vitest';
import { FLOOR, OVERRIDE_FLAG, floorVerdict } from '../src/lib/ingest-floor.mjs';

/** The 2026-10-01 board, the baseline most of these cases are measured against. */
const PUBLISHED = 57_852;

/** Shorthand: a board of `published` rows, written by the previous ingest, being
 *  replaced by `incoming`. remembered matches published, which is the normal
 *  case and what this machine's dev database shows (37,286 live + 479 killed). */
const verdict = (incoming, published = PUBLISHED, extra = {}) =>
  floorVerdict({
    incoming,
    published,
    remembered: published,
    rememberedAt: '2026-10-01T05:15:47.000Z',
    ...extra
  });

describe('floorVerdict(), the cases that bought it', () => {
  it('refuses the curated edition landing on the full board', () => {
    const v = verdict(4_330);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('refuse-shrink');
    expect(v.baseline).toBe(PUBLISHED);
    // 4,330 / 57,852 = 7.49%, a 92.5% drop. Sixty points clear of the floor.
    expect(v.retained).toBeLessThan(0.08);
  });

  it('refuses the curated edition against the 09-30 board too', () => {
    expect(verdict(2_893, 52_739).ok).toBe(false);
  });

  it('refuses a crawl that reached a tenth of its boards', () => {
    expect(verdict(5_785).ok).toBe(false);
  });

  it('names the flag, both counts and the fraction in the refusal', () => {
    const v = verdict(4_330);
    const said = v.lines.join('\n');
    expect(said).toContain('4,330');
    expect(said).toContain('57,852');
    expect(said).toContain('70.0%');
    expect(said).toContain(OVERRIDE_FLAG);
    // And the one sentence that has to stand alone, because the catch in
    // scripts/ingest-jobs.mjs throws with it and that may be the only line a
    // publish log surfaces.
    expect(v.summary).toContain('4,330');
    expect(v.summary).toContain('57,852');
    expect(v.summary).toContain(OVERRIDE_FLAG);
  });

  it('keeps the refusal inside the five lines a publish log will show', () => {
    // publish/db.py tails six lines of stderr and the catch adds the sixth.
    expect(verdict(4_330).lines.length).toBeLessThanOrEqual(5);
  });

  it('carries the incoming edition into the message, so the fix is obvious', () => {
    const v = verdict(4_330, PUBLISHED, {
      source: 'mini all-jobs tracker, full in-scope (design+AI+UXR)'
    });
    expect(v.lines.join('\n')).toContain('mini all-jobs tracker, full in-scope (design+AI+UXR)');
  });

  it('says so plainly when the file will not name its edition', () => {
    expect(verdict(4_330).lines.join('\n')).toContain('does not say which edition it is');
  });
});

describe('floorVerdict(), the headroom a normal bad night needs', () => {
  it('lets the largest adapter die whole', () => {
    // usajobs, 10,000 of 61,012 postings on the 2026-10-01 crawl.
    const v = verdict(PUBLISHED - 10_000);
    expect(v.ok).toBe(true);
    expect(v.code).toBe('allow-within-floor');
  });

  it('lets the two largest adapters die on the same night', () => {
    // usajobs plus iCIMS, 16,694 of 61,012: a 27.4% loss, the worst honest night
    // this pipeline's records can describe.
    const v = verdict(PUBLISHED - 16_694);
    expect(v.ok).toBe(true);
    expect(v.retained).toBeGreaterThan(FLOOR);
  });

  it('never measures growth against the floor', () => {
    // 37,765 -> 52,739 on 2026-09-30, when discovery took the crawl from 1,666
    // boards to 2,998. A 40% jump is a Tuesday, not an alarm.
    const v = verdict(52_739, 37_765);
    expect(v.ok).toBe(true);
    expect(v.code).toBe('allow-grew');
  });

  it('allows a drop exactly on the floor and refuses one just under it', () => {
    const published = 1_000;
    expect(verdict(700, published).ok).toBe(true);
    expect(verdict(699, published).ok).toBe(false);
  });
});

describe('floorVerdict(), the gates the flag does and does not open', () => {
  it('publishes a refused drop when a person passes the flag, and says so loudly', () => {
    const v = verdict(4_330, PUBLISHED, { allowShrink: true });
    expect(v.ok).toBe(true);
    expect(v.code).toBe('allow-override');
    const said = v.lines.join('\n');
    expect(said).toContain(OVERRIDE_FLAG);
    expect(said).toContain('4,330');
    expect(said).toContain('57,852');
    expect(said).toContain('92.5%');
  });

  it('refuses an empty file even with the flag', () => {
    const v = verdict(0, PUBLISHED, { allowShrink: true });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('refuse-empty');
    expect(v.lines.join('\n')).toContain('does not open this gate');
  });

  it('refuses an empty file into an empty table, so two faults cannot agree', () => {
    const v = floorVerdict({ incoming: 0, published: 0 });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('refuse-empty');
  });
});

describe('floorVerdict(), a fresh database is never deadlocked', () => {
  it('loads a first board into an empty table', () => {
    const v = floorVerdict({ incoming: 57_852, published: 0, remembered: null });
    expect(v.ok).toBe(true);
    expect(v.code).toBe('allow-first-load');
  });

  it('loads into an emptied table even when board_stats still remembers a board', () => {
    // A table someone truncated by hand. Refusing here would mean a database
    // that cannot be filled again without a flag, which is a worse failure than
    // the one the floor is for.
    const v = floorVerdict({ incoming: 12_000, published: 0, remembered: 57_852 });
    expect(v.ok).toBe(true);
    expect(v.code).toBe('allow-first-load');
  });
});

describe('floorVerdict(), the two copies of the row count', () => {
  it('passes silently when the table and board_stats agree', () => {
    // 37,286 live + 479 killed = 37,765, which is what count(*) returns on this
    // machine's dev board. Agreement is the normal state and earns no line.
    const v = floorVerdict({ incoming: 37_765, published: 37_765, remembered: 37_765 });
    expect(v.lines.join('\n')).not.toContain('outside this ingest');
  });

  it('takes the larger as the baseline when they disagree, and reports it', () => {
    // The shape of the 2026-10-01 race seen from the second writer: the table has
    // already been clobbered down to 4,330 and board_stats still remembers the
    // night's real board. The floor must protect the bigger claim.
    const v = floorVerdict({ incoming: 4_330, published: 4_330, remembered: 57_852 });
    expect(v.ok).toBe(false);
    expect(v.baseline).toBe(57_852);
    expect(v.lines.join('\n')).toContain('outside this ingest');
  });

  it('still lets the full board through after a rival shrank the table', () => {
    const v = floorVerdict({ incoming: 57_852, published: 4_330, remembered: 57_852 });
    expect(v.ok).toBe(true);
  });
});

describe('floorVerdict(), a caller bug is not a bad crawl', () => {
  it('throws on a count that is not a whole number', () => {
    expect(() => floorVerdict({ incoming: 1.5, published: 10 })).toThrow(/whole count/);
    expect(() => floorVerdict({ incoming: 10, published: -1 })).toThrow(/whole count/);
    expect(() => floorVerdict({ incoming: NaN, published: 10 })).toThrow(/whole count/);
    expect(() => floorVerdict({ incoming: 10, published: 10, remembered: 'lots' })).toThrow(/whole count/);
  });
});
