/**
 * jobs-derived-place.test.ts: region and place, the two geography derivations
 * in src/lib/jobs-derived.mjs.
 *
 * WHAT WENT WRONG, AND WHAT THIS PINS. derivedFor() computed
 * regionOf(row.country || row.location). regionOf is a word list over free
 * text, and the ISO code is not free text: it read `CA` as California and `US`
 * as the bare-US catch-all, and did not know `GB`, `FR` or `DE`. So 979 Canadian
 * postings were 'US West' and every US posting was 'US West'. regionFor() reads
 * the code as a code; the first describe block is that fix and its invariant.
 *
 * placeOf() is new. Its cases are table driven, and the table is the evidence:
 * most of the strings below are real strings from the board, kept as printed.
 *
 * Cases that depend on what the city table knows pass a small table of their
 * own, so a rebuild of src/data/place-cities.json cannot turn them red. The few
 * that read the committed table say so.
 *
 * placesOf() is the second half of this file (2026-10-02, report decision 8): a
 * posting that lists several places is found under every one of them. Its cases
 * are the strings the board really carries, kept as printed, and the examples
 * the owner decision named: "London / Germany" is London, UK and Germany, never
 * London, Germany; there is no city called Europe, Apac or All France; and the
 * one-place strings above read exactly as they always did.
 */
import { describe, it, expect } from 'vitest';
import {
  REGIONS, regionOf, regionFor, placeOf, readPlace, isoCountry, countryName, ISO_COUNTRIES,
  cityKey, derivedFor, placesOf, summaryOf, placeKeysOf, placeLeafOf
} from './jobs-derived.mjs';
import { formatPlaceKey, parsePlaceKey, placeKeyLabel } from './place-key';

import {
  learnCities, splitRows, splitByString, seeded, MIN_ROWS
} from '../../scripts/build-place-table.mjs';

type Entry = { city: string; country: string; admin1: string | null; n: number };

/** A small learned table of the shape build-place-table.mjs writes. */
const TABLE: Record<string, Entry> = {
  'san francisco': { city: 'San Francisco', country: 'US', admin1: 'CA', n: 9 },
  'new york': { city: 'New York', country: 'US', admin1: 'NY', n: 9 },
  seattle: { city: 'Seattle', country: 'US', admin1: 'WA', n: 9 },
  austin: { city: 'Austin', country: 'US', admin1: 'TX', n: 9 },
  london: { city: 'London', country: 'GB', admin1: null, n: 9 },
  berlin: { city: 'Berlin', country: 'DE', admin1: null, n: 9 },
  munich: { city: 'Munich', country: 'DE', admin1: null, n: 9 },
  paris: { city: 'Paris', country: 'FR', admin1: null, n: 9 },
  stockholm: { city: 'Stockholm', country: 'SE', admin1: null, n: 9 },
  amsterdam: { city: 'Amsterdam', country: 'NL', admin1: null, n: 9 },
  toronto: { city: 'Toronto', country: 'CA', admin1: 'ON', n: 9 },
  bengaluru: { city: 'Bengaluru', country: 'IN', admin1: null, n: 9 },
  washington: { city: 'Washington', country: 'US', admin1: 'DC', n: 9 }
};

type Tuple = [string | null, string | null, string | null, string | null];
const tuple = (p: { country: string | null; admin1: string | null; city: string | null; label: string | null }): Tuple =>
  [p.country, p.admin1, p.city, p.label];
/** placeOf as [country, admin1, city, label]; the table defaults to empty. */
const place = (loc: string | null | undefined, country?: string | null, table: Record<string, Entry> = {}): Tuple =>
  tuple(placeOf(loc, country ?? null, table));

const NONE: Tuple = [null, null, null, null];

type Case = readonly [string, string | null | undefined, Tuple];

/** The one-place table placeOf is held to, kept at module level because the list
 *  reader (placesOf) is held to the same strings: it must give the same answer for every
 *  one of them but the three that really name several places. */
const PLACE_CASES: ReadonlyArray<Case> = [
  // Free text, no upstream country.
  ['Austin, TX', null, ['US', 'TX', 'Austin', 'Austin, TX']],
  ['San Francisco, CA', null, ['US', 'CA', 'San Francisco', 'San Francisco, CA']],
  ['Seattle, Washington, USA', null, ['US', 'WA', 'Seattle', 'Seattle, WA']],
  ['Andrews AFB, Maryland', null, ['US', 'MD', 'Andrews AFB', 'Andrews AFB, MD']],
  ['Kansas City, Missouri', null, ['US', 'MO', 'Kansas City', 'Kansas City, MO']],
  ['Washington, District of Columbia', null, ['US', 'DC', 'Washington', 'Washington, DC']],
  ['Washington, DC', null, ['US', 'DC', 'Washington', 'Washington, DC']],
  ['New York, New York', null, ['US', 'NY', 'New York', 'New York, NY']],
  ['Atlanta, Georgia', null, ['US', 'GA', 'Atlanta', 'Atlanta, GA']],
  ['San Juan, PR', null, ['US', 'PR', 'San Juan', 'San Juan, PR']],
  ['Naval Medical Center, Portsmouth, Virginia', null, ['US', 'VA', 'Portsmouth', 'Portsmouth, VA']],
  ['Lebanon, New Hampshire', null, ['US', 'NH', 'Lebanon', 'Lebanon, NH']], // Lebanon is a city here
  ['Jordan, Minnesota', null, ['US', 'MN', 'Jordan', 'Jordan, MN']],
  ['Indiana, Pennsylvania', null, ['US', 'PA', 'Indiana', 'Indiana, PA']],
  ['AZ-Phoenix, UNAVAILABLE, USA', null, ['US', 'AZ', 'Phoenix', 'Phoenix, AZ']],
  ['Bend, OR', null, ['US', 'OR', 'Bend', 'Bend, OR']], // OR is Oregon, not a conjunction
  ['Toronto, Ontario, Canada', null, ['CA', 'ON', 'Toronto', 'Toronto, ON']],
  ['Calgary, AB, CA', null, ['CA', 'AB', 'Calgary', 'Calgary, AB']], // a province code, then Canada
  ['Markham, ON, CA', null, ['CA', 'ON', 'Markham', 'Markham, ON']],
  ['Vancouver, British Columbia, CAN', null, ['CA', 'BC', 'Vancouver', 'Vancouver, BC']],
  ['Melbourne, Victoria, AUS', null, ['AU', 'VIC', 'Melbourne', 'Melbourne, VIC']],
  ['Sydney, NSW, Australia', null, ['AU', 'NSW', 'Sydney', 'Sydney, NSW']],
  ['Bangalore, India', null, ['IN', null, 'Bangalore', 'Bangalore, India']],
  ['München, Deutschland', null, ['DE', null, 'München', 'München, Germany']],
  ['Amsterdam, Noord-Holland, Nederland', null, ['NL', null, 'Amsterdam', 'Amsterdam, Netherlands']],
  ['Bengaluru, Karnataka, IND', null, ['IN', null, 'Bengaluru', 'Bengaluru, India']],
  ['London, England, GBR', null, ['GB', null, 'London', 'London, United Kingdom']],
  ['London, U.K.', null, ['GB', null, 'London', 'London, United Kingdom']],
  ['Zurich, Schweiz', null, ['CH', null, 'Zurich', 'Zurich, Switzerland']],
  ['Wien, Österreich', null, ['AT', null, 'Wien', 'Wien, Austria']],
  ['Stockholm, Sverige', null, ['SE', null, 'Stockholm', 'Stockholm, Sweden']],
  ['Dublin, Éire', null, ['IE', null, 'Dublin', 'Dublin, Ireland']],
  ['São Paulo, Brasil', null, ['BR', null, 'São Paulo', 'São Paulo, Brazil']],
  ['Warszawa, Polska', null, ['PL', null, 'Warszawa', 'Warszawa, Poland']],
  ['Brussels, Brussels Hoofdstedelijk Gewest, België', null, ['BE', null, 'Brussels', 'Brussels, Belgium']],
  ['Paris, Île-de-France, France', null, ['FR', null, 'Paris', 'Paris, France']],
  ['Korea, Republic of - Seoul', null, ['KR', null, 'Seoul', 'Seoul, South Korea']],
  // Country first.
  ['Ireland - Dublin', null, ['IE', null, 'Dublin', 'Dublin, Ireland']],
  ['Japan - Tokyo', null, ['JP', null, 'Tokyo', 'Tokyo, Japan']],
  ['India, Bengaluru', null, ['IN', null, 'Bengaluru', 'Bengaluru, India']],
  ['US, CA, Santa Clara', null, ['US', 'CA', 'Santa Clara', 'Santa Clara, CA']],
  ['California - San Francisco', null, ['US', 'CA', 'San Francisco', 'San Francisco, CA']],
  // Only a country, only a state: the country alone is the label.
  ['United States', null, ['US', null, null, 'United States']],
  ['Singapore', 'SG', ['SG', null, null, 'Singapore']],
  ['Queensland', null, ['AU', 'QLD', null, 'Australia']],
  ['Hong Kong', null, ['HK', null, null, 'Hong Kong']],
  // Remote and arrangement words.
  ['Remote', null, NONE],
  ['Anywhere', null, NONE],
  ['Worldwide', null, NONE],
  ['Global', null, NONE],
  ['Remote - US', null, ['US', null, null, 'United States']],
  ['Remote (United States)', null, ['US', null, null, 'United States']],
  ['US Remote', null, ['US', null, null, 'United States']],
  ['Remote-Malaysia', null, ['MY', null, null, 'Malaysia']],
  ['Remote, Germany', null, ['DE', null, null, 'Germany']],
  ['Austin, TX (Hybrid)', null, ['US', 'TX', 'Austin', 'Austin, TX']],
  ['London, UK (On-site)', null, ['GB', null, 'London', 'London, United Kingdom']],
  ['Hybrid - Austin, TX', null, ['US', 'TX', 'Austin', 'Austin, TX']],
  ['Remote job', 'remote_unresolved', NONE],
  ['Remote - US', 'remote_unresolved', ['US', null, null, 'United States']],
  // Nothing to resolve.
  ['Multiple Locations', null, NONE],
  ['3 Locations', null, NONE],
  ['Location Negotiable After Selection', null, NONE],
  ['UNAVAILABLE, UNAVAILABLE, UNAVAILABLE', null, NONE],
  ['Homeoffice', null, NONE],
  ['Europe', null, NONE],
  ['', null, NONE],
  ['Frankfurt', null, NONE], // a bare city nobody has said the country of
  ['UNAVAILABLE, UNAVAILABLE, US', null, ['US', null, null, 'United States']],
  // Two letters in free text: a US state when it is one, and never a country.
  ['Berlin, DE', null, ['US', 'DE', 'Berlin', 'Berlin, DE']], // Delaware, while no table knows Berlin
  ['Springfield, IN', null, ['US', 'IN', 'Springfield', 'Springfield, IN']], // Indiana, not India
  ['Cape Town, ZA', null, ['ZA', null, 'Cape Town', 'Cape Town, South Africa']], // ZA is no state: it is the country
  ['Kings Langley, GB', null, ['GB', null, 'Kings Langley', 'Kings Langley, United Kingdom']],
  ['Islamabad, PK', null, ['PK', null, 'Islamabad', 'Islamabad, Pakistan']],
  ['Baghdad, IQ', null, ['IQ', null, 'Baghdad', 'Baghdad, Iraq']],
  ['UNAVAILABLE, UNAVAILABLE, KR', null, ['KR', null, null, 'South Korea']],
  ['Baghdad/Erbil, IQ', null, ['IQ', null, null, 'Iraq']], // two cities named: neither is lent to the string
  ['Dover, DE', null, ['US', 'DE', 'Dover', 'Dover, DE']], // a state AND a country code: the state, until a city says otherwise
  ['Saskatoon, SK', null, ['CA', 'SK', 'Saskatoon', 'Saskatoon, SK']], // SK is Slovakia and Saskatchewan
  // Upstream country: trusted, and the only place a code is a country.
  ['London', 'GB', ['GB', null, 'London', 'London, United Kingdom']],
  ['Vancouver, BC', 'CA', ['CA', 'BC', 'Vancouver', 'Vancouver, BC']],
  ['Toronto, ON', 'CA', ['CA', 'ON', 'Toronto', 'Toronto, ON']],
  ['Paris', 'FR', ['FR', null, 'Paris', 'Paris, France']],
  ['Frankfurt', 'DE', ['DE', null, 'Frankfurt', 'Frankfurt, Germany']],
  ['Remote', 'US', ['US', null, null, 'United States']],
  ['UNAVAILABLE, BC, CA', 'CA', ['CA', 'BC', null, 'Canada']], // the CA is a US state code and is dropped
  ['Bangalore, IN', 'IN', ['IN', null, 'Bangalore', 'Bangalore, India']], // a weak IN never overrides
  ['Berlin, DE', 'DE', ['DE', null, 'Berlin', 'Berlin, Germany']],
  ['Seattle, Washington, USA', 'US', ['US', 'WA', 'Seattle', 'Seattle, WA']],
  // Upstream country that the string itself contradicts, in full words.
  ['Albuquerque, New Mexico', 'MX', ['US', 'NM', 'Albuquerque', 'Albuquerque, NM']],
  ['Sydney, New South Wales, AUS', 'GB', ['AU', 'NSW', 'Sydney', 'Sydney, NSW']],
  ['Melbourne, Victoria, AUS', 'CA', ['AU', 'VIC', 'Melbourne', 'Melbourne, VIC']],
  ['Lausanne, Switzerland', 'US', ['CH', null, 'Lausanne', 'Lausanne, Switzerland']],
  ['Ontario, CA, US', 'CA', ['US', 'CA', 'Ontario', 'Ontario, CA']], // Ontario, California
  // Several places.
  ['San Francisco, CA / Remote, USA', 'US', ['US', 'CA', 'San Francisco', 'San Francisco, CA']],
  ['San Francisco, CA • New York, NY • United States', 'US', ['US', null, null, 'United States']],
  ['Dallas, TX, Chicago, IL, Columbus, OH', 'US', ['US', null, null, 'United States']],
  ['Toronto / Vancouver / Kitchener-Waterloo / Edmonton', 'CA', ['CA', null, null, 'Canada']],
  ['Kitchener-Waterloo, ON; Toronto, ON', 'CA', ['CA', 'ON', null, 'Canada']],
  ['Argentina, Brazil, Chile, Colombia', 'MX', ['MX', null, null, 'Mexico']],
  ['United States / Canada', 'CA', ['CA', null, null, 'Canada']], // names two countries, proves neither
  ['Buffalo, NY, Cincinnati, OH, Petrolia, Canada', null, NONE], // US codes and Canada: no one country
  ['San Francisco, CA, New York, NY, Portland, OR, or Remote within Canada or United States', null, NONE],
  ['San Francisco, CA, New York, NY, Portland, OR, or Remote within Canada or United States', 'CA',
    ['CA', null, null, 'Canada']],
  ['Sydney; Perth, Australia; Melbourne, Australia', 'GB', ['AU', null, null, 'Australia']],
  // Hostile input.
  ['constructor', null, NONE],
  ['__proto__ / toString', null, NONE]
];

describe('regionFor: the ISO code is read as a code', () => {
  const byCode: ReadonlyArray<readonly [string, string | null, string]> = [
    ['CA', null, 'Canada'],
    ['CA', 'Toronto, ON', 'Canada'],
    ['CA', 'San Francisco, CA', 'Canada'], // the upstream code wins over a state-shaped token
    ['GB', null, 'UK'],
    ['GB', 'London', 'UK'],
    ['FR', null, 'EU'],
    ['DE', null, 'EU'],
    ['IE', 'Ireland - Dublin', 'EU'],
    ['SE', null, 'EU'],
    ['PL', null, 'EU'],
    ['CH', null, 'EU'], // continental Europe outside the Union: REGIONS has no other bucket
    ['IN', null, 'APAC'],
    ['JP', null, 'APAC'],
    ['SG', null, 'APAC'],
    ['AU', null, 'APAC'],
    ['MX', null, 'LATAM'],
    ['BR', null, 'LATAM'],
    ['IL', null, 'Unknown'], // a country on none of the lists is Unknown, never a guess
    ['ZA', null, 'Unknown'],
    ['AE', null, 'Unknown']
  ];
  for (const [code, loc, want] of byCode) {
    it(`${code} + ${JSON.stringify(loc)} -> ${want}`, () => {
      expect(regionFor(code, loc)).toBe(want);
    });
  }

  const usCases: ReadonlyArray<readonly [string | null, string]> = [
    ['Austin, TX', 'US Central'],
    ['Seattle, Washington, USA', 'US West'],
    ['New York, NY', 'US East'],
    ['Remote', 'US West'], // the bare-US catch-all, as the word list has always answered
    ['US, CA, Santa Clara', 'US West'],
    ['Fort Stewart, Georgia', 'US East'], // no word for Georgia: the state decides
    ['Hurlburt Field, Florida', 'US East'],
    ['Scott AFB, Illinois', 'US Central'],
    ['London, Ohio', 'US East'], // never UK, however the word list feels about London
    [null, 'US West']
  ];
  for (const [loc, want] of usCases) {
    it(`US + ${JSON.stringify(loc)} -> ${want}`, () => {
      expect(regionFor('US', loc)).toBe(want);
    });
  }

  it('reads the resolved place when the row has no usable code', () => {
    expect(regionFor(null, 'Toronto, ON')).toBe('Canada');
    expect(regionFor(undefined, 'London, UK')).toBe('UK');
    expect(regionFor('', 'Paris, France')).toBe('EU');
    expect(regionFor('XX', 'Berlin, Germany')).toBe('EU');
    // Text the word list has no word for, resolved by the place parser.
    expect(regionFor(null, 'Cape Town, ZA')).toBe('Unknown'); // South Africa is on no REGIONS list
    expect(regionFor(null, 'Kings Langley, GB')).toBe('UK');
    expect(regionFor(null, 'Bengaluru, Karnataka, IND')).toBe('APAC');
    expect(regionFor(null, 'Amsterdam, Noord-Holland, Nederland')).toBe('EU');
    expect(regionFor(null, 'Fort Stewart, Georgia')).toBe('US East');
  });

  it('the place beats the word list where the two disagree', () => {
    // The word list reads "paris" as EU and "london" as UK wherever they appear.
    // With no upstream country the place says Texas and Ohio, and so does the region.
    expect(regionOf('Paris, Texas')).toBe('EU');
    expect(regionFor(null, 'Paris, Texas')).toBe('US Central');
    expect(regionOf('London, Ohio')).toBe('UK');
    expect(regionFor(null, 'London, Ohio')).toBe('US East');
    // "DE" is Germany where the committed table has learned the city there, and Delaware where it has not.
    expect(regionFor(null, 'Berlin, DE')).toBe('EU');
    expect(regionFor(null, 'Dover, DE')).toBe('US East');
  });

  it('the region is a function of the place: both columns are given the same one', () => {
    // A synthetic place proves the region reads it and not the string.
    const de = { country: 'DE', admin1: null, city: null, label: 'Germany' };
    expect(regionFor(null, 'anything at all', de)).toBe('EU');
    const tx = { country: 'US', admin1: 'TX', city: null, label: 'United States' };
    expect(regionFor(null, 'anything at all', tx)).toBe('US Central');
  });

  it('falls back to the text only when the place has no country', () => {
    // 'remote_unresolved' is what the crawl writes when it could not place a
    // remote posting. It is not a country, and "Remote - Worldwide" has none.
    expect(regionFor('remote_unresolved', 'Remote - Worldwide')).toBe('Worldwide');
    expect(regionFor('remote_unresolved', 'Remote')).toBe(regionOf('Remote'));
    expect(regionFor(null, 'Multiple Locations')).toBe(regionOf('Multiple Locations'));
    expect(regionFor(null, null)).toBe('Unknown');
  });

  it('INVARIANT: a non-US code never reaches a US region', () => {
    // Locations that are shaped like the US and say nothing stronger. A
    // two letter code in the text is a state, but the upstream code outranks
    // it, so none of these may drag a non-US row into the US.
    const usShaped = [
      'Austin, TX', 'Seattle, WA', 'New York, NY', 'San Francisco, CA', 'Washington, DC',
      'Remote', 'Remote - Anywhere', 'DC', 'CA', 'OR', 'WA', 'TX', '', null
    ];
    const codes = ISO_COUNTRIES.filter((c: string) => c !== 'US');
    expect(codes.length).toBeGreaterThan(200);
    for (const code of codes) {
      for (const loc of usShaped) {
        const r = regionFor(code, loc);
        expect(r.startsWith('US'), `${code} + ${JSON.stringify(loc)} gave ${r}`).toBe(false);
      }
    }
  });

  it('INVARIANT: every code gives a region REGIONS names', () => {
    for (const code of ISO_COUNTRIES) {
      for (const loc of ['Austin, TX', 'Remote', 'London', null]) {
        expect(REGIONS, `${code} + ${loc}`).toContain(regionFor(code, loc));
      }
    }
  });

  it('INVARIANT: the US branch answers only US regions, from the state alone', () => {
    // Every state, DC and Puerto Rico, spelled as a bare "Town, XX": whatever
    // the word list says or does not, the answer is a US region.
    const states = ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ ' +
      'NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR').split(' ');
    expect(states).toHaveLength(52);
    for (const st of states) {
      expect(['US West', 'US East', 'US Central'], st).toContain(regionFor('US', `Smallville, ${st}`));
    }
  });

  it('keeps the region list the Jobs Data page groups on', () => {
    expect(REGIONS).toEqual([
      'US West', 'US East', 'US Central', 'EU', 'UK', 'Canada', 'APAC', 'LATAM', 'Worldwide', 'Unknown'
    ]);
  });

  it('regionOf is unchanged for text, including the reading that caused the bug', () => {
    expect(regionOf('Toronto, ON')).toBe('Canada');
    expect(regionOf('London, UK')).toBe('UK');
    expect(regionOf('Paris, France')).toBe('EU');
    // These are why the code must not be handed to regionOf.
    expect(regionOf('CA')).toBe('US West');
    expect(regionOf('US')).toBe('US West');
    expect(regionOf('GB')).toBe('Unknown');
    expect(regionOf('FR')).toBe('Unknown');
  });

  it('a string that spells out another country beats a wrong upstream code (the one exception)', () => {
    // The crawl has put "Albuquerque, New Mexico" under Mexico. Calling that
    // LATAM would introduce a falsehood this change was written to remove.
    expect(regionFor('MX', 'Albuquerque, New Mexico')).toBe('US Central');
    expect(regionFor('GB', 'Sydney, New South Wales, AUS')).toBe('APAC');
    expect(regionFor('CA', 'Melbourne, Victoria, AUS')).toBe('APAC');
    // The exception is exactly this wide: a country NAME or a state in full.
    // A two letter token, the thing that made the word list wrong, never moves
    // a row (the invariant above), and a string naming two countries proves neither.
    expect(regionFor('FR', 'Austin, TX')).toBe('EU');
    expect(regionFor('CA', 'United States / Canada')).toBe('Canada');
    expect(regionFor('AD', 'US Remote')).toBe('US West');
  });
});

describe('placeOf: the table', () => {
  const cases = PLACE_CASES;
  expect(cases.length).toBeGreaterThanOrEqual(40);
  for (const [loc, country, want] of cases) {
    it(`${JSON.stringify(loc)} [${country ?? ''}] -> ${want.join(' / ')}`, () => {
      expect(place(loc, country)).toEqual(want);
    });
  }

  it('null and undefined are a gap, not an error', () => {
    expect(place(null, null)).toEqual(NONE);
    expect(place(undefined, undefined)).toEqual(NONE);
    expect(place('', '')).toEqual(NONE);
    expect(place(null, 'US')).toEqual(['US', null, null, 'United States']);
  });
});

describe('placeOf: with a city table', () => {
  const cases: ReadonlyArray<readonly [string, string | null, Tuple]> = [
    ['San Francisco', null, ['US', 'CA', 'San Francisco', 'San Francisco, CA']],
    ['SF Office', null, ['US', 'CA', 'San Francisco', 'San Francisco, CA']],
    ['New York City', null, ['US', 'NY', 'New York', 'New York, NY']],
    ['NYC', null, ['US', 'NY', 'New York', 'New York, NY']],
    ['London', null, ['GB', null, 'London', 'London, United Kingdom']],
    ['München', null, ['DE', null, 'Munich', 'Munich, Germany']],
    ['Bangalore, India', null, ['IN', null, 'Bengaluru', 'Bengaluru, India']], // one city, one facet
    ['Toronto', 'CA', ['CA', 'ON', 'Toronto', 'Toronto, ON']],
    ['Toronto, Canada', null, ['CA', 'ON', 'Toronto', 'Toronto, ON']], // the state comes from the table
    ['Austin, United States', null, ['US', 'TX', 'Austin', 'Austin, TX']],
    ['Washington', null, ['US', 'DC', 'Washington', 'Washington, DC']], // the city, not the state
    ['Stockholm HQ', null, ['SE', null, 'Stockholm', 'Stockholm, Sweden']],
    ['Brown\'s Hotel, London, United Kingdom', null, ['GB', null, 'London', 'London, United Kingdom']],
    ['Masthuggskajen, Stockholm', null, ['SE', null, 'Stockholm', 'Stockholm, Sweden']],
    // "San Francisco Bay Area" is San Francisco: the suffix is dropped from the
    // key, and the table's one answer for San Francisco is US / CA.
    ['San Francisco Bay Area (Hybrid)', null, ['US', 'CA', 'San Francisco', 'San Francisco, CA']],
    ['Greater Seattle Area', null, ['US', 'WA', 'Seattle', 'Seattle, WA']],
    // A list of cities in different countries is a gap; in one country, the country.
    ['Stockholm / London', null, NONE],
    ['Paris, Berlin', null, NONE],
    ['San Francisco / New York City', null, ['US', null, null, 'United States']],
    ['Hybrid - San Francisco, New York City, Austin', null, ['US', null, null, 'United States']],
    // A code that is both a state and a country is the country when the table
    // has learned the city in THAT country, and the state otherwise.
    ['Berlin, DE', null, ['DE', null, 'Berlin', 'Berlin, Germany']],
    ['Dover, DE', null, ['US', 'DE', 'Dover', 'Dover, DE']],
    ['San Francisco, CA', null, ['US', 'CA', 'San Francisco', 'San Francisco, CA']], // CA is also Canada
    ['Toronto, CA', null, ['CA', 'ON', 'Toronto', 'Toronto, ON']], // and here the table says Canada
    ['Amsterdam, NL', null, ['NL', null, 'Amsterdam', 'Amsterdam, Netherlands']], // NL is also Newfoundland
    ['Bangalore, IN', null, ['IN', null, 'Bengaluru', 'Bengaluru, India']], // IN is also Indiana
    ['Springfield, IN', null, ['US', 'IN', 'Springfield', 'Springfield, IN']],
    ['Paris, FR', null, ['FR', null, 'Paris', 'Paris, France']], // FR is only a country
    // An upstream country that read the code as a state loses to a city the table
    // knows in the code's country; it keeps the state when the table does not.
    ['Berlin, DE', 'US', ['DE', null, 'Berlin', 'Berlin, Germany']],
    ['Dover, DE', 'US', ['US', 'DE', 'Dover', 'Dover, DE']],
    // The table never overrides what the string or the crawl says.
    ['London', 'CA', ['CA', null, 'London', 'London, Canada']],
    ['Paris, Texas', null, ['US', 'TX', 'Paris', 'Paris, TX']]
  ];
  for (const [loc, country, want] of cases) {
    it(`${JSON.stringify(loc)} [${country ?? ''}] -> ${want.join(' / ')}`, () => {
      expect(place(loc, country, TABLE)).toEqual(want);
    });
  }
});

describe('two letters in free text: country, state, or both', () => {
  // The state and province codes the parser reads, restated here on purpose: the
  // test computes the intersection with the ISO list itself, so a code added to
  // either list is covered without anyone remembering to add it to a test.
  const US = ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ ' +
    'NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR').split(' ');
  const CA = 'AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' ');
  const isIso = (c: string) => (ISO_COUNTRIES as readonly string[]).includes(c);
  const both = [...US, ...CA].filter(isIso);
  // 'NA' is read as "n/a" before it is read as Namibia, on purpose.
  const countryOnly = (ISO_COUNTRIES as readonly string[]).filter((c) => !US.includes(c) && !CA.includes(c) && c !== 'NA');

  it('the intersection is computed, and holds the codes the coordinator named', () => {
    for (const c of ['CA', 'DE', 'IN', 'GA', 'PA', 'CO', 'AL', 'AR', 'MA', 'MD', 'ME', 'MN', 'MO', 'MS', 'MT', 'NE', 'SC']) {
      expect(both, c).toContain(c);
    }
    for (const c of ['TX', 'NY', 'ON', 'BC', 'DC']) expect(both, c).not.toContain(c); // states only
    expect(both.length).toBeGreaterThan(25);
  });

  it('a code that is only a country is that country, for every such code', () => {
    expect(countryOnly.length).toBeGreaterThan(190);
    for (const c of countryOnly) {
      expect(place(`Zzville, ${c}`, null)[0], c).toBe(c);
    }
  });

  it('a code that is both defaults to the state or province, for every such code', () => {
    for (const c of both) {
      const want = US.includes(c) ? 'US' : 'CA';
      expect(place(`Zzville, ${c}`, null), c).toEqual([want, c, 'Zzville', `Zzville, ${c}`]);
    }
  });

  it('a code that is both is the country when the table has the city in that country, for every such code', () => {
    for (const c of both) {
      const table = { zzville: { city: 'Zzville', country: c, admin1: null, n: 9 } };
      expect(place(`Zzville, ${c}`, null, table)[0], c).toBe(c);
    }
  });

  it('...and stays the state when the table has the city in some other country', () => {
    for (const c of both) {
      const other = c === 'FR' ? 'DE' : 'FR';
      const table = { zzville: { city: 'Zzville', country: other, admin1: null, n: 9 } };
      expect(place(`Zzville, ${c}`, null, table)[0], c).toBe(US.includes(c) ? 'US' : 'CA');
    }
  });

  it('against an upstream country: a learned city and the code outrank it, the code alone does not', () => {
    // The crawl files "Berlin, DE" and "Bengaluru, UNAVAILABLE, IN" under the US:
    // Delaware and Indiana read off a German and an Indian city.
    expect(place('Berlin, DE', 'US', TABLE)).toEqual(['DE', null, 'Berlin', 'Berlin, Germany']);
    expect(place('Bangalore, UNAVAILABLE, IN', 'US', TABLE)).toEqual(['IN', null, 'Bengaluru', 'Bengaluru, India']);
    expect(place('Berlin, DE', 'DE', TABLE)).toEqual(['DE', null, 'Berlin', 'Berlin, Germany']);
    expect(place('Bangalore, IN', 'IN', TABLE)).toEqual(['IN', null, 'Bengaluru', 'Bengaluru, India']);
    // No learned city: the code is only a state, and an upstream country keeps it.
    expect(place('Dover, DE', 'US', TABLE)).toEqual(['US', 'DE', 'Dover', 'Dover, DE']);
    expect(place('Berlin, DE', 'US')).toEqual(['US', 'DE', 'Berlin', 'Berlin, DE']);
    // A code that could be a state, with no city to settle it, never overrides.
    expect(readPlace('Zzville, DE', 'US', {}).overrode).toBe(false);
  });

  it('the spec examples', () => {
    expect(place('Cape Town, ZA')).toEqual(['ZA', null, 'Cape Town', 'Cape Town, South Africa']);
    expect(place('Kings Langley, GB')).toEqual(['GB', null, 'Kings Langley', 'Kings Langley, United Kingdom']);
    expect(place('Berlin, DE', null, TABLE)[0]).toBe('DE');
    expect(place('Dover, DE', null, TABLE)).toEqual(['US', 'DE', 'Dover', 'Dover, DE']);
    expect(place('San Francisco, CA', null, TABLE)).toEqual(['US', 'CA', 'San Francisco', 'San Francisco, CA']);
  });

  it('what overrides an upstream country: words, a code that can only be a country, a learned city with its code', () => {
    expect(readPlace('Albuquerque, New Mexico', 'MX', {}).overrode).toBe(true);
    expect(readPlace('Cape Town, ZA', 'GB', {}).overrode).toBe(true);
    expect(place('Halifax, GB', 'CA')[0]).toBe('GB');
    expect(readPlace('Berlin, DE', 'US', TABLE).overrode).toBe(true);
    // And what does not: a bare code that is a state as well, a two letter code
    // on a posting whose upstream country already is that code, or a state-only code.
    for (const [loc, up] of [['Zzville, DE', 'US'], ['Zzville, CA', 'FR'], ['Austin, TX', 'FR'], ['Bangalore, IN', 'IN']] as const) {
      expect(readPlace(loc, up, TABLE).overrode, `${loc} / ${up}`).toBe(false);
    }
  });
});

describe('placeOf: the committed table', () => {
  // These read src/data/place-cities.json as built from the local board. Each
  // is a city with hundreds of rows behind it, so a rebuild keeps them.
  it('resolves the bare city names the board prints most', () => {
    const real = (loc: string) => tuple(placeOf(loc, null));
    expect(real('San Francisco')).toEqual(['US', 'CA', 'San Francisco', 'San Francisco, CA']);
    expect(real('London')[0]).toBe('GB');
    expect(real('Berlin')[0]).toBe('DE');
    expect(real('Paris')[0]).toBe('FR');
    expect(real('Stockholm')[0]).toBe('SE');
    expect(real('Toronto')).toEqual(['CA', 'ON', 'Toronto', 'Toronto, ON']);
    expect(real('San Francisco Bay Area (Hybrid)')).toEqual(['US', 'CA', 'San Francisco', 'San Francisco, CA']);
  });

  it('does not invent a country for a city it has not learned', () => {
    expect(tuple(placeOf('Xyzzyville', null))).toEqual(NONE);
  });
});

describe('readPlace and the pieces', () => {
  it('says when the text overrode the crawl', () => {
    expect(readPlace('Albuquerque, New Mexico', 'MX', {}).overrode).toBe(true);
    expect(readPlace('Albuquerque, New Mexico', 'US', {}).overrode).toBe(false);
    expect(readPlace('Bangalore, IN', 'IN', {}).overrode).toBe(false);
  });

  it('isoCountry accepts a code and nothing else', () => {
    expect(isoCountry('us')).toBe('US');
    expect(isoCountry(' GB ')).toBe('GB');
    for (const bad of ['remote_unresolved', 'UK', 'USA', '', 'ZZ', 'EU', null, undefined, 5]) {
      expect(isoCountry(bad as never), String(bad)).toBeNull();
    }
  });

  it('the country list is the ISO list: 249 assigned codes plus Kosovo, and no CLDR leftovers', () => {
    expect(ISO_COUNTRIES).toHaveLength(250);
    for (const code of ISO_COUNTRIES) {
      expect(countryName(code), code).toBeTruthy();
      expect(countryName(code), code).not.toBe(code);
    }
    for (const gone of ['UK', 'AN', 'CS', 'DD', 'SU', 'YU', 'EU', 'UN', 'ZZ']) {
      expect(ISO_COUNTRIES, gone).not.toContain(gone);
    }
    expect(countryName('US')).toBe('United States');
    expect(countryName('GB')).toBe('United Kingdom');
    expect(countryName('HK')).toBe('Hong Kong');
    expect(countryName('nope')).toBeNull();
  });

  it('a city key folds accents, case, punctuation and the area suffix', () => {
    expect(cityKey('Montréal')).toBe('montreal');
    expect(cityKey('SAINT-DENIS')).toBe('saint denis');
    expect(cityKey('San Francisco Bay Area')).toBe('san francisco');
    expect(cityKey('Greater Boston')).toBe('boston');
    expect(cityKey('Bangalore')).toBe('bengaluru');
    expect(cityKey('constructor')).toBe('constructor');
  });
});

describe('derivedFor: the place columns and the repaired region', () => {
  const base = { title: 'Product Designer', department: 'Design', ats: 'greenhouse', comp_range: null };

  it('a Canadian posting is Canada and carries its place', () => {
    const d = derivedFor({ ...base, country: 'CA', location: 'Toronto, ON' });
    expect(d.derived_region).toBe('Canada');
    expect([d.place_country, d.place_admin1, d.place_city, d.place_label]).toEqual(
      ['CA', 'ON', 'Toronto', 'Toronto, ON']
    );
  });

  it('a US posting gets its sub-region from the text and its place from the string', () => {
    const d = derivedFor({ ...base, country: 'US', location: 'Austin, Texas, USA' });
    expect(d.derived_region).toBe('US Central');
    expect(d.place_label).toBe('Austin, TX');
  });

  it('a posting with no usable country reads its text, as before', () => {
    const d = derivedFor({ ...base, country: 'remote_unresolved', location: 'Remote' });
    expect(d.derived_region).toBe(regionOf('Remote'));
    expect([d.place_country, d.place_admin1, d.place_city, d.place_label]).toEqual([null, null, null, null]);
  });

  it('a posting with no upstream code gets its region from the place, so the columns agree', () => {
    const rows: ReadonlyArray<readonly [string, string, string]> = [
      ['Cape Town, ZA', 'ZA', 'Unknown'],
      ['Kings Langley, GB', 'GB', 'UK'],
      ['Amsterdam, Noord-Holland, Nederland', 'NL', 'EU'],
      ['Bengaluru, Karnataka, IND', 'IN', 'APAC'],
      ['Fort Stewart, Georgia', 'US', 'US East'],
      ['Paris, Texas', 'US', 'US Central'],
      ['Toronto, Ontario, Canada', 'CA', 'Canada']
    ];
    for (const [location, placeCountry, region] of rows) {
      const d = derivedFor({ ...base, country: null, location });
      expect([d.place_country, d.derived_region], location).toEqual([placeCountry, region]);
    }
  });

  it('a posting with neither is a gap in both', () => {
    const d = derivedFor({ ...base, country: null, location: null });
    expect(d.derived_region).toBe('Unknown');
    expect(d.place_country).toBeNull();
  });

  it('keeps every field the ingest and the backfill bind', () => {
    expect(Object.keys(derivedFor({ ...base, country: null, location: 'Austin, TX' })).sort()).toEqual([
      'comp_max_k', 'comp_mid_k', 'comp_min_k', 'derived_fam', 'derived_fam_source', 'derived_friction',
      'derived_region', 'derived_tier', 'place_admin1', 'place_city', 'place_country', 'place_keys',
      'place_label', 'place_leaves', 'priced'
    ]);
  });
});

// ---------------------------------------------------------------------------
// Every place a posting lists (2026-10-02, report decision 8, option B).
// ---------------------------------------------------------------------------

/** TABLE plus the cities the list cases below name. A table of their own, so a
 *  rebuild of src/data/place-cities.json cannot turn a list case red. */
const LIST_TABLE: Record<string, Entry> = {
  ...TABLE,
  vancouver: { city: 'Vancouver', country: 'CA', admin1: 'BC', n: 9 },
  hamburg: { city: 'Hamburg', country: 'DE', admin1: null, n: 9 },
  barcelona: { city: 'Barcelona', country: 'ES', admin1: null, n: 9 },
  melbourne: { city: 'Melbourne', country: 'AU', admin1: 'VIC', n: 9 }
};

/** Every key of every place placesOf finds, distinct and sorted: what place_keys holds. */
const keysFor = (loc: string | null, upstream: string | null = null, table: Record<string, Entry> = LIST_TABLE): string[] =>
  [...new Set(placesOf(loc, upstream, table).flatMap(placeKeysOf))].sort();
const leavesFor = (loc: string | null, upstream: string | null = null, table: Record<string, Entry> = LIST_TABLE): string[] =>
  [...new Set(placesOf(loc, upstream, table).map(placeLeafOf))].sort();

describe('the token rules: what a token is, in one place or in a list', () => {
  it('a region word is not a place', () => {
    const regions = ['Europe', 'EU', 'European Union', 'EMEA', 'APAC', 'Asia-Pacific', 'Asia Pacific', 'LATAM', 'Latin America',
      'Americas', 'North America', 'South America', 'Asia', 'Nordics', 'DACH', 'Benelux', 'Middle East', 'MENA', 'Africa',
      'Ile-de-France', 'Deutschlandweit'];
    for (const word of regions) {
      expect(place(word, null), word).toEqual(NONE);
      // Under an upstream country it is still no city: the country alone is the answer.
      expect(place(word, 'CA'), word).toEqual(['CA', null, null, 'Canada']);
    }
  });

  it('a region word inside a list is not a city either: there is no city called Europe', () => {
    expect(place('Europe / London', null, LIST_TABLE)).toEqual(['GB', null, 'London', 'London, United Kingdom']);
    expect(keysFor('Europe / London')).toEqual(['GB', 'GB/London']);
    expect(keysFor('Ireland / Spain / Europe / Poland', 'GB')).toEqual(['ES', 'IE', 'PL']);
  });

  it('a scope word on the end ("Region", "Wide") names no place', () => {
    expect(place('EMEA Region', null)).toEqual(NONE);
    expect(place('Company Wide', null)).toEqual(NONE);
    expect(place('Company Wide', 'US')).toEqual(['US', null, null, 'United States']);
  });

  it('"Anywhere in France", "All France", "Across Spain", "Throughout Belgium" are the country', () => {
    expect(place('Anywhere in France', null)).toEqual(['FR', null, null, 'France']);
    expect(place('All France', null)).toEqual(['FR', null, null, 'France']);
    expect(place('All France (remote)', null)).toEqual(['FR', null, null, 'France']);
    expect(place('Across Spain', null)).toEqual(['ES', null, null, 'Spain']);
    expect(place('Throughout Belgium', null)).toEqual(['BE', null, null, 'Belgium']);
    expect(place('Anywhere in Quebec', null)).toEqual(['CA', 'QC', null, 'Canada']); // a state counts too
    // Only a country or a state widens: "All Hands" is not a place, so no country settles it.
    expect(place('All Hands', null)).toEqual(NONE);
    // An article after the prefix changes nothing: "Anywhere in the U.S." is the country, not a city of
    // that name (20 live rows said it, as "Anywhere in the U.S. (remote job)", under an upstream US).
    expect(place('Anywhere in the U.S.', null)).toEqual(['US', null, null, 'United States']);
    expect(place('Anywhere in the U.S. (remote job)', 'US')).toEqual(['US', null, null, 'United States']);
    expect(place('Throughout the United Kingdom', null)).toEqual(['GB', null, null, 'United Kingdom']);
    expect(keysFor('Anywhere in the U.S. (remote job)', 'US')).toEqual(['US']);
    expect(derivedFor({ title: 'Designer', department: 'Design', ats: 'greenhouse', comp_range: null, country: 'US', location: 'Anywhere in the U.S. (remote job)' }).place_keys).toEqual(['US']);
    // The article is only skipped when a country or a state follows: "All the Hands" is still nothing.
    expect(place('All the Hands', null)).toEqual(NONE);
    // And in a list the words in front do not make a city called "All France".
    expect(keysFor('All France (remote) / Portugal / Italy')).toEqual(['FR', 'IT', 'PT']);
    expect(keysFor('Anywhere in France, Belgium, Spain')).toEqual(['BE', 'ES', 'FR']);
  });

  it('a sentence fragment is not a city', () => {
    for (const fragment of ['BC & ON only', 'EST Timezone Only', 'Remote only', 'Remote-UK&I', 'Germany & Netherlands']) {
      expect(place(fragment, null), fragment).toEqual(NONE);
      expect(place(fragment, 'CA')[2], fragment).toBeNull(); // the country, and no city of that name
    }
    // The real row: "BC & ON only" used to be filed as a city of that name.
    expect(place('CA Remote (BC & ON only); U.S. Remote', 'US')[2]).toBeNull();
  });

  it('a city and its country joined by a hyphen are two things', () => {
    // A space on one side is enough ...
    expect(place('Barcelona- Spain', null)).toEqual(['ES', null, 'Barcelona', 'Barcelona, Spain']);
    // ... with none on either side the head must be a city the table knows.
    expect(place('Hamburg-Germany', null)).toEqual(NONE);
    expect(place('Zzville-Germany', null, LIST_TABLE)).toEqual(NONE);
    expect(place('Hamburg-Germany', null, LIST_TABLE)).toEqual(['DE', null, 'Hamburg', 'Hamburg, Germany']);
    // ... and a name that merely has a hyphen in it stays one name.
    expect(place('Kitchener-Waterloo', 'CA')).toEqual(['CA', null, 'Kitchener-Waterloo', 'Kitchener-Waterloo, Canada']);
    expect(place('Winston-Salem', 'US')).toEqual(['US', null, 'Winston-Salem', 'Winston-Salem, United States']);
    expect(place('Ile-de-France', 'FR')).toEqual(['FR', null, null, 'France']);
    // Each piece of a slash list is split on its own.
    expect(keysFor('Hamburg-Germany / Barcelona- Spain')).toEqual(['DE', 'DE/Hamburg', 'ES', 'ES/Barcelona']);
  });

  it('"a/d" and "Frankfurt / Main" are one name each, not two places', () => {
    expect(place('Capelle a/d IJssel', 'NL')).toEqual(['NL', null, 'Capelle aan den IJssel', 'Capelle aan den IJssel, Netherlands']);
    expect(place('Frankfurt / Main', 'DE')).toEqual(['DE', null, 'Frankfurt am Main', 'Frankfurt am Main, Germany']);
    expect(placesOf('Capelle a/d IJssel', 'NL', {})).toHaveLength(1);
    expect(placesOf('Frankfurt / Main', 'DE', {})).toHaveLength(1);
    // A real slash still splits: Frankfurt and Berlin are two places.
    const withFrankfurt = { ...LIST_TABLE, frankfurt: { city: 'Frankfurt', country: 'DE', admin1: null, n: 9 } };
    expect(leavesFor('Frankfurt / Berlin', 'DE', withFrankfurt)).toEqual(['DE/Berlin', 'DE/Frankfurt']);
  });

  it('"Bosnia" is Bosnia and Herzegovina', () => {
    expect(place('Sarajevo, Bosnia', null)).toEqual(['BA', null, 'Sarajevo', 'Sarajevo, Bosnia & Herzegovina']);
  });
});

describe('placesOf: a posting is found under every place it lists', () => {
  it('"London / Germany" is London, UK and Germany, never London, Germany', () => {
    expect(keysFor('London / Germany', 'DE')).toEqual(['DE', 'GB', 'GB/London']);
    expect(keysFor('London / Germany', null)).toEqual(['DE', 'GB', 'GB/London']);
    expect(placesOf('London / Germany', 'DE', LIST_TABLE).map((p) => p.label)).toEqual(['London, United Kingdom', 'Germany']);
  });

  it('the upstream country is not lent to the places a list names in words', () => {
    // "London, Canada" and "New York, Canada" were on the board: the crawl's code is its pick of ONE place.
    const lent = keysFor('United States / Canada / London', 'CA');
    expect(lent).toEqual(['CA', 'GB', 'GB/London', 'US']);
    expect(lent).not.toContain('CA/London');
    const york = keysFor('New York / Canada', 'CA');
    expect(york).toEqual(['CA', 'US', 'US-NY', 'US-NY/New York', 'US/New York']);
    expect(york).not.toContain('CA/New York');
    expect(keysFor('London / Europe / Toronto', 'CA')).toEqual(['CA', 'CA-ON', 'CA-ON/Toronto', 'CA/Toronto', 'GB', 'GB/London']);
  });

  it('two cities in two countries are both found, under their own countries', () => {
    expect(keysFor('London / Berlin', 'GB')).toEqual(['DE', 'DE/Berlin', 'GB', 'GB/London']);
    expect(keysFor('London, UK / Berlin, Germany', null)).toEqual(['DE', 'DE/Berlin', 'GB', 'GB/London']);
    expect(keysFor('Stockholm / London', null)).toEqual(['GB', 'GB/London', 'SE', 'SE/Stockholm']);
    expect(keysFor('Paris / Texas', null)).toEqual(['FR', 'FR/Paris', 'US', 'US-TX']);
  });

  it('a city that is also a state still counts under its own city', () => {
    expect(keysFor('Toronto / Vancouver', 'CA')).toEqual(['CA', 'CA-BC', 'CA-BC/Vancouver', 'CA-ON', 'CA-ON/Toronto', 'CA/Toronto', 'CA/Vancouver']);
    expect(keysFor('San Francisco, CA / New York, NY', null)).toEqual(
      ['US', 'US-CA', 'US-CA/San Francisco', 'US-NY', 'US-NY/New York', 'US/New York', 'US/San Francisco']
    );
  });

  it('the same place listed twice is one place', () => {
    expect(placesOf('London / London', 'GB', LIST_TABLE)).toHaveLength(1);
    expect(placesOf('London, UK / London', null, LIST_TABLE)).toHaveLength(1);
    expect(leavesFor('London / London', 'GB')).toEqual(['GB/London']);
  });

  it('a piece that names no place is skipped, not lent a country', () => {
    expect(keysFor('Berlin / Remote', 'DE')).toEqual(['DE', 'DE/Berlin']);
    expect(keysFor('Remote / Germany', null)).toEqual(['DE']);
  });

  it('a piece that names no country takes the upstream one only when nothing in the list contradicts it', () => {
    // Nothing states a country in words, and every place found is in the upstream country.
    expect(keysFor('Haarlem; Amsterdam', 'NL')).toEqual(['NL', 'NL/Amsterdam', 'NL/Haarlem']);
    // "Haarlem; Lugano; Singapore" is Singapore: the list states a country, so the upstream code (the
    // crawl's one pick, SG) is not a fact about Haarlem or Lugano, and a city nobody can place is dropped.
    expect(keysFor('Haarlem; Lugano; Singapore', 'SG')).toEqual(['SG']);
    expect(keysFor('Haarlem; Lugano; Singapore', null)).toEqual(['SG']);
    // And with no country anywhere there is nothing to lend.
    expect(keysFor('Limassol; Haarlem', null)).toEqual([]);
  });

  it('a lone Georgia or Victoria counts only beside another place of its own country', () => {
    expect(keysFor('London / Victoria', 'GB')).toEqual(['GB', 'GB/London']); // the station, not the state
    expect(keysFor('Melbourne / Victoria', null)).toEqual(['AU', 'AU-VIC', 'AU-VIC/Melbourne', 'AU/Melbourne']);
    expect(keysFor('Hamburg / Georgia', 'DE')).toEqual(['DE', 'DE/Hamburg']); // not the US state
  });

  it('two country names joined by "&" or "and" are both countries', () => {
    expect(keysFor('Stockholm; Germany & Netherlands (Remote)', 'DE')).toEqual(['DE', 'NL', 'SE', 'SE/Stockholm']);
    expect(keysFor('Germany & Netherlands / France', null)).toEqual(['DE', 'FR', 'NL']);
    expect(keysFor('Germany and Netherlands / France', null)).toEqual(['DE', 'FR', 'NL']);
  });

  it('a state a place lists is found under its own city and under the state', () => {
    expect(keysFor('Vancouver, Washington', 'CA')).toEqual(['US', 'US-WA', 'US-WA/Vancouver', 'US/Vancouver']);
    // placeOf, the one-place reading, still says Canada here: the list reading is the better one and the
    // columns come from it (summaryOf), so the row is filed under the US and not under Canada.
    expect(place('Vancouver, Washington', 'CA', LIST_TABLE)[0]).toBe('CA');
    expect(summaryOf(placesOf('Vancouver, Washington', 'CA', LIST_TABLE), 'CA')).toMatchObject({ country: 'US', admin1: 'WA', city: 'Vancouver' });
  });
});

describe('placesOf: the comma-list rules', () => {
  it('two or more state codes: each takes the token before it as its city', () => {
    expect(keysFor('Chicago, IL, Evanston, IL', 'US')).toEqual(
      ['US', 'US-IL', 'US-IL/Chicago', 'US-IL/Evanston', 'US/Chicago', 'US/Evanston']
    );
    expect(leavesFor('Chicago, IL, Evanston, IL', 'US')).toEqual(['US-IL/Chicago', 'US-IL/Evanston']);
    expect(keysFor('Dallas, TX, Chicago, IL, Columbus, OH', 'US')).toEqual([
      'US', 'US-IL', 'US-IL/Chicago', 'US-OH', 'US-OH/Columbus', 'US-TX', 'US-TX/Dallas', 'US/Chicago', 'US/Columbus', 'US/Dallas'
    ]);
    // A code with no city before it is the state alone.
    expect(keysFor('Remote (GA, US), Remote (SC, US), Remote (AL, US)', 'US')).toEqual(['US', 'US-AL', 'US-GA', 'US-SC']);
  });

  it('a code followed by a country it does not belong to is that country\'s subdivision, and is dropped', () => {
    // AT is a Honduran department here, not Austria; the list resolves to nothing and is the upstream country.
    expect(keysFor('La Ceiba, AT, HN', 'HN')).toEqual(['HN']);
    // In a list of Latin American countries the pieces are each their own country, and AT is not Austria.
    const latin = 'Remote (La Ceiba, AT, HN), Remote (Trelew, U, AR), Remote (Manaus, AM, BR)';
    expect(keysFor(latin, 'US')).toEqual(['AR', 'BR', 'HN']);
  });

  it('a code that is also a country is the country in a list of other countries, and a state beside its own', () => {
    expect(keysFor('GA, US', null)).toEqual(['US', 'US-GA']); // GA followed by its own country: the state
    expect(keysFor('Macon, GA, US', null)).toEqual(['US', 'US-GA', 'US-GA/Macon', 'US/Macon']);
  });

  it('otherwise two or more countries: each country, and not the upstream one', () => {
    expect(keysFor('Argentina, Brazil, Chile, Colombia', 'MX')).toEqual(['AR', 'BR', 'CL', 'CO']);
    expect(keysFor('United States / Canada', 'CA')).toEqual(['CA', 'US']);
  });

  it('otherwise two or more cities the table knows: each city, in the country the table gives it', () => {
    expect(keysFor('Barcelona, Berlin', null)).toEqual(['DE', 'DE/Berlin', 'ES', 'ES/Barcelona']);
    expect(keysFor('Paris, Berlin', null)).toEqual(['DE', 'DE/Berlin', 'FR', 'FR/Paris']);
  });

  it('a one-place comma string stays one place', () => {
    expect(placesOf('Atlanta, GA, US', null, LIST_TABLE)).toHaveLength(1);
    expect(keysFor('Atlanta, GA, US')).toEqual(['US', 'US-GA', 'US-GA/Atlanta', 'US/Atlanta']);
  });
});

describe('placesOf: a string with one place is the answer placeOf has always given', () => {
  it('every one-place string in the placeOf table reads the same, but the three that name several places', () => {
    // Every case of 'placeOf: the table' above, read as a list. The three that differ really do list
    // places. Two of the new answers are the better one; the first is a known loss, pinned so that it is
    // seen: "Baghdad/Erbil, IQ" shares one trailing country between two cities, Baghdad names no country
    // of its own and the list's text states one, so Baghdad is dropped and the summary city is Erbil
    // (placeOf said Iraq). 7 live rows (2026-10-02).
    const several: Record<string, Tuple> = {
      'Baghdad/Erbil, IQ|': ['IQ', null, 'Erbil', 'Erbil, Iraq'],
      'San Francisco, CA / Remote, USA|US': ['US', null, null, 'United States'],
      'Argentina, Brazil, Chile, Colombia|MX': NONE
    };
    let checked = 0;
    for (const [loc, country, want] of PLACE_CASES) {
      const got = tuple(summaryOf(placesOf(loc, country ?? null, {}), country ?? null));
      const expected = several[`${loc}|${country ?? ''}`] ?? want;
      expect(got, `${JSON.stringify(loc)} [${country ?? ''}]`).toEqual(expected);
      checked += 1;
    }
    expect(checked).toBe(PLACE_CASES.length);
    expect(checked).toBeGreaterThan(100);
  });

  it('a one-place string is exactly [placeOf], or [] when it has no country', () => {
    const one: ReadonlyArray<readonly [string, string | null]> = [
      ['Austin, TX', null], ['Seattle, Washington, USA', 'US'], ['Toronto, Ontario, Canada', null], ['Bangalore, India', null],
      ['Ireland - Dublin', null], ['Remote - US', null], ['Remote (United States)', null], ['Paris, Ile-de-France, France', null],
      ['Sydney, New South Wales, AUS', 'GB'], ['Albuquerque, New Mexico', 'MX'], ['Singapore', 'SG'], ['Remote', 'US']
    ];
    for (const [loc, country] of one) {
      const only = placeOf(loc, country, {});
      expect(placesOf(loc, country, {}), `${loc} [${country}]`).toEqual([only]);
    }
    for (const [loc, country] of [['Remote', null], ['Multiple Locations', null], ['Europe', null], ['Frankfurt', null]] as const) {
      expect(placesOf(loc, country, {}), loc).toEqual([]);
    }
    expect(placesOf('Austin, TX', null, {})).toEqual([{ country: 'US', admin1: 'TX', city: 'Austin', label: 'Austin, TX' }]);
    expect(placesOf('Remote', null, {})).toEqual([]);
    expect(placesOf(null, null, {})).toEqual([]);
    expect(placesOf('', 'US', {})).toEqual([{ country: 'US', admin1: null, city: null, label: 'United States' }]);
  });

  it('the committed table reads the same: every bare city the board prints most is one place', () => {
    for (const city of ['San Francisco', 'London', 'Berlin', 'Paris', 'Stockholm', 'Toronto']) {
      const found = placesOf(city, null);
      expect(found, city).toHaveLength(1);
      expect(tuple(found[0] as never), city).toEqual(tuple(placeOf(city, null)));
    }
  });

  it('hostile input is a gap, not an error', () => {
    for (const hostile of ['constructor', '__proto__ / toString', 'hasOwnProperty / valueOf', '/ / /', ', , ,', ' - - - ']) {
      expect(() => placesOf(hostile, null, {}), hostile).not.toThrow();
      expect(placesOf(hostile, null, {}), hostile).toEqual([]);
    }
  });
});

describe('summaryOf: the one place a row reduces to', () => {
  const summary = (loc: string, upstream: string | null, table: Record<string, Entry> = LIST_TABLE) =>
    tuple(summaryOf(placesOf(loc, upstream, table), upstream));

  it('nothing listed is nothing', () => {
    expect(tuple(summaryOf([], 'US'))).toEqual(NONE);
    expect(summary('Remote', null)).toEqual(NONE);
  });

  it('one country: that country, its state if all agree, its city if there is one', () => {
    expect(summary('Chicago, IL, Evanston, IL', 'US')).toEqual(['US', 'IL', null, 'United States']);
    expect(summary('Dallas, TX, Chicago, IL, Columbus, OH', 'US')).toEqual(['US', null, null, 'United States']);
    expect(summary('Berlin / Remote', 'DE')).toEqual(['DE', null, 'Berlin', 'Berlin, Germany']);
    expect(summary('Europe / London', null)).toEqual(['GB', null, 'London', 'London, United Kingdom']);
    expect(summary('Toronto / Vancouver', 'CA')).toEqual(['CA', null, null, 'Canada']);
  });

  it('several countries: the upstream code if it is one of them, otherwise none, and never a state or a city', () => {
    expect(summary('London / Germany', 'DE')).toEqual(['DE', null, null, 'Germany']);
    expect(summary('London / Germany', 'GB')).toEqual(['GB', null, null, 'United Kingdom']);
    expect(summary('London / Germany', 'US')).toEqual(NONE); // the crawl's pick is not in the list
    expect(summary('London / Germany', null)).toEqual(NONE);
    expect(summary('United States / Canada / London', 'CA')).toEqual(['CA', null, null, 'Canada']);
    expect(summary('Stockholm; Germany & Netherlands (Remote)', 'DE')).toEqual(['DE', null, null, 'Germany']);
  });

  it('the region is read off the summary, so the two columns agree', () => {
    for (const [loc, upstream, region] of [
      ['London / Germany', 'DE', 'EU'],
      ['London / Germany', null, regionOf('London / Germany')],
      ['Chicago, IL, Evanston, IL', 'US', 'US Central']
    ] as const) {
      const d = derivedFor({ title: 'Designer', department: 'Design', ats: 'greenhouse', comp_range: null, location: loc, country: upstream });
      expect(d.derived_region, `${loc} [${upstream}]`).toBe(region);
    }
  });
});

describe('place keys: the board\'s own grammar', () => {
  it('a place has a key at every level, most general first, and its leaf is the last', () => {
    expect(placeKeysOf({ country: 'GB', admin1: null, city: 'London' })).toEqual(['GB', 'GB/London']);
    expect(placeKeysOf({ country: 'US', admin1: 'MD', city: 'Baltimore' })).toEqual(['US', 'US-MD', 'US/Baltimore', 'US-MD/Baltimore']);
    expect(placeKeysOf({ country: 'US', admin1: 'MD', city: null })).toEqual(['US', 'US-MD']);
    expect(placeKeysOf({ country: 'DE', admin1: null, city: null })).toEqual(['DE']);
    expect(placeLeafOf({ country: 'US', admin1: 'MD', city: 'Baltimore' })).toBe('US-MD/Baltimore');
    expect(placeLeafOf({ country: 'GB', admin1: null, city: 'London' })).toBe('GB/London');
    expect(placeLeafOf({ country: 'DE', admin1: null, city: null })).toBe('DE');
  });

  it('every key parses as a place= value and writes back unchanged', () => {
    const rows: ReadonlyArray<readonly [string, string | null]> = [
      ['London / Germany', 'DE'], ['Chicago, IL, Evanston, IL', 'US'], ['Dallas, TX, Chicago, IL, Columbus, OH', 'US'],
      ['Toronto / Vancouver', 'CA'], ['Melbourne / Victoria', null], ['Stockholm; Germany & Netherlands (Remote)', 'DE'],
      ['Capelle a/d IJssel', 'NL'], ['Kitchener-Waterloo, ON; Toronto, ON', 'CA'], ['Austin, TX', null]
    ];
    let n = 0;
    for (const [loc, upstream] of rows) {
      for (const key of keysFor(loc, upstream)) {
        const parsed = parsePlaceKey(key);
        expect(parsed, `${key} from ${loc}`).not.toBeNull();
        expect(formatPlaceKey(parsed as NonNullable<typeof parsed>), key).toBe(key);
        n += 1;
      }
    }
    expect(n).toBeGreaterThan(40);
  });

  it('the label of a leaf key is the label placeOf writes for the same place', () => {
    // The lexicon builds its city groups from the leaves and labels them with placeKeyLabel; they must say what
    // place_label says, or a suggestion would read differently from the row it counts.
    const strings = ['Austin, TX', 'Baltimore, Maryland', 'Toronto, ON', 'Sydney, NSW, Australia', 'London', 'Paris, France',
      'San Francisco Bay Area (Hybrid)', 'Frankfurt / Main', 'Capelle a/d IJssel', 'Bangalore, India', 'Sarajevo, Bosnia'];
    let n = 0;
    for (const loc of strings) {
      for (const p of placesOf(loc, null, LIST_TABLE)) {
        if (!p.city) continue;
        expect(placeKeyLabel(placeLeafOf(p as never)), loc).toBe(p.label);
        n += 1;
      }
    }
    expect(n).toBeGreaterThanOrEqual(strings.length - 2);
    // A country alone has the country's name, as place_label has it.
    expect(placeKeyLabel('DE')).toBe(placesOf('Germany', null, {})[0]?.label);
  });
});

describe('derivedFor: place_keys and place_leaves', () => {
  const base = { title: 'Product Designer', department: 'Design', ats: 'greenhouse', comp_range: null };

  it('carry every place the posting lists, sorted and distinct', () => {
    const d = derivedFor({ ...base, country: 'CA', location: 'United States / Canada / London' });
    expect(d.place_keys).toEqual(['CA', 'GB', 'GB/London', 'US']);
    expect(d.place_leaves).toEqual(['CA', 'GB/London', 'US']);
    expect([d.place_country, d.place_admin1, d.place_city, d.place_label]).toEqual(['CA', null, null, 'Canada']);
  });

  it('a one-place row carries the keys of that place and the one leaf', () => {
    const d = derivedFor({ ...base, country: 'US', location: 'Austin, Texas, USA' });
    expect(d.place_keys).toEqual(['US', 'US-TX', 'US-TX/Austin', 'US/Austin']);
    expect(d.place_leaves).toEqual(['US-TX/Austin']);
    expect(d.place_label).toBe('Austin, TX');
  });

  it('a posting with no place has empty arrays, which is "Not stated"', () => {
    for (const location of ['Remote', 'Multiple Locations', 'Europe', '', null]) {
      const d = derivedFor({ ...base, country: null, location });
      expect(d.place_keys, String(location)).toEqual([]);
      expect(d.place_leaves, String(location)).toEqual([]);
      expect(d.place_country, String(location)).toBeNull();
    }
  });

  it('a list that spans countries has no single country unless the crawl\'s is one of them', () => {
    expect(derivedFor({ ...base, country: 'DE', location: 'London / Germany' }).place_country).toBe('DE');
    expect(derivedFor({ ...base, country: 'US', location: 'London / Germany' }).place_country).toBeNull();
    expect(derivedFor({ ...base, country: 'US', location: 'London / Germany' }).place_keys).toEqual(['DE', 'GB', 'GB/London']);
  });

  it('is deterministic, so an unchanged row compares equal on a re-run', () => {
    const row = { ...base, country: 'US', location: 'Chicago, IL, Evanston, IL' };
    expect(derivedFor(row)).toEqual(derivedFor({ ...row }));
  });
});

describe('learnCities: what the city table keeps', () => {
  const rows = (n: number, location: string, country: string) =>
    Array.from({ length: n }, () => ({ location, country }));

  it('keeps a city with enough rows that agree, and drops the rest', () => {
    const t = learnCities([
      ...rows(MIN_ROWS, 'Lyon', 'FR'), // exactly enough
      ...rows(MIN_ROWS - 1, 'Nantes', 'FR'), // one short
      ...rows(8, 'Cambridge', 'GB'), ...rows(8, 'Cambridge', 'US'), // ambiguous, so out
      ...rows(97, 'Berlin', 'DE'), ...rows(3, 'Berlin', 'US'), // 97%, in
      ...rows(9, 'Remote', 'US') // not a place
    ]);
    expect(t.lyon).toMatchObject({ city: 'Lyon', country: 'FR', admin1: null });
    expect(t.nantes).toBeUndefined();
    expect(t.cambridge).toBeUndefined();
    expect(t.berlin).toMatchObject({ country: 'DE' });
    expect(t.remote).toBeUndefined();
  });

  it('learns the state only when the rows that name one agree', () => {
    const t = learnCities([
      ...rows(5, 'Springfield, Illinois', 'US'), ...rows(5, 'Springfield, Missouri', 'US'),
      ...rows(4, 'Austin, Texas', 'US'),
      ...rows(4, 'Dover', 'US') // no state named: country known, state unknown
    ]);
    expect(t.springfield).toMatchObject({ country: 'US', admin1: null });
    expect(t.austin).toMatchObject({ country: 'US', admin1: 'TX' });
    expect(t.dover).toMatchObject({ country: 'US', admin1: null });
  });

  it('does not let a row with only a bare two letter code vote', () => {
    // "Berlin, DE" under an upstream US is Delaware to the parser and Germany
    // to anyone reading it. Eleven of those must not sink the German rows.
    const t = learnCities([...rows(11, 'Berlin, DE', 'US'), ...rows(40, 'Berlin, Germany', 'DE')]);
    expect(t.berlin).toMatchObject({ country: 'DE', n: 40 });
  });

  it('lets a row that ends in an unambiguous country code vote, and one that ends in a state code not', () => {
    const t = learnCities([
      ...rows(4, 'Kings Langley, GB', 'GB'), // GB can only be a country: this row is evidence
      ...rows(4, 'Dover, DE', 'US') // DE is Delaware or Germany: this one is not
    ]);
    expect(t['kings langley']).toMatchObject({ country: 'GB', n: 4 });
    expect(t.dover).toBeUndefined();
  });

  it('does not learn from a row the text contradicts, or from a list of places', () => {
    const t = learnCities([
      ...rows(10, 'Albuquerque, New Mexico', 'MX'),
      ...rows(10, 'Toronto / Vancouver', 'CA')
    ]);
    expect(t.albuquerque).toBeUndefined();
    expect(t.toronto).toBeUndefined();
  });

  it('is deterministic, with sorted keys', () => {
    const input = [...rows(4, 'Zurich, Switzerland', 'CH'), ...rows(4, 'Aarhus', 'DK'), ...rows(4, 'Lyon', 'FR')];
    const a = JSON.stringify(learnCities(input));
    const b = JSON.stringify(learnCities([...input].reverse()));
    expect(a).toBe(b);
    expect(Object.keys(JSON.parse(a))).toEqual(['aarhus', 'lyon', 'zurich']);
  });
});

describe('the holdout split', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ location: `Town ${i % 97}`, country: 'US' }));

  it('is seeded: the same rows are held out every run', () => {
    expect(splitRows(rows).test).toEqual(splitRows(rows).test);
    const r = seeded(220);
    const first = [r(), r(), r()];
    const s = seeded(220);
    expect([s(), s(), s()]).toEqual(first);
  });

  it('holds out 20% and loses no row', () => {
    const { train, test } = splitRows(rows);
    expect(test).toHaveLength(200);
    expect(train).toHaveLength(800);
  });

  it('the by-string split never tests on a string it trained on', () => {
    const { train, test } = splitByString(rows);
    const seen = new Set(train.map((r) => r.location));
    expect(test.length).toBeGreaterThan(0);
    for (const r of test) expect(seen.has(r.location)).toBe(false);
    expect(train.length + test.length).toBe(rows.length);
  });
});
