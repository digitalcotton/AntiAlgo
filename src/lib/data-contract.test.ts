import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_DATA_AGE_HOURS,
  MAX_PROSPECT_AGE_HOURS,
  assertDataContract,
  prospectsBeyondFreshness,
  type ContractDocs
} from './data-contract';
import realJobs from '../data/jobs.json';
import realKills from '../data/kills.json';
import realKillArchive from '../data/kills-archive.json';
import realStats from '../data/stats.json';
import realFacts from '../data/facts.json';
import realProspects from '../data/prospects.json';

/**
 * prospectsBeyondFreshness is the render-time guard behind the Pre-List's
 * funding clock: past the attended window, data.ts stops standing behind the
 * baked "about N months ago" figure. now() reads DATA_CONTRACT_NOW, so these
 * pin the instant and check the boundary and the cannot-vouch cases.
 */

const ORIGINAL = process.env.DATA_CONTRACT_NOW;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DATA_CONTRACT_NOW;
  else process.env.DATA_CONTRACT_NOW = ORIGINAL;
});

const NOW = '2026-08-30T00:00:00Z';

function writtenHoursAgo(hours: number): { _meta: { generated_at_utc: string } } {
  const ms = Date.parse(NOW) - hours * 3_600_000;
  return { _meta: { generated_at_utc: new Date(ms).toISOString() } };
}

describe('prospectsBeyondFreshness', () => {
  it('is false just inside the attended window and true just past it', () => {
    process.env.DATA_CONTRACT_NOW = NOW;
    expect(prospectsBeyondFreshness(writtenHoursAgo(MAX_PROSPECT_AGE_HOURS - 1))).toBe(false);
    expect(prospectsBeyondFreshness(writtenHoursAgo(MAX_PROSPECT_AGE_HOURS + 1))).toBe(true);
  });

  it('treats a missing or unparseable stamp as beyond freshness, because an age that cannot be established cannot be vouched for', () => {
    process.env.DATA_CONTRACT_NOW = NOW;
    expect(prospectsBeyondFreshness(undefined)).toBe(true);
    expect(prospectsBeyondFreshness({})).toBe(true);
    expect(prospectsBeyondFreshness({ _meta: {} })).toBe(true);
    expect(prospectsBeyondFreshness({ _meta: { generated_at_utc: 'not-a-date' } })).toBe(true);
  });
});

/**
 * The stale/wrong split, which is the whole shape of this module.
 *
 * Written after 2026-09-28, when a duplicate slug in the kill archive stopped
 * the mini's export for four nights, stats.json crossed 48 hours, and every
 * route that imports data.ts returned 500 — including /sign-in, which renders
 * no sweep number at all. assertDataContract is called at module scope and this
 * site evaluates module scope per request, so the throw was not a build gate.
 * It was the live site deleting itself over the age of a number.
 *
 * These run against the REAL src/data files rather than a hand-built fixture,
 * because the thing under test is the relationship between the clock and those
 * documents, and a fixture consistent enough to reach assertFresh is a copy of
 * them anyway. The clock moves; the data does not.
 */
describe('assertDataContract: old data is reported, wrong data still refuses', () => {
  const docs = () => ({
    jobs: structuredClone(realJobs) as unknown as ContractDocs['jobs'],
    kills: structuredClone(realKills) as unknown as ContractDocs['kills'],
    killArchive: structuredClone(realKillArchive) as unknown as ContractDocs['killArchive'],
    stats: structuredClone(realStats) as unknown as ContractDocs['stats'],
    facts: structuredClone(realFacts) as unknown as ContractDocs['facts'],
    prospects: structuredClone(realProspects) as unknown as ContractDocs['prospects']
  });

  const sweptMs = Date.parse((realStats as { swept_at_utc: string }).swept_at_utc);
  const atHour = (h: number) => new Date(sweptMs + h * 3_600_000).toISOString();

  it('says nothing while the data is inside the window', () => {
    process.env.DATA_CONTRACT_NOW = atHour(MAX_DATA_AGE_HOURS - 2);
    expect(assertDataContract(docs()).filter((n) => n.includes('hours old'))).toEqual([]);
  });

  it('reports the age past the window instead of throwing, so the site keeps serving', () => {
    process.env.DATA_CONTRACT_NOW = atHour(53.9);
    let notes: string[] = [];
    expect(() => {
      notes = assertDataContract(docs());
    }).not.toThrow();

    const stale = notes.filter((n) => n.includes('hours old'));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('53.9 hours old');
    expect(stale[0]).toContain(`past the ${MAX_DATA_AGE_HOURS} hour window`);
    // It has to name the remedy, because the remedy is not in this repository.
    expect(stale[0]).toContain('Re-run the sweep on the mini');
  });

  it('keeps reporting rather than throwing however old the data gets', () => {
    process.env.DATA_CONTRACT_NOW = atHour(24 * 30);
    expect(() => assertDataContract(docs())).not.toThrow();
  });

  it('still refuses a sweep stamped in the future, which is a broken clock and not an age', () => {
    process.env.DATA_CONTRACT_NOW = atHour(-6);
    expect(() => assertDataContract(docs())).toThrow(/hours in the future/);
  });

  it('still refuses totals that do not reconcile, however fresh the clock is', () => {
    process.env.DATA_CONTRACT_NOW = atHour(1);
    const broken = docs();
    (broken.stats as Record<string, unknown>).verified_live =
      Number((broken.stats as Record<string, number>).verified_live) + 1;
    expect(() => assertDataContract(broken)).toThrow(/data contract/);
  });

  it('refuses wrong data even when it is also old, because age is never the thing that excuses it', () => {
    process.env.DATA_CONTRACT_NOW = atHour(100);
    const broken = docs();
    (broken.stats as Record<string, unknown>).swept_at_utc = 'not-an-instant';
    expect(() => assertDataContract(broken)).toThrow(/data contract/);
  });
});
