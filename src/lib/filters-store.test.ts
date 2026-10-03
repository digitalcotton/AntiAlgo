import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBoardQuery, stripValues } from './board-query';

// The one seam saveFilterState() has with the outside world, replaced so it can be
// called without a connection string (the one thing a worker in this repository is
// not allowed to open). The fake returns the row it was asked to write, which is
// what the real INSERT ... RETURNING * does, so what comes back is what the table
// would hand the next reader.
const query = vi.fn();
vi.mock('./db', () => ({ db: () => ({ query }) }));

import { normalizeSavedSelection, readSavedSelection, rowToStoredFilterState, saveFilterState, type FilterStateRow } from './filters-store';

// filters-store.ts is the impure half of the stateful filter. The mapping from a
// row or a request body to the selection the strip speaks is pure (no I/O in it at
// all), the same seam watchlist-store.test.ts and desk-store.test.ts already test
// for their own tables, and it is where every rule of this file lives.
//
// saveFilterState()'s idempotency (saving again overwrites, not appends) is not
// re-proven here: the guarantee lives in db/109_account_filter_state.sql's PRIMARY
// KEY (user_id) and the ON CONFLICT DO UPDATE the store's header explains, not in
// branching logic this file could run without a live connection. What IS proven is
// that nothing reaches that INSERT unchecked.

function filterStateRow(overrides: Partial<FilterStateRow> = {}): FilterStateRow {
  return {
    user_id: 'user_1',
    selection: { place: 'GB', remote: 'remote', pay_min: 'not-listed' },
    created_at: new Date('2026-08-20T00:00:00.000Z'),
    updated_at: new Date('2026-08-20T00:00:00.000Z'),
    ...overrides
  };
}

const NOTHING = { place: 'all', remote: 'all', pay_min: 'all' };

describe('rowToStoredFilterState(): the row-to-shape mapping, not the query', () => {
  it('carries a well-formed strip selection across as selection, unaltered', () => {
    const stored = rowToStoredFilterState(filterStateRow());
    expect(stored.selection).toEqual({ place: 'GB', remote: 'remote', pay_min: 'not-listed' });
  });

  it('converts updated_at to a Date', () => {
    const stored = rowToStoredFilterState(filterStateRow({ updated_at: new Date('2026-08-21T00:00:00.000Z') }));
    expect(stored.updatedAt).toEqual(new Date('2026-08-21T00:00:00.000Z'));
  });

  it('accepts a string timestamp (what a test or a driver quirk might hand back) as well as a Date', () => {
    const stored = rowToStoredFilterState(filterStateRow({ updated_at: '2026-08-22T00:00:00.000Z' }));
    expect(stored.updatedAt).toEqual(new Date('2026-08-22T00:00:00.000Z'));
  });

  it('does not carry created_at onto StoredFilterState: the reader only needs the last save', () => {
    const stored = rowToStoredFilterState(filterStateRow());
    expect(stored).toEqual({
      selection: { place: 'GB', remote: 'remote', pay_min: 'not-listed' },
      updatedAt: new Date('2026-08-20T00:00:00.000Z')
    });
  });

  it('reads a column that is null, an array or a stray primitive as the strip with nothing chosen, never a throw', () => {
    // A defensive case that should never happen against the real schema
    // (selection is NOT NULL DEFAULT '{}'::jsonb), kept anyway for the same
    // reason rowToStoredFollow() and rowToStoredSavedJob() do not trust a
    // driver to always agree with a migration: the column is untyped as
    // far as Postgres' wire protocol is concerned.
    for (const selection of [null, ['not', 'an', 'object'], 'not-an-object', 7, {}]) {
      expect(rowToStoredFilterState(filterStateRow({ selection })).selection).toEqual(NOTHING);
    }
  });

  it('reads a row saved by the first strip as the selection it was (no migration ran)', () => {
    // The shape db rows have today: written by the Location/Comp/Freshness
    // selects, before the strip spoke place, remote and a pay floor.
    const stored = rowToStoredFilterState(filterStateRow({ selection: { location: 'remote', comp: '150-200', freshness: 'all' } }));
    expect(stored.selection).toEqual({ place: 'all', remote: 'remote', pay_min: '150' });
  });
});

describe('normalizeSavedSelection(): what may be written', () => {
  it('keeps a full strip selection exactly as the strip writes it', () => {
    const chosen = { place: 'US-MD/Baltimore', remote: 'remote,onsite', pay_min: '150' };
    expect(normalizeSavedSelection(chosen)).toEqual(chosen);
  });

  it('keeps every shape of place key the address accepts: a country, a region, a city', () => {
    for (const place of ['GB', 'US-MD', 'GB/London', 'US-MD/Baltimore', "CA-ON/St. John's"]) {
      expect(normalizeSavedSelection({ place }).place, place).toBe(place);
    }
  });

  it('keeps Not stated: place=unstated is a real choice now, and survives a save and a read', () => {
    expect(normalizeSavedSelection({ place: 'unstated' }).place).toBe('unstated');
    expect(readSavedSelection({ place: 'unstated' }).place).toBe('unstated');
    const saved = { place: 'unstated', remote: 'remote', pay_min: '150' };
    expect(readSavedSelection(normalizeSavedSelection(saved))).toEqual(saved);
    // A stored row hands it back through rowToStoredFilterState the same way.
    expect(rowToStoredFilterState(filterStateRow({ selection: saved })).selection).toEqual(saved);
  });

  it('keeps Not listed and a floor as the two things pay_min can say besides Any', () => {
    expect(normalizeSavedSelection({ pay_min: 'not-listed' }).pay_min).toBe('not-listed');
    expect(normalizeSavedSelection({ pay_min: '175' }).pay_min).toBe('175');
  });

  it('puts the arrangements in the address\'s own order and drops a repeat', () => {
    expect(normalizeSavedSelection({ remote: 'onsite,remote,remote' }).remote).toBe('remote,onsite');
    expect(normalizeSavedSelection({ remote: 'unstated,hybrid,onsite,remote' }).remote).toBe('remote,hybrid,onsite,unstated');
  });

  it('takes the arrangements as a list as well, which is the same as repeating the field', () => {
    expect(normalizeSavedSelection({ remote: ['onsite', 'remote'] }).remote).toBe('remote,onsite');
    expect(normalizeSavedSelection({ remote: ['remote', 7, null, 'mars'] }).remote).toBe('remote');
  });

  it('reads "all" as no choice in each of the three', () => {
    expect(normalizeSavedSelection({ place: 'all', remote: 'all', pay_min: 'all' })).toEqual(NOTHING);
  });

  describe('a value the address\'s parsers refuse is no choice, never repaired and never kept', () => {
    it('place: lower case, no country, a trailing slash, a four letter region, a control character, a near miss of Not stated', () => {
      for (const place of ['gb', '-MD', 'US-', 'GB/', 'US-ABCD', 'GB/Lon\ndon', 'GB/ London', 'Unstated', 'UNSTATED', 'unstated ', 'unstated/London', 'none', 'Worldwide', '']) {
        expect(normalizeSavedSelection({ place }).place, JSON.stringify(place)).toBe('all');
      }
    });

    it('remote: an unknown kind goes and a known one beside it stays; only unknown kinds is no choice', () => {
      expect(normalizeSavedSelection({ remote: 'remote,mars' }).remote).toBe('remote');
      expect(normalizeSavedSelection({ remote: 'mars,venus' }).remote).toBe('all');
      expect(normalizeSavedSelection({ remote: '' }).remote).toBe('all');
    });

    it('pay_min: below or above the search box\'s bounds, a fraction, a sign, words', () => {
      for (const pay_min of ['0', '2001', '99999', '150.5', '-150', '+150', '1e3', 'lots', '$150k', '']) {
        expect(normalizeSavedSelection({ pay_min }).pay_min, JSON.stringify(pay_min)).toBe('all');
      }
    });

    it('anything that is not a string is not a value: numbers, booleans, objects, lists under a single-valued name', () => {
      const junk = { place: 7, remote: { remote: true }, pay_min: 150 };
      expect(normalizeSavedSelection(junk)).toEqual(NOTHING);
      expect(normalizeSavedSelection({ place: ['GB'], pay_min: ['150'] })).toEqual(NOTHING);
    });

    it('a body that is not an object at all is the strip with nothing chosen', () => {
      for (const body of [null, undefined, 'GB', 12, true, ['remote']]) {
        expect(normalizeSavedSelection(body)).toEqual(NOTHING);
      }
    });

    it('a value the strip never offers is dropped with its key: nothing but the three is ever written', () => {
      const written = normalizeSavedSelection({ place: 'GB', fam: 'engineering', q: 'nurse', company: 'Acme', titles: ['x'], sort: 'age', page: '3' });
      expect(written).toEqual({ place: 'GB', remote: 'all', pay_min: 'all' });
      expect(Object.keys(written).sort()).toEqual(['pay_min', 'place', 'remote']);
    });
  });

  it('never writes freshness, even when handed one: Freshness is no longer offered', () => {
    expect(normalizeSavedSelection({ place: 'GB', freshness: 'fresh' })).toEqual({ place: 'GB', remote: 'all', pay_min: 'all' });
  });

  it('writes the old names as the new ones, so an old record handed back in is saved in the new shape', () => {
    expect(normalizeSavedSelection({ location: 'hybrid', comp: '200-250', freshness: 'older' })).toEqual({
      place: 'all',
      remote: 'hybrid',
      pay_min: '200'
    });
  });
});

describe('readSavedSelection() and the legacy mapping: an old record means what board-query says it means', () => {
  it('an old `location` is a one-item `remote`, each of the four kinds', () => {
    for (const location of ['remote', 'hybrid', 'onsite', 'unstated']) {
      expect(readSavedSelection({ location }).remote, location).toBe(location);
    }
    expect(readSavedSelection({ location: 'all' }).remote).toBe('all');
    expect(readSavedSelection({ location: 'mars' }).remote).toBe('all');
  });

  it('an old `comp` band is its lower bound, as a floor, in thousands', () => {
    expect(readSavedSelection({ comp: '150-200' }).pay_min).toBe('150');
    expect(readSavedSelection({ comp: '200-250' }).pay_min).toBe('200');
    expect(readSavedSelection({ comp: '250-300' }).pay_min).toBe('250');
    expect(readSavedSelection({ comp: '300-plus' }).pay_min).toBe('300');
  });

  it('an old `comp` of Not listed is Not listed, and `under-150` (a ceiling a floor cannot say) is no pay filter', () => {
    expect(readSavedSelection({ comp: 'not-listed' }).pay_min).toBe('not-listed');
    expect(readSavedSelection({ comp: 'under-150' }).pay_min).toBe('all');
    expect(readSavedSelection({ comp: 'all' }).pay_min).toBe('all');
    expect(readSavedSelection({ comp: 'a-band-that-never-existed' }).pay_min).toBe('all');
  });

  it('the whole old record, as a member of the first strip left it', () => {
    expect(readSavedSelection({ location: 'onsite', comp: '250-300', freshness: 'all' })).toEqual({
      place: 'all',
      remote: 'onsite',
      pay_min: '250'
    });
    expect(readSavedSelection({ location: 'all', comp: 'all', freshness: 'all' })).toEqual(NOTHING);
  });

  it('the new names win over the old ones where both are present, as in the address', () => {
    expect(readSavedSelection({ location: 'onsite', remote: 'remote' }).remote).toBe('remote');
    // An explicit "no arrangement" is a choice too: `remote=all` is present, so the old `location` does not come back.
    expect(readSavedSelection({ location: 'onsite', remote: 'all' }).remote).toBe('all');
    expect(readSavedSelection({ comp: '150-200', pay_min: '250' }).pay_min).toBe('250');
    // ...except that "no stated pay" beats a floor, which the address says in one rule.
    expect(readSavedSelection({ comp: 'not-listed', pay_min: '250' }).pay_min).toBe('not-listed');
  });

  it('freshness is read when an old row holds one, and is not offered back as a choice when it is `all` or nonsense', () => {
    expect(readSavedSelection({ location: 'remote', freshness: 'fresh' })).toEqual({ place: 'all', remote: 'remote', pay_min: 'all', freshness: 'fresh' });
    expect(readSavedSelection({ freshness: 'older' }).freshness).toBe('older');
    expect(readSavedSelection({ freshness: 'unknown' }).freshness).toBe('unknown');
    expect('freshness' in readSavedSelection({ freshness: 'all' })).toBe(false);
    expect('freshness' in readSavedSelection({ freshness: 'yesterday' })).toBe(false);
  });

  it('agrees with parseBoardQuery on every record, because that is what it asks: no second definition', () => {
    // Each record is turned into the address it stands for BY HAND here, and the
    // expected answer is whatever the board would show for that address. A rule
    // restated in filters-store.ts would be caught the day it and board-query
    // disagreed about one of these.
    const records: { record: Record<string, string | string[]>; address: string }[] = [
      { record: { place: 'GB/London', remote: 'remote,hybrid', pay_min: '150' }, address: 'place=GB%2FLondon&remote=remote,hybrid&pay_min=150' },
      { record: { location: 'hybrid', comp: '150-200' }, address: 'location=hybrid&comp=150-200' },
      { record: { location: 'remote', remote: 'onsite' }, address: 'location=remote&remote=onsite' },
      { record: { comp: 'not-listed', pay_min: '300' }, address: 'comp=not-listed&pay_min=300' },
      { record: { pay_min: 'not-listed' }, address: 'pay_min=not-listed' },
      { record: { comp: 'under-150' }, address: 'comp=under-150' },
      { record: { place: 'unstated', remote: 'remote' }, address: 'place=unstated&remote=remote' },
      { record: { place: 'nowhere', remote: 'mars', pay_min: '0' }, address: 'place=nowhere&remote=mars&pay_min=0' },
      { record: { remote: ['onsite', 'remote'] }, address: 'remote=onsite&remote=remote' }
    ];
    for (const { record, address } of records) {
      const query = parseBoardQuery(new URLSearchParams(address));
      const expected = stripValues(query);
      const read = readSavedSelection(record);
      expect(read.place, address).toBe(expected.place);
      expect(read.pay_min, address).toBe(expected.pay_min);
      expect(read.remote, address).toBe(query.remote.length > 0 ? query.remote.join(',') : 'all');
    }
  });

  it('what is written reads back as itself: a selection is a fixed point of both', () => {
    for (const selection of [NOTHING, { place: 'GB', remote: 'remote,onsite', pay_min: '100' }, { place: 'all', remote: 'unstated', pay_min: 'not-listed' }, { place: 'unstated', remote: 'all', pay_min: 'all' }]) {
      expect(readSavedSelection(normalizeSavedSelection(selection))).toEqual(selection);
    }
  });
});

describe('saveFilterState(): nothing reaches the table unchecked, and what comes back is what the table holds', () => {
  beforeEach(() => {
    query.mockReset();
    // The real INSERT ... RETURNING * returns the row it wrote (jsonb already parsed by the driver).
    query.mockImplementation(async (_sql: string, args: unknown[]) => ({
      rows: [
        {
          user_id: args[0],
          selection: JSON.parse(args[1] as string),
          created_at: new Date('2026-10-02T00:00:00.000Z'),
          updated_at: new Date('2026-10-02T00:00:00.000Z')
        }
      ]
    }));
  });

  it('saves the new shape and reads it back', async () => {
    const stored = await saveFilterState('user_1', { place: 'US', remote: 'remote,onsite', pay_min: '100' });
    expect(stored.selection).toEqual({ place: 'US', remote: 'remote,onsite', pay_min: '100' });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(args[0]).toBe('user_1');
    expect(JSON.parse(args[1])).toEqual({ place: 'US', remote: 'remote,onsite', pay_min: '100' });
  });

  it('writes only what the parsers accept: an invalid value is "all" in the row, an unknown key is not in it', async () => {
    const stored = await saveFilterState('user_1', { place: 'gb', remote: 'mars', pay_min: '99999', fam: 'engineering', freshness: 'fresh' });
    expect(JSON.parse(query.mock.calls[0][1][1])).toEqual(NOTHING);
    expect(stored.selection).toEqual(NOTHING);
  });

  it('writes an old record in the new shape, so the next read has no old names left to map', async () => {
    const stored = await saveFilterState('user_1', { location: 'hybrid', comp: '200-250', freshness: 'older' });
    expect(JSON.parse(query.mock.calls[0][1][1])).toEqual({ place: 'all', remote: 'hybrid', pay_min: '200' });
    expect(stored.selection).toEqual({ place: 'all', remote: 'hybrid', pay_min: '200' });
  });

  it('puts the person in the first placeholder and the selection in the second, never in the SQL text', async () => {
    await saveFilterState("u'; DROP TABLE account_filter_state; --", { place: "GB/x'); DROP TABLE y; --" });
    const [sql, args] = query.mock.calls[0];
    expect(sql).not.toContain('DROP');
    expect(args[0]).toBe("u'; DROP TABLE account_filter_state; --");
  });
});
