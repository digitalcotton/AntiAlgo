import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PROSPECT_AGE_HOURS, prospectsBeyondFreshness } from './data-contract';

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
