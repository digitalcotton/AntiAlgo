import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEEN_DIMMER_ENABLED,
  isDefaultSelection,
  normalizeFilterSelection,
  normalizeSeenDimmerEnabled,
  normalizeSeenSlugs,
  parseStoredJSON,
  suppressApplied,
  suppressedSlugs,
  type FilterSelection
} from './filters';
import type { FilterGroup, Job } from './data';

// filters.ts is the pure half of MASTER-SPEC F10, kept pure specifically so
// it can be tested with no database and no browser (the same reason
// entitlement.ts and desk.ts are). These tests pin the three things that
// actually matter: normalizeFilterSelection() never trusts a value it was
// not told about, suppressApplied() suppresses exactly the rows a person
// applied to and nobody else's, and the storage-parsing helpers degrade to
// a safe default rather than throwing on anything a browser's own storage
// or a stale save could hand back.

const GROUPS: FilterGroup[] = [
  {
    key: 'location',
    label: 'Location',
    options: [
      { value: 'all', label: 'All', count: 3 },
      { value: 'remote', label: 'Remote', count: 2 },
      { value: 'onsite', label: 'On-site or hybrid', count: 1 }
    ]
  },
  {
    key: 'comp',
    label: 'Comp',
    options: [
      { value: 'all', label: 'All', count: 3 },
      { value: '200-250', label: '$200K to $250K', count: 2 },
      { value: 'not-listed', label: 'Not listed', count: 1 }
    ]
  }
];

describe('normalizeFilterSelection(): never trusts a value it was not told about', () => {
  it('keeps a value that is one of the group\'s own options', () => {
    const selection = normalizeFilterSelection({ location: 'remote' }, GROUPS);
    expect(selection.location).toBe('remote');
  });

  it('falls back to "all" for a value that is not one of the group\'s own options', () => {
    const selection = normalizeFilterSelection({ location: 'on-mars' }, GROUPS);
    expect(selection.location).toBe('all');
  });

  it('falls back to "all" for a group missing from the raw input entirely', () => {
    const selection = normalizeFilterSelection({}, GROUPS);
    expect(selection).toEqual({ location: 'all', comp: 'all' });
  });

  it('drops a key the live groups do not name, rather than carrying it forward', () => {
    const selection = normalizeFilterSelection({ location: 'remote', freshness: 'fresh' }, GROUPS);
    expect(selection).toEqual({ location: 'remote', comp: 'all' });
    expect('freshness' in selection).toBe(false);
  });

  it('treats null, a string, and an array all as "nothing was stored"', () => {
    expect(normalizeFilterSelection(null, GROUPS)).toEqual({ location: 'all', comp: 'all' });
    expect(normalizeFilterSelection('remote', GROUPS)).toEqual({ location: 'all', comp: 'all' });
    expect(normalizeFilterSelection(['remote'], GROUPS)).toEqual({ location: 'all', comp: 'all' });
  });

  it('rejects a numeric or object value pretending to be a group\'s option value', () => {
    const selection = normalizeFilterSelection({ location: 42, comp: { sneaky: true } }, GROUPS);
    expect(selection).toEqual({ location: 'all', comp: 'all' });
  });
});

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

// A round trip, end to end, at the pure layer: exactly what the
// verification checklist asks for ("filter state round-trips through the
// store"), the half of it this file can prove without a connection string.
// filters-store.test.ts proves the row-to-shape half on the other side of
// the same round trip.
describe('normalizeFilterSelection(): round-trips a real selection through JSON, the way storage actually holds it', () => {
  it('comes back identical after a stringify/parse cycle', () => {
    const original: FilterSelection = { location: 'remote', comp: '200-250' };
    const roundTripped = normalizeFilterSelection(JSON.parse(JSON.stringify(original)), GROUPS);
    expect(roundTripped).toEqual(original);
  });
});
