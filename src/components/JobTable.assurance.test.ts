import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRESH_WINDOW_HOURS } from '../lib/data-contract';

/**
 * The assurance band, which is now the only thing standing between a reader
 * and a false claim of freshness.
 *
 * It was written to withdraw "Every posted row verified this sweep" past
 * FRESH_WINDOW_HOURS and say how long it has actually been. Until 2026-09-28 it
 * could never fire past 48 hours, because the data contract threw at 48 and the
 * page died before the script ran. The contract reports now (see
 * data-contract.ts, "2. Stale"), which means this band finally carries the job
 * it was written for, on a path nothing had ever tested.
 *
 * THE SHIPPED SCRIPT IS WHAT RUNS HERE. It is read out of the .astro file and
 * evaluated, rather than copied into this test, because a copy is a second
 * implementation that can agree with the test while the page disagrees with
 * both. There is no jsdom in this project, so `document` is the smallest stub
 * that satisfies the four DOM calls the script makes; if it ever makes a fifth
 * this test fails loudly rather than silently testing nothing.
 */

const SOURCE = readFileSync(new URL('./JobTable.astro', import.meta.url), 'utf8');

function shippedScript(): string {
  const blocks = [...SOURCE.matchAll(/<script is:inline>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const band = blocks.filter((b) => b.includes('data-assurance-text'));
  expect(band, 'exactly one inline script should own the assurance band').toHaveLength(1);
  return band[0];
}

interface Band {
  attrs: Record<string, string>;
  text: { textContent: string };
}

function bandAt(sweptIso: string | null, freshHours: string | null = String(FRESH_WINDOW_HOURS)): Band {
  const attrs: Record<string, string> = {};
  if (sweptIso !== null) attrs['data-swept'] = sweptIso;
  if (freshHours !== null) attrs['data-fresh-hours'] = freshHours;
  return { attrs, text: { textContent: 'Every posted row verified this sweep · Sep 26, 2026, 07:30 UTC' } };
}

function run(band: Band | null): void {
  const element = band && {
    getAttribute: (name: string) => (name in band.attrs ? band.attrs[name] : null),
    setAttribute: (name: string, value: string) => {
      band.attrs[name] = value;
    },
    querySelector: (sel: string) => (sel === '[data-assurance-text]' ? band.text : null)
  };
  const documentStub = {
    querySelector: (sel: string) => (sel === '[data-swept]' ? element : null)
  };
  new Function('document', shippedScript())(documentStub);
}

const SWEPT = '2026-09-26T07:30:04Z';
const hoursAfterSweep = (h: number) => new Date(Date.parse(SWEPT) + h * 3_600_000);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the assurance band withdraws the freshness claim on the reader clock', () => {
  it('leaves the claim alone inside the window', () => {
    vi.setSystemTime(hoursAfterSweep(FRESH_WINDOW_HOURS - 1));
    const band = bandAt(SWEPT);
    run(band);
    expect(band.text.textContent).toContain('verified this sweep');
    expect(band.attrs['data-stale']).toBeUndefined();
  });

  it('withdraws the claim and states the age at the window', () => {
    vi.setSystemTime(hoursAfterSweep(FRESH_WINDOW_HOURS));
    const band = bandAt(SWEPT);
    run(band);
    expect(band.text.textContent).not.toContain('verified this sweep');
    expect(band.text.textContent).toBe(
      'Last verified 36 hours ago. These rows were true at the last sweep and have not been checked since.'
    );
    expect(band.attrs['data-stale']).toBe('');
  });

  it('counts in days once the data is past the window the contract used to kill the page at', () => {
    vi.setSystemTime(hoursAfterSweep(53.9));
    const band = bandAt(SWEPT);
    run(band);
    // 53.9 hours: the exact age stats.json had reached on 2026-09-28 when every
    // server-rendered page was answering 500 instead of this sentence.
    expect(band.text.textContent).toBe(
      'Last verified 2 days ago. These rows were true at the last sweep and have not been checked since.'
    );
  });

  it('still speaks after a week, because nothing downstream refuses any more', () => {
    vi.setSystemTime(hoursAfterSweep(24 * 8));
    const band = bandAt(SWEPT);
    run(band);
    expect(band.text.textContent).toContain('Last verified 8 days ago');
  });

  it('falls back to the constant rather than never warning when the window attribute is unusable', () => {
    vi.setSystemTime(hoursAfterSweep(40));
    for (const bad of [null, '', 'not-a-number', '0', '-12']) {
      const band = bandAt(SWEPT, bad);
      run(band);
      expect(band.text.textContent, `window attribute ${JSON.stringify(bad)}`).toContain('Last verified');
    }
  });

  it('says nothing when the reader clock is behind the sweep, which is their clock and not our staleness', () => {
    vi.setSystemTime(hoursAfterSweep(-200));
    const band = bandAt(SWEPT);
    run(band);
    expect(band.text.textContent).toContain('verified this sweep');
  });

  it('does nothing at all when the band or its stamp is missing', () => {
    vi.setSystemTime(hoursAfterSweep(100));
    expect(() => run(null)).not.toThrow();

    const noStamp = bandAt(null);
    run(noStamp);
    expect(noStamp.text.textContent).toContain('verified this sweep');

    const unparseable = bandAt('the night before last');
    run(unparseable);
    expect(unparseable.text.textContent).toContain('verified this sweep');
  });

  it('keeps its last-resort fallback equal to the constant it falls back to', () => {
    // The script reads the window off the band, which the page stamps from
    // FRESH_WINDOW_HOURS, so the normal path cannot drift. The fallback is the
    // path that can: it is a literal, it only runs when the attribute is
    // unusable, and it would therefore go stale in complete silence. Change the
    // constant and this fails until the literal follows it.
    expect(SOURCE).toContain('data-fresh-hours={FRESH_WINDOW_HOURS}');

    const fallback = shippedScript().match(/if \(!\(HOURS > 0\)\) HOURS = (\d+(?:\.\d+)?);/);
    expect(fallback, 'the fallback assignment should still be recognisable').not.toBeNull();
    expect(Number(fallback![1])).toBe(FRESH_WINDOW_HOURS);
  });
});
