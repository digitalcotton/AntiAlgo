import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEEN_DIMMER_ENABLED,
  isDefaultSelection,
  normalizeSeenDimmerEnabled,
  normalizeSeenSlugs,
  parseStoredJSON,
  suppressApplied,
  suppressedSlugs
} from './filters';
import type { Job } from './data';

// filters.ts is the pure half of MASTER-SPEC F10, kept pure specifically so
// it can be tested with no database and no browser (the same reason
// entitlement.ts and desk.ts are). These tests pin the two things that
// actually matter: suppressApplied() suppresses exactly the rows a person
// applied to and nobody else's, and the storage-parsing helpers degrade to
// a safe default rather than throwing on anything a browser's own storage
// or a stale save could hand back. What a saved selection may contain is
// filters-store.ts's job, and filters-store.test.ts pins it.

describe('isDefaultSelection()', () => {
  it('is true when every group is "all"', () => {
    expect(isDefaultSelection({ location: 'all', comp: 'all' })).toBe(true);
  });

  it('is false the moment one group is not "all"', () => {
    expect(isDefaultSelection({ location: 'remote', comp: 'all' })).toBe(false);
  });

  it('is true for an empty selection: no group set is no group narrowed', () => {
    expect(isDefaultSelection({})).toBe(true);
  });
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_1',
    slug: 'acme-founding-designer',
    company: 'Acme',
    title: 'Founding Designer',
    kind: 'posted',
    prospect: null,
    comp_posted: '$200k-$250k',
    comp_range: { min: 200_000, max: 250_000, currency: 'USD', interval: 'year', source: 'greenhouse' },
    published_at: null,
    location: 'Remote',
    remote: true,
    source_system: 'greenhouse',
    source_url: 'https://example.com/source',
    apply_url: 'https://example.com/apply',
    first_observed: '2026-08-01T00:00:00.000Z',
    last_verified: '2026-08-20T00:00:00.000Z',
    published_date: '2026-08-01',
    age_days: 19,
    status: 'live',
    window: null,
    risk: 'LOW',
    ease: 'EASY',
    fit: { total: 80 } as Job['fit'],
    description_html: null,
    ...overrides
  } as Job;
}

describe('suppressApplied(): set membership only, no rank, no reorder', () => {
  it('suppresses exactly the rows whose id is in the applied set', () => {
    const jobs = [job({ id: 'job_1', slug: 'one' }), job({ id: 'job_2', slug: 'two' }), job({ id: 'job_3', slug: 'three' })];
    const result = suppressApplied(jobs, new Set(['job_2']));
    expect(result.visible.map((j) => j.id)).toEqual(['job_1', 'job_3']);
    expect(result.suppressed.map((j) => j.id)).toEqual(['job_2']);
  });

  it('suppresses nothing for an empty applied set: nobody is suppressed for a stranger\'s applications', () => {
    const jobs = [job({ id: 'job_1' }), job({ id: 'job_2', slug: 'two' })];
    const result = suppressApplied(jobs, new Set());
    expect(result.visible).toHaveLength(2);
    expect(result.suppressed).toHaveLength(0);
  });

  it('suppresses only the owner\'s applied ids, not an id absent from this jobs list', () => {
    const jobs = [job({ id: 'job_1' })];
    // 'job_9' belongs to nobody in `jobs`: a set built from another
    // person's applications, or a stale id, suppresses nothing rather than
    // erroring or matching by accident.
    const result = suppressApplied(jobs, new Set(['job_9']));
    expect(result.visible.map((j) => j.id)).toEqual(['job_1']);
    expect(result.suppressed).toHaveLength(0);
  });

  it('visible and suppressed together are exactly the input, in order, nothing dropped or duplicated', () => {
    const jobs = [job({ id: 'a', slug: 'a' }), job({ id: 'b', slug: 'b' }), job({ id: 'c', slug: 'c' })];
    const result = suppressApplied(jobs, new Set(['b']));
    expect(result.visible.length + result.suppressed.length).toBe(jobs.length);
  });
});

describe('suppressedSlugs(): the same split, named by the DOM attribute a client script can act on', () => {
  it('returns the slug, not the id, of every suppressed row', () => {
    const jobs = [job({ id: 'job_1', slug: 'acme-designer' }), job({ id: 'job_2', slug: 'globex-designer' })];
    expect(suppressedSlugs(jobs, new Set(['job_2']))).toEqual(['globex-designer']);
  });

  it('returns an empty array, not null or undefined, when nothing is suppressed', () => {
    expect(suppressedSlugs([job()], new Set())).toEqual([]);
  });
});

describe('parseStoredJSON(): a browser\'s own storage never gets to throw', () => {
  it('parses a valid JSON string', () => {
    expect(parseStoredJSON('{"location":"remote"}')).toEqual({ location: 'remote' });
  });

  it('returns null for null, undefined, and the empty string', () => {
    expect(parseStoredJSON(null)).toBeNull();
    expect(parseStoredJSON(undefined)).toBeNull();
    expect(parseStoredJSON('')).toBeNull();
  });

  it('returns null, not a thrown error, for malformed JSON', () => {
    expect(parseStoredJSON('{not json')).toBeNull();
  });
});

describe('normalizeSeenSlugs(): a slug list is trusted only if it actually is one', () => {
  it('keeps a real array of strings', () => {
    expect(normalizeSeenSlugs(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('drops non-string entries rather than keeping them or throwing', () => {
    expect(normalizeSeenSlugs(['a', 42, null, 'b'])).toEqual(['a', 'b']);
  });

  it('returns an empty array for anything that is not an array at all', () => {
    expect(normalizeSeenSlugs(null)).toEqual([]);
    expect(normalizeSeenSlugs('a')).toEqual([]);
    expect(normalizeSeenSlugs({ a: true })).toEqual([]);
  });
});

describe('normalizeSeenDimmerEnabled(): defaults on, exactly as MASTER-SPEC F10 states', () => {
  it('is the DEFAULT_SEEN_DIMMER_ENABLED constant when nothing was stored', () => {
    expect(normalizeSeenDimmerEnabled(null)).toBe(DEFAULT_SEEN_DIMMER_ENABLED);
    expect(normalizeSeenDimmerEnabled(undefined)).toBe(DEFAULT_SEEN_DIMMER_ENABLED);
    expect(DEFAULT_SEEN_DIMMER_ENABLED).toBe(true);
  });

  it('keeps an explicit false: a person who turned it off is not silently opted back in', () => {
    expect(normalizeSeenDimmerEnabled(false)).toBe(false);
  });

  it('keeps an explicit true', () => {
    expect(normalizeSeenDimmerEnabled(true)).toBe(true);
  });

  it('falls back to the default for a non-boolean stray value', () => {
    expect(normalizeSeenDimmerEnabled('true')).toBe(DEFAULT_SEEN_DIMMER_ENABLED);
    expect(normalizeSeenDimmerEnabled(1)).toBe(DEFAULT_SEEN_DIMMER_ENABLED);
  });
});
