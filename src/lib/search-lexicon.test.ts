/**
 * search-lexicon.test.ts: the vocabulary behind the search box.
 *
 * TWO HALVES. The first builds a lexicon from a hand-written board of a few
 * dozen rows and needs no database, so it always runs: every rule in the header
 * of search-lexicon.ts (which place wins a shared name, why a country code is
 * case sensitive, what a key means, how a title term is counted) has a case
 * here with the numbers written out. The second reads the local board and
 * checks the same rules against real data, with counts asserted as bounds so
 * the nightly crawl does not break them. Without a connection string the second
 * half skips rather than passing, so a green run on a machine with no database
 * cannot be mistaken for a proof.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  buildLexicon, forgetLexicon, getLexicon, loadLexiconRows,
  SUGGEST_MAX, type BoardLexicon, type LexiconRows, type PlaceRow
} from './search-lexicon';
import { chipsFromParams, chipsToParams, LEXICON_MAX_WORDS, normalisePhrase, parseSearch, type Chip } from './search-parse';
import { db } from './db';

const HAVE_DB = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED);
const dbDescribe = HAVE_DB ? describe : describe.skip;

// ---------------------------------------------------------------------------
// A small board, written out
// ---------------------------------------------------------------------------

function place(country: string, admin1: string | null, city: string | null, label: string | null, rows: number): PlaceRow {
  return { country, admin1, city, label, rows };
}

/**
 * Every shape the real board has, at a size where the arithmetic can be read:
 *   London      GB 676 | CA-ON 6 | CA (no admin) 5 | US-OH 2 | US-KY 1 | US (no admin) 2
 *   New York    US-NY 848 inside a state of 848 + 24 + 400 = 1,272 rows
 *   Washington  the state (WA, 1,000) and a city in another admin area (DC, 496)
 *   Indiana     the state (IN, 250) and a one-row town in PA
 *   Mexico      the country (151) and a one-row town in MO
 *   Richmond    two spellings of one place (BC)
 */
const BOARD_PLACES: PlaceRow[] = [
  place('GB', null, 'London', 'London, United Kingdom', 676),
  place('GB', null, 'Manchester', 'Manchester, United Kingdom', 5),
  place('GB', null, 'manchester', 'manchester, United Kingdom', 1),
  place('GB', null, null, 'United Kingdom', 562),
  place('CA', 'ON', 'London', 'London, ON', 6),
  place('CA', null, 'London', 'London, Canada', 5),
  place('CA', 'ON', 'Toronto', 'Toronto, ON', 100),
  place('CA', 'BC', 'Richmond', 'Richmond, BC', 4),
  place('CA', 'BC', 'RIchmond', 'RIchmond, BC', 1),
  place('US', 'OH', 'London', 'London, OH', 2),
  place('US', 'KY', 'London', 'London, KY', 1),
  place('US', null, 'London', 'London, United States', 2),
  place('US', 'NY', 'New York', 'New York, NY', 848),
  place('US', 'NJ', 'New York', 'New York, NJ', 1),
  place('US', 'NY', 'Buffalo', 'Buffalo, NY', 24),
  place('US', 'NY', null, 'United States', 400),
  place('US', 'WA', 'Seattle', 'Seattle, WA', 600),
  place('US', 'WA', null, 'United States', 400),
  place('US', 'DC', 'Washington', 'Washington, DC', 496),
  place('US', 'IN', 'Indianapolis', 'Indianapolis, IN', 100),
  place('US', 'IN', null, 'United States', 150),
  place('US', 'PA', 'Indiana', 'Indiana, PA', 1),
  place('US', 'MO', 'Mexico', 'Mexico, MO', 1),
  place('US', 'MD', 'Baltimore', 'Baltimore, MD', 32),
  place('US', 'MD', null, 'United States', 416),
  place('US', 'AZ', 'Phoenix', 'Phoenix, AZ', 59),
  place('US', 'AL', 'Mobile', 'Mobile, AL', 41),
  place('US', 'VA', 'Springfield', 'Springfield, VA', 38),
  place('US', 'IL', 'Springfield', 'Springfield, IL', 31),
  place('US', 'IL', 'Harvey', 'Harvey, IL', 2),
  place('US', 'TN', 'Paris', 'Paris, TN', 1),
  place('US', null, null, 'United States', 9000),
  place('MX', null, null, 'Mexico', 151),
  place('DE', null, 'Berlin', 'Berlin, Germany', 420),
  place('DE', null, null, 'Germany', 1072),
  place('FR', null, 'Paris', 'Paris, France', 342),
  place('AU', 'NSW', 'Sydney', 'Sydney, NSW', 40),
  place('AU', 'WA', 'Perth', 'Perth, WA', 1),
  place('IN', null, null, 'India', 689),
  place('GU', null, null, 'Guam', 21)
];

const BOARD: LexiconRows = {
  places: BOARD_PLACES,
  companies: [
    { company: 'Figma', rows: 163 },
    { company: 'Remote', rows: 154 },
    { company: 'ABF', rows: 10 },
    { company: 'Abf', rows: 3 },
    { company: 'Anysphere (Cursor)', rows: 126 },
    { company: 'Café Nero', rows: 5 },
    { company: 'Coach', rows: 1 },
    { company: 'Amazon', rows: 2846 },
    { company: 'Phoenix Labs', rows: 12 },
    { company: 'Harvey', rows: 304 },
    { company: 'Berlin', rows: 3 }
  ],
  titles: [
    { title: 'Senior Designer', rows: 100 },
    { title: 'Product Designer, New York', rows: 20 },
    { title: 'New York-based Designer', rows: 3 },
    { title: 'York New Hire Coordinator', rows: 50 },
    { title: 'Account Executive - Yorkshire', rows: 7 },
    { title: 'Mobile Engineer', rows: 154 },
    { title: 'Head Coach', rows: 32 },
    { title: 'Engineer (London)', rows: 90 },
    { title: "Manager - O'Fallon, MO", rows: 4 },
    { title: 'Designer', rows: 10 },
    { title: 'designer', rows: 5 }
  ]
};

let fixture: BoardLexicon;
beforeAll(() => {
  fixture = buildLexicon(BOARD, '2026-09-26T07:33:10.000Z');
});

describe('place: countries', () => {
  it('resolves an English name and every alias, from normalised text', () => {
    expect(fixture.place('united kingdom')).toEqual({ key: 'GB', label: 'United Kingdom' });
    expect(fixture.place('uk')?.key).toBe('GB');
    expect(fixture.place('england')?.key).toBe('GB');
    expect(fixture.place('great britain')?.key).toBe('GB');
    expect(fixture.place('deutschland')).toEqual({ key: 'DE', label: 'Germany' });
    expect(fixture.place('united states')?.key).toBe('US');
    expect(fixture.place('usa')?.key).toBe('US');
    expect(fixture.place('u.s.a')?.key).toBe('US'); // "U.S.A." arrives with its edge dot trimmed
    expect(fixture.place('mexico')).toEqual({ key: 'MX', label: 'Mexico' });
  });

  it('does not take a bare two-letter code as a phrase: us, in, de and gb are words', () => {
    for (const word of ['us', 'in', 'de', 'gb', 'md', 'on', 'ca', 'wa', 'ny']) {
      expect(fixture.place(word), word).toBeNull();
    }
  });

  it('accepts the canonical country key only in the case chipsToParams writes it', () => {
    // The parser lowercases every token it types, so a lower case code is always
    // a word; chipsFromParams tries the raw value second, which is where `GB` lands.
    expect(fixture.place('GB')).toEqual({ key: 'GB', label: 'United Kingdom' });
    expect(fixture.place('IN')?.key).toBe('IN');
    expect(fixture.place('gb')).toBeNull();
    expect(fixture.place('in')).toBeNull();
  });

  it('only knows countries the board carries', () => {
    expect(fixture.place('japan')).toBeNull();
    expect(fixture.place('guam')?.key).toBe('GU');
  });

  it('a country always wins its own name over a town that shares it', () => {
    expect(fixture.place('mexico')?.key).toBe('MX'); // not Mexico, MO
  });

  it('refuses the two names jobs-derived reads as a US place, not a country', () => {
    const lex = buildLexicon({ places: [place('GE', null, null, 'Georgia', 3), place('US', 'GA', null, 'United States', 500)], companies: [], titles: [] });
    expect(lex.place('georgia')?.key).toBe('US-GA');
    expect(lex.placesByPrefix('geor', 5).map((p) => p.key).sort()).toEqual(['GE', 'US-GA']);
  });
});

describe('place: admin areas', () => {
  it('resolves a full name and never a code', () => {
    expect(fixture.place('maryland')).toEqual({ key: 'US-MD', label: 'Maryland' });
    expect(fixture.place('new south wales')).toEqual({ key: 'AU-NSW', label: 'New South Wales' });
    expect(fixture.place('md')).toBeNull();
    expect(fixture.place('nsw')).toBeNull();
  });

  it('keeps Washington (the state) and Western Australia apart from each other', () => {
    expect(fixture.place('washington')).toEqual({ key: 'US-WA', label: 'Washington' }); // 1,000 rows beats Washington, DC at 496
    expect(fixture.place('western australia')).toEqual({ key: 'AU-WA', label: 'Western Australia' });
    expect(fixture.place('au-wa')?.key).toBe('AU-WA');
  });

  it('a town named for a state does not take the state name (Indiana, PA)', () => {
    expect(fixture.place('indiana')?.key).toBe('US-IN'); // 250 rows against one
  });
});

describe('place: cities', () => {
  it('a bare name shared by several cities is the one with the most rows of its own', () => {
    expect(fixture.place('london')).toEqual({ key: 'GB/London', label: 'London, United Kingdom' });
    expect(fixture.place('springfield')?.key).toBe('US-VA/Springfield'); // 38 against 31
    expect(fixture.place('paris')?.key).toBe('FR/Paris'); // 342 against Paris, TN
  });

  it('qualified by admin code, admin name, country name or country alias, it is exact', () => {
    expect(fixture.place('london ky')?.key).toBe('US-KY/London');
    expect(fixture.place('london oh')?.key).toBe('US-OH/London');
    expect(fixture.place('london ontario')?.key).toBe('CA-ON/London');
    expect(fixture.place('london on')?.key).toBe('CA-ON/London');
    expect(fixture.place('london united kingdom')?.key).toBe('GB/London');
    expect(fixture.place('london uk')?.key).toBe('GB/London');
    expect(fixture.place('london england')?.key).toBe('GB/London');
    expect(fixture.place('berlin germany')?.key).toBe('DE/Berlin');
    expect(fixture.place('berlin deutschland')?.key).toBe('DE/Berlin');
    expect(fixture.place('berlin de')?.key).toBe('DE/Berlin'); // a country code is fine after a city
  });

  it('city + admin + country resolves, in code or in name', () => {
    expect(fixture.place('baltimore md usa')?.key).toBe('US-MD/Baltimore');
    expect(fixture.place('baltimore maryland united states')?.key).toBe('US-MD/Baltimore');
    expect(fixture.place('baltimore md us')?.key).toBe('US-MD/Baltimore');
    expect(fixture.place('sydney nsw australia')?.key).toBe('AU-NSW/Sydney');
    expect(fixture.place('sydney new south wales australia')).toBeNull(); // five words: the parser never asks past four
  });

  it('a qualifier the board does not carry for that city does not resolve it', () => {
    expect(fixture.place('london france')).toBeNull();
    expect(fixture.place('baltimore tx')).toBeNull();
    expect(fixture.place('phoenix united kingdom')).toBeNull();
  });

  it('a key with no admin area answers for the city in every admin area of the country', () => {
    // London, Canada: 5 rows with no province plus 6 in Ontario.
    expect(fixture.place('london canada')).toEqual({ key: 'CA/London', label: 'London, Canada' });
    expect(fixture.placesByPrefix('london', 20).find((p) => p.key === 'CA/London')?.rows).toBe(11);
    expect(fixture.placesByPrefix('london', 20).find((p) => p.key === 'CA-ON/London')?.rows).toBe(6);
    // ...but the BARE name weighs the key's own 5, so it cannot outbid its own province.
    expect(fixture.place('london')?.key).toBe('GB/London');
  });

  it('a city that bears its state\'s name takes the name when it holds more than the rest of the state', () => {
    expect(fixture.place('new york')).toEqual({ key: 'US-NY/New York', label: 'New York, NY' }); // 848 of 1,272
    expect(fixture.place('new york new york')?.key).toBe('US-NY/New York');
  });

  it('nicknames the place table folds resolve to the same city, bare and qualified', () => {
    expect(fixture.place('nyc')?.key).toBe('US-NY/New York');
    expect(fixture.place('new york city')?.key).toBe('US-NY/New York');
    expect(fixture.place('nyc ny')?.key).toBe('US-NY/New York');
  });

  it('keeps accents and case out of the match', () => {
    const lex = buildLexicon({ places: [place('DE', null, 'München', 'München, Germany', 80)], companies: [], titles: [] });
    expect(lex.place('munchen')?.key).toBe('DE/München');
    expect(lex.place(normalisePhrase('MÜNCHEN'))?.key).toBe('DE/München');
  });

  it('two spellings of one name go to the spelling with more rows', () => {
    expect(fixture.place('richmond bc')?.key).toBe('CA-BC/Richmond');
    expect(fixture.place('manchester')?.key).toBe('GB/Manchester');
  });

  it('keeps a key exact: the minority spelling has its own, found by the raw address value', () => {
    // chipsFromParams asks with the normalised value first and the raw one
    // second. The normalised key `ca-bc/richmond` is ambiguous between two
    // spellings, so it is not registered; the raw ones are, each exactly.
    expect(fixture.place('CA-BC/Richmond')?.key).toBe('CA-BC/Richmond');
    expect(fixture.place('CA-BC/RIchmond')?.key).toBe('CA-BC/RIchmond');
    expect(fixture.place('ca-bc/richmond')).toBeNull();
    for (const key of ['CA-BC/Richmond', 'CA-BC/RIchmond']) {
      expect(chipsFromParams(new URLSearchParams({ place: key }), fixture)).toEqual([
        { kind: 'place', key, label: key === 'CA-BC/Richmond' ? 'Richmond, BC' : 'RIchmond, BC' }
      ]);
    }
  });
});

describe('place: canonical keys', () => {
  it('resolve once normalised, because chipsFromParams asks with the address value', () => {
    expect(fixture.place(normalisePhrase('US-MD'))).toEqual({ key: 'US-MD', label: 'Maryland' });
    expect(fixture.place(normalisePhrase('GB/London'))).toEqual({ key: 'GB/London', label: 'London, United Kingdom' });
    expect(fixture.place(normalisePhrase('US-MD/Baltimore'))).toEqual({ key: 'US-MD/Baltimore', label: 'Baltimore, MD' });
    expect(fixture.place(normalisePhrase('US-NY/New York'))?.key).toBe('US-NY/New York');
    expect(fixture.place(normalisePhrase('US/London'))?.key).toBe('US/London');
  });

  it('round-trip through the parser\'s own chip functions', () => {
    for (const key of ['GB', 'US-MD', 'GB/London', 'US-MD/Baltimore', 'US-NY/New York', 'CA/London', 'DE/Berlin']) {
      const hit = fixture.place(key) ?? fixture.place(normalisePhrase(key));
      expect(hit, key).not.toBeNull();
      const chips: Chip[] = [{ kind: 'place', key: hit?.key ?? '', label: hit?.label ?? '' }];
      expect(chipsFromParams(new URLSearchParams(chipsToParams(chips)), fixture), key).toEqual(chips);
    }
  });

  it('an unknown place is null', () => {
    for (const phrase of ['atlantis', 'zz-zz', 'xx/nowhere', 'london zzz', '']) expect(fixture.place(phrase), phrase).toBeNull();
  });
});

describe('company', () => {
  it('resolves case and accents to the exact stored string', () => {
    expect(fixture.company('figma')).toBe('Figma');
    expect(fixture.company(normalisePhrase('FIGMA'))).toBe('Figma');
    expect(fixture.company(normalisePhrase('Cafe Nero'))).toBe('Café Nero');
    expect(fixture.company(normalisePhrase('café nero'))).toBe('Café Nero');
  });

  it('resolves the canonical stored string itself, punctuation and all', () => {
    expect(fixture.company(normalisePhrase('Anysphere (Cursor)'))).toBe('Anysphere (Cursor)');
    expect(chipsFromParams(new URLSearchParams({ company: 'Anysphere (Cursor)' }), fixture)).toEqual([{ kind: 'company', name: 'Anysphere (Cursor)' }]);
  });

  it('two spellings of one name go to the one with more rows', () => {
    expect(fixture.company('abf')).toBe('ABF');
  });

  it('is null for a company the board does not carry', () => {
    expect(fixture.company('oracle')).toBeNull();
    expect(fixture.company('')).toBeNull();
  });
});

describe('a name that is both a place and a company', () => {
  it('goes to the larger use, so a big company is not shadowed by a small town', () => {
    expect(fixture.company('harvey')).toBe('Harvey');
    expect(fixture.place('harvey')).toBeNull(); // Harvey, IL is 2 rows against 304
    expect(fixture.place('harvey il')?.key).toBe('US-IL/Harvey'); // the qualified town is still reachable
    expect(parseSearch('harvey designer', fixture).chips).toEqual([{ kind: 'company', name: 'Harvey' }]);
  });

  it('a place that is the larger use keeps its name', () => {
    expect(fixture.place('berlin')?.key).toBe('DE/Berlin'); // 420 rows against a company of 3
    expect(parseSearch('engineer berlin', fixture).chips).toEqual([{ kind: 'place', key: 'DE/Berlin', label: 'Berlin, Germany' }]);
  });

  it('is what isTitleTerm is asked about: the company, with the company\'s rows', () => {
    expect(fixture.explainTitleTerm('harvey')).toMatchObject({ kind: 'company', resolved: 'Harvey', nameRows: 304 });
  });

  it('does not touch a canonical key', () => {
    expect(fixture.place('US-IL/Harvey')?.key).toBe('US-IL/Harvey');
  });
});

describe('isTitleTerm', () => {
  it('is false for a place used as a place: the titles that hold it are fewer than the rows at it', () => {
    const london = fixture.explainTitleTerm('london');
    expect(london).toMatchObject({ kind: 'place', resolved: 'GB/London', nameRows: 676, titleRows: 90, isTitleTerm: false });
    expect(fixture.isTitleTerm('phoenix')).toBe(false); // 59 rows at it, no title holds it
  });

  it('is true when the titles hold the phrase at least as often as the rows are at the place', () => {
    expect(fixture.explainTitleTerm('mobile')).toMatchObject({ kind: 'place', nameRows: 41, titleRows: 154, isTitleTerm: true });
  });

  it('counts rows, not distinct titles: two spellings of one title weigh their rows together', () => {
    expect(fixture.explainTitleTerm('designer').titleRows).toBe(100 + 20 + 3 + 10 + 5);
  });

  it('asks about the whole phrase and checks that its words are adjacent and in order', () => {
    // "Product Designer, New York" (20) and "New York-based Designer" (3) hold it;
    // "York New Hire Coordinator" (50) has both words in the wrong order.
    expect(fixture.explainTitleTerm('new york')).toMatchObject({ kind: 'place', nameRows: 848, titleRows: 23, isTitleTerm: false });
  });

  it('matches whole words only: york is not yorkshire', () => {
    expect(fixture.explainTitleTerm('york').titleRows).toBe(20 + 3 + 50);
    expect(fixture.explainTitleTerm('yorkshire').titleRows).toBe(7);
  });

  it('splits a title and a phrase on the same characters', () => {
    expect(fixture.explainTitleTerm("o'fallon").titleRows).toBe(4);
    expect(fixture.explainTitleTerm('london').titleRows).toBe(90); // "Engineer (London)"
  });

  it('is judged against a company\'s rows when the phrase names a company', () => {
    expect(fixture.explainTitleTerm('coach')).toMatchObject({ kind: 'company', resolved: 'Coach', nameRows: 1, titleRows: 32, isTitleTerm: true });
    expect(fixture.explainTitleTerm('amazon')).toMatchObject({ kind: 'company', nameRows: 2846, titleRows: 0, isTitleTerm: false });
  });

  it('asks place first, the way the parser does, when a name is both', () => {
    expect(fixture.explainTitleTerm('phoenix')).toMatchObject({ kind: 'place', resolved: 'US-AZ/Phoenix' });
  });

  it('a phrase that names neither a place nor a company is plain text', () => {
    expect(fixture.isTitleTerm('designer')).toBe(true);
    expect(fixture.isTitleTerm('nonexistent phrase')).toBe(true);
    expect(fixture.explainTitleTerm('nonexistent phrase')).toMatchObject({ kind: null, resolved: null, nameRows: 0, titleRows: 0 });
  });

  it('is stable when asked twice (memoised) and survives a flood of distinct phrases', () => {
    const first = fixture.explainTitleTerm('london');
    for (let i = 0; i < 25_000; i += 1) fixture.isTitleTerm(`phrase ${i}`);
    expect(fixture.explainTitleTerm('london')).toEqual(first);
  });
});

describe('placesByPrefix and companiesByPrefix', () => {
  it('lists names that start with the prefix before names that merely hold a word that does, then by rows', () => {
    const york = fixture.placesByPrefix('york', 10).map((p) => p.key);
    expect(york).toContain('US-NY/New York');
    const lon = fixture.placesByPrefix('lon', 10);
    expect(lon[0]).toMatchObject({ key: 'GB/London', label: 'London, United Kingdom', rows: 676, kind: 'city' });
    const newP = fixture.placesByPrefix('new', 10);
    expect(newP[0]?.key).toBe('US-NY'); // the state (1,272) outweighs the city (848); both start with "new"
    expect(newP.map((p) => p.key)).toEqual(expect.arrayContaining(['US-NY/New York', 'AU-NSW']));
  });

  it('lists a country by any alias, and an admin area by its name', () => {
    expect(fixture.placesByPrefix('deut', 5)[0]).toMatchObject({ key: 'DE', kind: 'country' });
    expect(fixture.placesByPrefix('mary', 5)[0]).toMatchObject({ key: 'US-MD', label: 'Maryland', kind: 'admin' });
    expect(fixture.placesByPrefix('nyc', 5)[0]?.key).toBe('US-NY/New York');
  });

  it('matches across a comma and a qualifier, the way the label is written', () => {
    expect(fixture.placesByPrefix('london, o', 10).map((p) => p.key)).toEqual(expect.arrayContaining(['CA-ON/London', 'US-OH/London']));
    expect(fixture.placesByPrefix('London, United K', 5)[0]?.key).toBe('GB/London');
  });

  it('shows one entry per label, so two spellings of a city list once', () => {
    const rich = fixture.placesByPrefix('rich', 10).filter((p) => p.kind === 'city');
    expect(rich.map((p) => p.key)).toEqual(['CA-BC/Richmond']);
  });

  it('honours the limit, caps it, and lists nothing for an empty prefix', () => {
    expect(fixture.placesByPrefix('l', 2)).toHaveLength(2);
    expect(fixture.placesByPrefix('', 5)).toEqual([]);
    expect(fixture.placesByPrefix('   ', 5)).toEqual([]);
    expect(fixture.placesByPrefix('lon', 0)).toEqual([]);
    expect(fixture.placesByPrefix('lon', -3)).toEqual([]);
    expect(fixture.placesByPrefix('lon', Number.NaN)).toEqual([]);
    expect(fixture.placesByPrefix('a', 10_000).length).toBeLessThanOrEqual(SUGGEST_MAX);
  });

  it('companies: start-of-name first, then a later word, then rows', () => {
    expect(fixture.companiesByPrefix('fig', 5)).toEqual([{ name: 'Figma', label: 'Figma', rows: 163 }]);
    expect(fixture.companiesByPrefix('cur', 5)[0]?.name).toBe('Anysphere (Cursor)'); // "(Cursor)" arrives as `cursor`, a later word
    // Names that start with it, by rows (5, then 1), then the one that holds a later word.
    expect(fixture.companiesByPrefix('c', 5).map((c) => c.name)).toEqual(['Café Nero', 'Coach', 'Anysphere (Cursor)']);
    expect(fixture.companiesByPrefix('', 5)).toEqual([]);
    expect(fixture.companiesByPrefix('abf', 5)).toEqual([{ name: 'ABF', label: 'ABF', rows: 10 }]);
  });
});

describe('sizes', () => {
  it('reports what it holds', () => {
    expect(fixture.boardRowsAt).toBe('2026-09-26T07:33:10.000Z');
    expect(fixture.stats).toMatchObject({ countries: 9, adminAreas: 19, companies: 10, titles: 11 });
    expect(fixture.stats.cities).toBeGreaterThan(20);
    expect(fixture.stats.titleWords).toBeGreaterThan(10);
  });

  it('a lexicon built from nothing answers nothing and does not throw', () => {
    const empty = buildLexicon({ places: [], companies: [], titles: [] });
    expect(empty.place('london')).toBeNull();
    expect(empty.company('figma')).toBeNull();
    expect(empty.isTitleTerm('london')).toBe(true);
    expect(empty.placesByPrefix('lon', 5)).toEqual([]);
    expect(empty.stats).toMatchObject({ countries: 0, cities: 0, companies: 0, titles: 0 });
  });
});

// ---------------------------------------------------------------------------
// The local board
// ---------------------------------------------------------------------------

/** The chips of a parse as short strings, so a table row is readable. */
function short(chips: readonly Chip[]): string[] {
  return chips.map((c) => {
    switch (c.kind) {
      case 'place': return `place:${c.key}`;
      case 'company': return `company:${c.name}`;
      case 'remote': return `remote:${c.value}`;
      case 'pay': return `pay:${c.minK}`;
      case 'age': return `age:${c.maxDays}`;
    }
  });
}

dbDescribe('the lexicon on the local board', () => {
  let lex: BoardLexicon;
  let rows: LexiconRows;

  beforeAll(async () => {
    forgetLexicon();
    lex = await getLexicon();
    rows = await loadLexiconRows();
  }, 60_000);

  describe('place', () => {
    it('"london" is the London with the most live rows, checked against the table itself', async () => {
      const { rows: top } = await db().query<{ c: string; a: string | null; n: number }>(
        `SELECT place_country AS c, place_admin1 AS a, count(*)::int AS n FROM jobs
          WHERE status = 'live' AND place_country IS NOT NULL AND lower(place_city) = 'london'
          GROUP BY 1, 2 ORDER BY n DESC, c, a NULLS FIRST`
      );
      expect(top.length).toBeGreaterThan(1); // the point of the test: more than one London
      const first = top[0];
      const expected = first?.a ? `${first.c}-${first.a}/London` : `${first?.c}/London`;
      expect(lex.place('london')?.key).toBe(expected);
      expect(expected).toBe('GB/London');
    });

    it('qualified Londons resolve exactly: admin code, admin name, country name, country alias', () => {
      expect(lex.place('london ky')?.key).toBe('US-KY/London');
      expect(lex.place('london ontario')?.key).toBe('CA-ON/London');
      expect(lex.place('london on')?.key).toBe('CA-ON/London');
      expect(lex.place('london united kingdom')?.key).toBe('GB/London');
      expect(lex.place('london uk')?.key).toBe('GB/London');
      expect(lex.place('london england')?.key).toBe('GB/London');
    });

    it('countries by name and alias', () => {
      expect(lex.place('united kingdom')).toEqual({ key: 'GB', label: 'United Kingdom' });
      expect(lex.place('uk')?.key).toBe('GB');
      expect(lex.place('deutschland')).toEqual({ key: 'DE', label: 'Germany' });
      expect(lex.place('germany')?.key).toBe('DE');
      expect(lex.place('united states')?.key).toBe('US');
      expect(lex.place('usa')?.key).toBe('US');
    });

    it('admin areas by full name; bare codes are words', () => {
      expect(lex.place('maryland')).toEqual({ key: 'US-MD', label: 'Maryland' });
      expect(lex.place('ontario')?.key).toBe('CA-ON');
      expect(lex.place('md')).toBeNull();
      for (const word of ['us', 'in', 'de', 'gb', 'on', 'ca', 'wa', 'ny', 'tx']) expect(lex.place(word), word).toBeNull();
    });

    it('canonical keys resolve, normalised, and the country code in the case the address carries', () => {
      expect(lex.place('us-md')?.key).toBe('US-MD');
      expect(lex.place('gb/london')?.key).toBe('GB/London');
      expect(lex.place('us-md/baltimore')?.key).toBe('US-MD/Baltimore');
      expect(lex.place('GB')?.key).toBe('GB');
      expect(lex.place('gb')).toBeNull(); // a word when typed; see the header
    });

    it('an unknown place is null', () => {
      expect(lex.place('atlantis')).toBeNull();
      expect(lex.place('london zzz')).toBeNull();
      expect(lex.place('zz/nowhere')).toBeNull();
    });

    it('every place the board carries comes back from its own address value, exactly', () => {
      const wrong: string[] = [];
      for (const r of rows.places) {
        if (r.city === null) continue;
        const key = r.admin1 ? `${r.country}-${r.admin1}/${r.city}` : `${r.country}/${r.city}`;
        // The way the address is read back: normalised value, then the raw one.
        const hit = chipsFromParams(new URLSearchParams({ place: key }), lex)[0];
        const got = hit?.kind === 'place' ? hit.key : null;
        if (got !== key) wrong.push(`${key} -> ${got ?? 'null'}`);
      }
      expect(wrong).toEqual([]);
    });

    it('every place the board carries answers to its own printed label that the parser can ask about, or to a spelling of the same place', () => {
      const unresolved: string[] = [];
      const longer: string[] = [];
      const other: string[] = [];
      for (const r of rows.places) {
        if (r.city === null || r.label === null) continue;
        const phrase = normalisePhrase(r.label);
        const hit = lex.place(phrase);
        if (hit === null) {
          // Past four words the parser never asks (LEXICON_MAX_WORDS), so
          // "Naval Air Station Pensacola, FL" is a label no typed text reaches.
          (phrase.split(' ').length > LEXICON_MAX_WORDS ? longer : unresolved).push(r.label);
          continue;
        }
        // The same place: the same country (and admin area) and the same city
        // once case and accents are folded. A city printed in two spellings
        // ("Mclean, VA" and "McLean, VA") goes to the larger.
        const wanted = r.admin1 ? `${r.country}-${r.admin1}/` : `${r.country}/`;
        const sameScope = hit.key.toLowerCase().startsWith(wanted.toLowerCase()) || (!r.admin1 && hit.key.startsWith(`${r.country}-`));
        const sameCity = normalisePhrase(hit.key.slice(hit.key.indexOf('/') + 1)) === normalisePhrase(r.city);
        if (!(sameScope && sameCity)) other.push(`${r.label} -> ${hit.key}`);
      }
      expect(unresolved, 'a label of four words or fewer that resolves to nothing').toEqual([]);
      // What is left is a label whose last word is a two-letter code that is
      // BOTH an admin code and a country code: "Richmond, CA" (California) is
      // also Richmond in Canada, "Buenos Aires, AR" is Argentina and Arkansas.
      // The larger place takes it. Three of them today; the budget is a fixed 1%.
      expect(other.length, other.join(' | ')).toBeLessThanOrEqual(Math.ceil(rows.places.length * 0.01));
      expect(longer.length).toBeLessThan(rows.places.length * 0.02);
    });

    it('reports a count for what it holds, and the counts are the board\'s own', async () => {
      const { rows: c } = await db().query<{ countries: number; admins: number }>(
        `SELECT count(DISTINCT place_country)::int AS countries,
                count(DISTINCT (place_country, place_admin1)) FILTER (WHERE place_admin1 IS NOT NULL)::int AS admins
           FROM jobs WHERE status = 'live' AND place_country IS NOT NULL`
      );
      expect(lex.stats.countries).toBe(c[0]?.countries);
      expect(lex.stats.adminAreas).toBe(c[0]?.admins);
    });
  });

  describe('company', () => {
    it('a real company resolves, case and accents ignored', async () => {
      const { rows: top } = await db().query<{ company: string }>(
        `SELECT company FROM jobs WHERE status = 'live' GROUP BY company ORDER BY count(*) DESC LIMIT 1`
      );
      const name = top[0]?.company ?? '';
      expect(lex.company(normalisePhrase(name))).toBe(name);
      expect(lex.company(normalisePhrase(name.toUpperCase()))).toBe(name);
      expect(lex.company('figma')).toBe('Figma');
      expect(lex.company(normalisePhrase('FIGMA'))).toBe('Figma');
    });

    it('every stored company resolves, and the stored string round-trips through the address', () => {
      const lost: string[] = [];
      for (const c of rows.companies) {
        const hit = lex.company(normalisePhrase(c.company));
        if (hit === null) lost.push(c.company);
        else if (normalisePhrase(hit) !== normalisePhrase(c.company)) lost.push(`${c.company} -> ${hit}`);
      }
      expect(lost).toEqual([]);
      const chips = chipsFromParams(new URLSearchParams({ company: 'Figma' }), lex);
      expect(chips).toEqual([{ kind: 'company', name: 'Figma' }]);
    });

    it('a company is not shadowed by a smaller place of the same name (Harvey, IL has 2 rows, Harvey has hundreds)', () => {
      expect(lex.company('harvey')).toBe('Harvey');
      expect(lex.place('harvey')).toBeNull();
      expect(lex.place('harvey il')?.key).toBe('US-IL/Harvey');
    });

    it('no company the board carries is unreachable because a place of the same name has more rows', () => {
      const shadowed: string[] = [];
      for (const c of rows.companies) {
        const phrase = normalisePhrase(c.company);
        if (lex.company(phrase) !== c.company) continue; // another spelling of the name is the one that resolves
        const place = lex.explainTitleTerm(phrase);
        if (place.kind === 'place' && place.nameRows >= c.rows) continue; // the place is the larger use: by design
        if (lex.place(phrase) !== null && place.kind !== 'place') shadowed.push(c.company);
      }
      expect(shadowed).toEqual([]);
    });

    it('a company the board does not carry is null', () => {
      expect(lex.company('zzz not a company')).toBeNull();
    });
  });

  describe('isTitleTerm, with the counts behind each verdict', () => {
    /** Places used as places: far fewer titles hold the phrase than rows are at it. */
    it.each([
      ['phoenix', 50, 10],
      ['london', 500, 200],
      ['new york', 500, 100],
      ['paris', 200, 100],
      ['california', 2000, 100]
    ])('%s is a place, not a title term', (phrase, minRows, maxTitles) => {
      const r = lex.explainTitleTerm(phrase);
      expect(r.kind).toBe('place');
      expect(r.nameRows).toBeGreaterThanOrEqual(minRows);
      expect(r.titleRows).toBeLessThanOrEqual(maxTitles);
      expect(r.isTitleTerm).toBe(false);
    });

    it.each([
      ['mercury', 40, 10],
      ['amazon', 2000, 1000],
      ['figma', 100, 20]
    ])('%s is a company, not a title term', (phrase, minRows, maxTitles) => {
      const r = lex.explainTitleTerm(phrase);
      expect(r.kind).toBe('company');
      expect(r.nameRows).toBeGreaterThanOrEqual(minRows);
      expect(r.titleRows).toBeLessThanOrEqual(maxTitles);
      expect(r.isTitleTerm).toBe(false);
    });

    /** Names the titles use more than the board uses them as names. */
    it.each([
      ['mobile', 'place'],
      ['media', 'place'],
      ['york', 'place']
    ])('%s is a title term: the %s of that name carries fewer rows than titles hold the word', (phrase, kind) => {
      const r = lex.explainTitleTerm(phrase);
      expect(r.kind).toBe(kind);
      expect(r.titleRows).toBeGreaterThanOrEqual(r.nameRows);
      expect(r.isTitleTerm).toBe(true);
    });

    it('"remote" is a company on this board; the parser never asks, because remote is syntax first', () => {
      const r = lex.explainTitleTerm('remote');
      // A company of that name exists and is close to its own title count; what
      // is pinned is that the verdict is the comparison, whichever way it falls.
      expect(r.kind).toBe('company');
      expect(r.isTitleTerm).toBe(r.titleRows >= r.nameRows);
      expect(r.titleRows).toBeGreaterThan(50);
    });

    it('oracle and apple are not names on this board, so there is nothing for a title to outweigh', () => {
      for (const phrase of ['oracle', 'apple']) {
        const r = lex.explainTitleTerm(phrase);
        if (r.kind === null) expect(r.isTitleTerm).toBe(true);
        else expect(r.isTitleTerm).toBe(r.titleRows >= r.nameRows);
      }
    });

    it('is exactly the comparison it says it is, for every place and company the board carries', () => {
      const broken: string[] = [];
      for (const r of rows.places) {
        if (r.city === null) continue;
        const phrase = normalisePhrase(r.city);
        const e = lex.explainTitleTerm(phrase);
        if (e.kind === 'place' && e.isTitleTerm !== e.titleRows >= e.nameRows) broken.push(phrase);
      }
      for (const c of rows.companies.slice(0, 400)) {
        const phrase = normalisePhrase(c.company);
        const e = lex.explainTitleTerm(phrase);
        if (e.kind !== null && e.isTitleTerm !== e.titleRows >= e.nameRows) broken.push(phrase);
      }
      expect(broken).toEqual([]);
    });
  });

  describe('typeahead', () => {
    it('lists London first for "lon", and the rows are the board\'s unfiltered counts', async () => {
      const hits = lex.placesByPrefix('lon', 8);
      expect(hits[0]?.key).toBe('GB/London');
      const { rows: n } = await db().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM jobs WHERE status = 'live' AND place_country = 'GB' AND place_city = 'London'`
      );
      expect(hits[0]?.rows).toBe(n[0]?.n);
    });

    it('one entry per label, countries by alias, companies by prefix', () => {
      const labels = lex.placesByPrefix('new', 50).map((p) => `${p.kind}|${p.label}`);
      expect(new Set(labels).size).toBe(labels.length);
      expect(lex.placesByPrefix('deutsch', 3)[0]?.key).toBe('DE');
      expect(lex.companiesByPrefix('fig', 3)[0]).toEqual({ name: 'Figma', label: 'Figma', rows: expect.any(Number) });
    });
  });

  describe('parseSearch with the real lexicon', () => {
    /**
     * Each row: what is typed, the words that are left, the chips in the
     * parser's order. A surprise is explained on the row that has it.
     */
    const cases: Array<[string, string[], string[]]> = [
      ['product designer london remote 150k', ['product', 'designer'], ['place:GB/London', 'remote:remote', 'pay:150']],
      ['nurse maryland', ['nurse'], ['place:US-MD']],
      ['engineer berlin', ['engineer'], ['place:DE/Berlin']],
      ['designer new york this week', ['designer'], ['place:US-NY/New York', 'age:7']],
      ['figma designer', ['designer'], ['company:Figma']],
      ['data scientist uk', ['data', 'scientist'], ['place:GB']],
      ['ux designer san francisco hybrid', ['ux', 'designer'], ['place:US-CA/San Francisco', 'remote:hybrid']],
      ['marketing manager toronto', ['marketing', 'manager'], ['place:CA-ON/Toronto']],
      ['accountant london ontario', ['accountant'], ['place:CA-ON/London']],
      // The state, not Washington, DC: 1,072 rows in the state against 496 in the
      // city, and the city is in another admin area so it is not the state's namesake.
      ['nurse practitioner washington', ['nurse', 'practitioner'], ['place:US-WA']],
      ['amazon software engineer seattle 200k+', ['software', 'engineer'], ['place:US-WA/Seattle', 'company:Amazon', 'pay:200']],
      ['remote nurse united states', ['nurse'], ['place:US', 'remote:remote']],
      ['frontend developer nyc', ['frontend', 'developer'], ['place:US-NY/New York']],
      ['product manager paris france 120-180k', ['product', 'manager'], ['place:FR/Paris', 'pay:120']],
      ['sales manager deutschland', ['sales', 'manager'], ['place:DE']],
      ['engineer mexico', ['engineer'], ['place:MX']],
      ['support specialist today', ['support', 'specialist'], ['age:1']],
      ['london ky', [], ['place:US-KY/London']],
      ['designer, london, remote', ['designer'], ['place:GB/London', 'remote:remote']],
      // The company, not Harvey, IL: see "a name that is both a place and a company".
      ['harvey designer', ['designer'], ['company:Harvey']],
      // "in" is a word (no place answers to it), so it stays in the text and
      // cannot become an India chip.
      ['senior engineer in test', ['senior', 'engineer', 'in', 'test'], []],
      // Stripe is not on this board: a name the board does not carry is a word.
      ['designer at stripe', ['designer', 'at', 'stripe'], []]
    ];

    it.each(cases)('%s', (text, words, chips) => {
      const r = parseSearch(text, lex);
      expect(r.words).toEqual(words);
      expect(short(r.chips)).toEqual(chips);
      expect(r.offers).toEqual([]);
    });

    it('"mobile engineer" keeps the word and offers the place: Mobile, AL is a title term', () => {
      const r = parseSearch('mobile engineer', lex);
      expect(r.words).toEqual(['mobile', 'engineer']);
      expect(r.chips).toEqual([]);
      expect(r.offers.map((o) => o.chip.kind === 'place' ? o.chip.key : null)).toEqual(['US-AL/Mobile']);
    });

    it('a parse survives the address: chipsFromParams(chipsToParams(chips)) is the chips, with the real lexicon', () => {
      for (const [text] of cases) {
        const r = parseSearch(text, lex);
        const back = chipsFromParams(new URLSearchParams(chipsToParams(r.chips)), lex);
        expect(back, text).toEqual(r.chips);
      }
    });
  });

  describe('cached per crawl', () => {
    let spy: MockInstance | null = null;
    const jobsReads = () => (spy?.mock.calls ?? []).filter((c: unknown[]) => String(c[0]).includes('FROM jobs')).length;

    beforeEach(() => {
      forgetLexicon();
      spy = vi.spyOn(db(), 'query');
    });
    afterEach(() => {
      spy?.mockRestore();
      spy = null;
      forgetLexicon();
    });

    it('builds once for concurrent requests (single flight), and again for the next crawl instant', async () => {
      const a = await Promise.all(Array.from({ length: 8 }, () => getLexicon('2026-10-01T00:00:00.000Z')));
      expect(new Set(a).size).toBe(1);
      expect(jobsReads()).toBe(3); // places, companies, titles, once
      const again = await getLexicon('2026-10-01T00:00:00.000Z');
      expect(again).toBe(a[0]);
      expect(jobsReads()).toBe(3);
      const next = await getLexicon('2026-10-02T00:00:00.000Z');
      expect(next).not.toBe(a[0]);
      expect(next.boardRowsAt).toBe('2026-10-02T00:00:00.000Z');
      expect(jobsReads()).toBe(6);
    });

    it('reads the crawl instant itself when the caller does not pass one, and reuses the build', async () => {
      const first = await getLexicon();
      const second = await getLexicon();
      expect(second).toBe(first);
      expect(jobsReads()).toBe(3);
    });

    it('does not cache a failed build; the next request tries again', async () => {
      spy?.mockRejectedValueOnce(new Error('connection reset'));
      await expect(getLexicon('2026-10-03T00:00:00.000Z')).rejects.toThrow(/connection reset/);
      const ok = await getLexicon('2026-10-03T00:00:00.000Z');
      expect(ok.place('london')?.key).toBe('GB/London');
    });

    it('is built in well under 300 ms on this board (load plus assembly)', async () => {
      const t0 = performance.now();
      const built = await getLexicon('2026-10-04T00:00:00.000Z');
      const ms = performance.now() - t0;
      console.log(`search-lexicon build: ${ms.toFixed(0)} ms total, load ${built.stats.loadMs} ms, assemble ${built.stats.assembleMs} ms; ` +
        `${built.stats.countries} countries, ${built.stats.adminAreas} admin areas, ${built.stats.cities} city keys, ` +
        `${built.stats.companies} companies, ${built.stats.titles} titles, ${built.stats.titleWords} title words`);
      expect(ms).toBeLessThan(1500); // a slow CI disk, not the target; the target is in the log line
      expect(built.stats.assembleMs).toBeLessThan(300);
    });
  });
});
