/**
 * age-ticks.test.ts: ageTicks() collapses an AgeHistogram to one tick per
 * rendered slot, never two of the same band in the same slot, without losing
 * or misattributing a row.
 */
import { describe, expect, it } from 'vitest';
import { agePosition, ageTicks, type AgeBucket, type AgeHistogram } from './data';

function bucket(days: number, rows: number, i: number): AgeBucket {
  return {
    days,
    rows,
    repCompany: `Company ${i}`,
    repTitle: `Role ${i}`,
    repPublishedAt: null
  };
}

function histogramOf(byDay: AgeBucket[]): AgeHistogram {
  const axisMax = byDay.reduce((most, b) => Math.max(most, b.days), 0);
  const total = byDay.reduce((sum, b) => sum + b.rows, 0);
  return { byDay, axisMax, total };
}

describe('ageTicks', () => {
  it('never puts two ticks of the same band in the same slot', () => {
    const byDay = Array.from({ length: 3141 }, (_, days) => bucket(days, 1, days));
    const histogram = histogramOf(byDay);
    const ticks = ageTicks(histogram, histogram.axisMax);
    const step = 100 / 600;
    const seen = new Set<string>();
    for (const t of ticks) {
      const key = `${t.past ? 1 : 0}:${Math.floor(t.at / step)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('sums rows to the histogram total, dense sparse and single-day', () => {
    const dense = histogramOf(Array.from({ length: 500 }, (_, days) => bucket(days, 1, days)));
    const sparse = histogramOf([bucket(1, 3, 0), bucket(200, 5, 1), bucket(900, 2, 2)]);
    const single = histogramOf([bucket(30, 40, 0)]);

    for (const histogram of [dense, sparse, single]) {
      const ticks = ageTicks(histogram, histogram.axisMax);
      const sum = ticks.reduce((s, t) => s + t.rows, 0);
      expect(sum).toBe(histogram.total);
    }
  });

  it('renders the oldest measured day at the axis end', () => {
    const histogram = histogramOf([bucket(1, 1, 0), bucket(50, 1, 1), bucket(365, 1, 2)]);
    const ticks = ageTicks(histogram, histogram.axisMax);
    expect(ticks.some((t) => t.at === 100)).toBe(true);
  });

  it('keeps the youngest day when several days share a slot', () => {
    // A large axisMax compresses the sqrt scale enough that two adjacent old
    // days land in the same slot.
    const axisMax = 3650;
    const d = agePosition(2900, axisMax);
    const dPlus1 = agePosition(2901, axisMax);
    const step = 100 / 600;
    expect(Math.floor(d / step)).toBe(Math.floor(dPlus1 / step));

    const histogram = histogramOf([bucket(2900, 1, 0), bucket(2901, 1, 1)]);
    const ticks = ageTicks(histogram, axisMax);
    const merged = ticks.find((t) => Math.floor(t.at / step) === Math.floor(d / step));
    expect(merged).toBeDefined();
    expect(merged?.days).toBe(2900);
  });

  it('names a row only when its tick stands for exactly one', () => {
    const axisMax = 3650;
    const d = agePosition(2900, axisMax);
    const dPlus1 = agePosition(2901, axisMax);
    const step = 100 / 600;
    expect(Math.floor(d / step)).toBe(Math.floor(dPlus1 / step));

    const merging = histogramOf([bucket(2900, 1, 0), bucket(2901, 1, 1)]);
    const mergedTicks = ageTicks(merging, axisMax);
    const merged = mergedTicks.find((t) => Math.floor(t.at / step) === Math.floor(d / step));
    expect(merged?.rows).toBe(2);
    expect(merged?.company).toBeNull();
    expect(merged?.title).toBeNull();

    const alone = histogramOf([bucket(30, 1, 0)]);
    const aloneTicks = ageTicks(alone, alone.axisMax);
    expect(aloneTicks).toHaveLength(1);
    expect(aloneTicks[0]?.company).toBe('Company 0');
    expect(aloneTicks[0]?.title).toBe('Role 0');
  });

  it('keeps the band in the bucket key so two days sharing a slot still split by band', () => {
    // At this tiny axisMax and slot count, day 7 (not past the 7-day band) and
    // day 8 (past it) land in the same floor-slot on position alone.
    const axisMax = 9;
    const step = 100 / 4;
    const at7 = agePosition(7, axisMax);
    const at8 = agePosition(8, axisMax);
    expect(Math.floor(at7 / step)).toBe(Math.floor(at8 / step));

    const histogram = histogramOf([bucket(7, 1, 0), bucket(8, 1, 1)]);
    const ticks = ageTicks(histogram, axisMax, { slots: 4, bandDays: 7 });
    expect(ticks).toHaveLength(2);
    expect(ticks.some((t) => !t.past)).toBe(true);
    expect(ticks.some((t) => t.past)).toBe(true);
  });

  it('is deterministic and non-decreasing in at, given ascending byDay', () => {
    const byDay = Array.from({ length: 200 }, (_, days) => bucket(days, 1, days));
    const histogram = histogramOf(byDay);
    const first = ageTicks(histogram, histogram.axisMax);
    const second = ageTicks(histogram, histogram.axisMax);
    expect(second).toEqual(first);
    for (let i = 1; i < first.length; i++) {
      expect(first[i]!.at).toBeGreaterThanOrEqual(first[i - 1]!.at);
    }
  });
});
