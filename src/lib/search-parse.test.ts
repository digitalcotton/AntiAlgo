import { describe, expect, it } from 'vitest';
import {
  SEARCH_MAX_CHARS,
  chipsFromParams,
  chipsToParams,
  normalisePhrase,
  parseSearch,
  type Chip,
  type Lexicon,
  type ParseResult,
  type RemoteKind
} from './search-parse';

/**
 * The parser is tested against a FAKE lexicon, never the real one: the place
 * table is built by the geography work and the title-term judgement comes from
 * the live board, so a test that read them would change when the data did. This
 * one is thirteen places, seven companies and a short list of title TERMS, each
 * chosen to put a rule on trial, and it is indexed through `normalisePhrase`
 * exactly the way the real lexicon must be.
 *
 * Ambiguity is decided per PHRASE: the parser asks `isTitleTerm` once, with the
 * whole matched phrase, and an offer is made if and only if the answer is yes.
 * The fake therefore holds phrases, not words. It does NOT say `new` or `product`
 * is a title term, although real titles are full of both: that is the point of
 * the rows below, where `new york` and `product design studio` are chips because
 * the PHRASE is not a title term, whatever words it is made of.
 *
 * Which entries are on trial:
 *   london        a place that is not a title term                  -> chip
 *   phoenix       a one-word place that IS a title term             -> offer
 *   new york      a place whose first word is common in titles      -> chip
 *   paris         a name that is both a place and a company         -> place wins
 *   oracle        a one-word company that IS a title term           -> offer
 *   product design         a two-word company that IS a title term  -> offer
 *   product design studio  its longer alias, which is not           -> chip
 *   open ai       a two-word company that is not a title term       -> chip
 *   münchen etc.  accents and letters NFD cannot take apart
 *   washington district of columbia usa   five words: past the four-word look
 *   san francisco bay area  /  san francisco   longest alias wins
 */

type Place = { key: string; label: string };

const LONDON: Place = { key: 'GB/London', label: 'London, United Kingdom' };
const UK: Place = { key: 'GB', label: 'United Kingdom' };
const MARYLAND: Place = { key: 'US-MD', label: 'Maryland, United States' };
const PHOENIX: Place = { key: 'US-AZ/Phoenix', label: 'Phoenix, Arizona, United States' };
const NEW_YORK: Place = { key: 'US-NY/New York', label: 'New York, New York, United States' };
const MUNICH: Place = { key: 'DE-BY/Munich', label: 'Munich, Germany' };
const LODZ: Place = { key: 'PL-LD/Lodz', label: 'Łódź, Poland' };
const ZURICH: Place = { key: 'CH-ZH/Zurich', label: 'Zürich, Switzerland' };
const WEISSENFELS: Place = { key: 'DE-ST/Weissenfels', label: 'Weißenfels, Germany' };
const HCMC: Place = { key: 'VN-SG/Ho Chi Minh City', label: 'Ho Chi Minh City, Vietnam' };
const SF: Place = { key: 'US-CA/San Francisco', label: 'San Francisco, California, United States' };
const BAY_AREA: Place = { key: 'US-CA/Bay Area', label: 'San Francisco Bay Area, California, United States' };
const PARIS: Place = { key: 'FR-IDF/Paris', label: 'Paris, France' };

/** Normalised PHRASES the board uses as a title term at least as much as a name.
    Single words and a two-word phrase, deliberately: the parser asks about the
    whole matched phrase and nothing else. */
const TITLE_TERMS = new Set(['phoenix', 'oracle', 'product design']);

interface SpyLexicon extends Lexicon {
  calls: { place: string[]; company: string[]; title: string[] };
}

function makeLexicon(): SpyLexicon {
  const places = new Map<string, Place>();
  const addPlace = (place: Place, ...names: string[]) => {
    for (const name of names) places.set(normalisePhrase(name), place);
    // The address carries the KEY, and chipsFromParams can only reach it through place().
    places.set(normalisePhrase(place.key), place);
  };
  addPlace(LONDON, 'london', 'London, United Kingdom');
  addPlace(UK, 'united kingdom', 'uk');
  addPlace(MARYLAND, 'maryland');
  addPlace(PHOENIX, 'phoenix');
  addPlace(NEW_YORK, 'new york', 'new york city');
  addPlace(MUNICH, 'München', 'munich');
  addPlace(LODZ, 'Łódź');
  addPlace(ZURICH, 'Zürich');
  addPlace(WEISSENFELS, 'Weißenfels');
  addPlace(HCMC, 'ho chi minh city');
  addPlace(SF, 'san francisco');
  addPlace(BAY_AREA, 'san francisco bay area');
  addPlace(PARIS, 'paris');
  // Five words: the parser looks at four, so this alias is never reached.
  places.set('washington district of columbia usa', { key: 'US-DC', label: 'Washington, DC, United States' });

  const companies = new Map<string, string>();
  const addCompany = (name: string, ...aliases: string[]) => {
    for (const alias of [name, ...aliases]) companies.set(normalisePhrase(alias), name);
  };
  addCompany('Figma', 'figma');
  addCompany('OpenAI', 'open ai');
  addCompany('Stripe', 'stripe');
  addCompany('Oracle', 'oracle');
  addCompany('Product Design Co', 'product design');
  addCompany('Product Design Studio', 'product design studio');
  addCompany('Paris Holdings', 'paris');
  addCompany('Acme Corp', 'acme corp');

  const calls = { place: [] as string[], company: [] as string[], title: [] as string[] };
  return {
    calls,
    place(phrase) {
      calls.place.push(phrase);
      return places.get(phrase) ?? null;
    },
    company(phrase) {
      calls.company.push(phrase);
      return companies.get(phrase) ?? null;
    },
    isTitleTerm(phrase) {
      calls.title.push(phrase);
      return TITLE_TERMS.has(phrase);
    }
  };
}

const LEX = makeLexicon();

const remote = (value: RemoteKind): Chip => ({ kind: 'remote', value });
const pay = (minK: number): Chip => ({ kind: 'pay', minK });
const age = (maxDays: number): Chip => ({ kind: 'age', maxDays });
const place = (p: Place): Chip => ({ kind: 'place', key: p.key, label: p.label });
const company = (name: string): Chip => ({ kind: 'company', name });
const result = (words: string[], chips: Chip[] = [], offers: ParseResult['offers'] = []): ParseResult => ({ words, chips, offers });

const REMOTE = remote('remote');
const HYBRID = remote('hybrid');
const ONSITE = remote('onsite');

/** [what the row shows, what the reader typed, what it must parse to]. One line
    per rule, so a change to the parser is a diff a reviewer can read. */
const PARSE_CASES: Array<[string, string, ParseResult]> = [
  // --- shape of the input ---------------------------------------------------
  ['empty', '', result([])],
  ['whitespace only', '  \t \n ', result([])],
  ['one word', 'designer', result(['designer'])],
  ['words keep the reader\'s case, spacing is collapsed', 'Senior   Product  Designer', result(['Senior', 'Product', 'Designer'])],
  ['commas and semicolons between terms are separators, not part of a word', 'designer, engineer;', result(['designer', 'engineer'])],
  ['punctuation alone is dropped, not searched', 'designer & engineer - sales', result(['designer', 'engineer', 'sales'])],
  ['an emoji has no letter in it and is dropped', '😀 remote 😀', result([], [REMOTE])],
  ['text is cut at 200 characters', 'x'.repeat(250), result(['x'.repeat(200)])],
  ['a fact past character 200 is never read', `${'a'.repeat(199)} remote`, result(['a'.repeat(199)])],
  ['a fact inside the cap is read', `${'a'.repeat(190)} remote`, result(['a'.repeat(190)], [REMOTE])],

  // --- pay: the amount forms ------------------------------------------------
  ['pay: 150k', '150k', result([], [pay(150)])],
  ['pay: $150k', '$150k', result([], [pay(150)])],
  ['pay: capital K', '150K', result([], [pay(150)])],
  ['pay: 150k+', '150k+', result([], [pay(150)])],
  ['pay: $150k+', '$150k+', result([], [pay(150)])],
  ['pay: >150k', '>150k', result([], [pay(150)])],
  ['pay: >=150k', '>=150k', result([], [pay(150)])],
  ['pay: ≥150k', '≥150k', result([], [pay(150)])],
  ['pay: a lone > before the number', '> 150k', result([], [pay(150)])],
  ['pay: over 150k', 'over 150k', result([], [pay(150)])],
  ['pay: Over 150K', 'Over 150K', result([], [pay(150)])],
  ['pay: above 150k', 'above 150k', result([], [pay(150)])],
  ['pay: at least 120k', 'at least 120k', result([], [pay(120)])],
  ['pay: more than 120k', 'more than 120k', result([], [pay(120)])],
  ['pay: min 90k', 'min 90k', result([], [pay(90)])],
  ['pay: 150,000', '150,000', result([], [pay(150)])],
  ['pay: $150,000', '$150,000', result([], [pay(150)])],
  ['pay: $150,000+', '$150,000+', result([], [pay(150)])],
  ['pay: $150000 with a sign and no comma', '$150000', result([], [pay(150)])],
  ['pay: the floor rounds down, never up', '$95,500', result([], [pay(95)])],
  ['pay: €90k', '€90k', result([], [pay(90)])],
  ['pay: £80k', '£80k', result([], [pay(80)])],
  ['pay: $150 with a sign and under a thousand reads as thousands', '$150', result([], [pay(150)])],
  ['pay: a sentence\'s punctuation after the number is not part of it', 'designer, $150k.', result(['designer'], [pay(150)])],

  // --- pay: ranges, floor = lower bound ---------------------------------------
  ['range: 150-200k', '150-200k', result([], [pay(150)])],
  ['range: 150k-200k', '150k-200k', result([], [pay(150)])],
  ['range: $150k–$200k with an en dash', '$150k–$200k', result([], [pay(150)])],
  ['range: $150k — $200k with em dashes and spaces', '$150k — $200k', result([], [pay(150)])],
  ['range: $150k - $200k spaced', '$150k - $200k', result([], [pay(150)])],
  ['range: 150k to 200k', '150k to 200k', result([], [pay(150)])],
  ['range: 150k- 200k', '150k- 200k', result([], [pay(150)])],
  ['range: 150k -200k', '150k -200k', result([], [pay(150)])],
  ['range: $150-200k', '$150-200k', result([], [pay(150)])],
  ['range: €90,000-€120,000', '€90,000-€120,000', result([], [pay(90)])],
  ['range: written backwards reads the way round it can only mean', '200-150k', result([], [pay(150)])],
  ['range: two bare numbers are not money', '100-150', result(['100-150'])],
  ['range: a date is not money', '2024-10-02', result(['2024-10-02'])],

  // --- pay: what is NOT pay ---------------------------------------------------
  ['not pay: a bare 150', '150', result(['150'])],
  ['not pay: a year', '2025', result(['2025'])],
  ['not pay: 3d is a word', '3d', result(['3d'])],
  ['not pay: 3d artist', '3d artist', result(['3d', 'artist'])],
  ['not pay: 401k is the retirement plan', '401k', result(['401k'])],
  ['not pay: 401k plan', '401k plan', result(['401k', 'plan'])],
  ['not pay: 401k+ is still the plan', '401k+', result(['401k+'])],
  ['pay: $401k with a sign is a salary', '$401k', result([], [pay(401)])],
  ['pay: a range through 401 is a salary', '400-410k', result([], [pay(400)])],
  ['not pay: an hourly rate stays a word', '$45/hr', result(['$45/hr'])],
  ['not pay: years of experience', '5 years', result(['5', 'years'])],
  ['not pay: a lone over is a word', 'over', result(['over'])],
  ['not pay: over with no number after it', 'over designer', result(['over', 'designer'])],
  ['pay: clamped to 2000 at the top', '5000k', result([], [pay(2000)])],
  ['pay: clamped to 1 at the bottom', '0k', result([], [pay(1)])],

  // --- pay: a ceiling is not a floor ---------------------------------------
  ['ceiling: under 150k stays words', 'under 150k', result(['under', '150k'])],
  ['ceiling: up to 150k stays words', 'up to 150k', result(['up', 'to', '150k'])],
  ['ceiling: max 150k stays words', 'max 150k', result(['max', '150k'])],
  ['ceiling: less than 150k stays words', 'less than 150k', result(['less', 'than', '150k'])],
  ['ceiling: at most 150k stays words', 'at most 150k', result(['at', 'most', '150k'])],
  ['ceiling: <150k stays a word', '<150k', result(['<150k'])],
  ['ceiling beside a floor: the floor still applies', 'over 100k under 150k', result(['under', '150k'], [pay(100)])],

  // --- remote ---------------------------------------------------------------
  ['remote', 'remote', result([], [REMOTE])],
  ['remote: any case', 'Remote', result([], [REMOTE])],
  ['hybrid', 'HYBRID', result([], [HYBRID])],
  ['onsite', 'onsite', result([], [ONSITE])],
  ['on-site', 'on-site', result([], [ONSITE])],
  ['on site (two words)', 'on site', result([], [ONSITE])],
  ['in-office', 'In-Office', result([], [ONSITE])],
  ['in office (two words)', 'in office', result([], [ONSITE])],
  ['not remote kind: office manager is a title', 'office manager', result(['office', 'manager'])],
  ['not remote kind: the bare word office', 'office', result(['office'])],
  ['not remote kind: on call', 'on call', result(['on', 'call'])],
  ['not remote kind: in the office is a sentence', 'in the office', result(['in', 'the', 'office'])],
  ['not remote kind: remote-first is not exactly remote', 'remote-first', result(['remote-first'])],
  ['remote is a chip even though it is a title term in real titles', 'remote support', result(['support'], [REMOTE])],
  ['remote repeated de-duplicates', 'remote remote', result([], [REMOTE])],
  ['remote and hybrid are both kept', 'remote hybrid', result([], [REMOTE, HYBRID])],
  ['remote kinds come out in canonical order', 'onsite hybrid remote', result([], [REMOTE, HYBRID, ONSITE])],

  // --- age ------------------------------------------------------------------
  ['age: today', 'today', result([], [age(1)])],
  ['age: last 24 hours', 'last 24 hours', result([], [age(1)])],
  ['age: past 12 hrs rounds up to a day', 'past 12 hrs', result([], [age(1)])],
  ['age: last 48 hours is two days', 'last 48 hours', result([], [age(2)])],
  ['age: this week', 'this week', result([], [age(7)])],
  ['age: past week', 'past week', result([], [age(7)])],
  ['age: last week', 'last week', result([], [age(7)])],
  ['age: last 7 days', 'last 7 days', result([], [age(7)])],
  ['age: last 3 days', 'last 3 days', result([], [age(3)])],
  ['age: past 14 days', 'past 14 days', result([], [age(14)])],
  ['age: last 1 day', 'last 1 day', result([], [age(1)])],
  ['age: last 2 weeks is 14 days', 'last 2 weeks', result([], [age(14)])],
  ['age: clamped to 90 days', 'last 365 days', result([], [age(90)])],
  ['age: clamped to 1 day', 'last 0 days', result([], [age(1)])],
  ['age: the bare word new is not a window', 'new', result(['new'])],
  ['age: new grad', 'new grad', result(['new', 'grad'])],
  ['age: new business', 'new business', result(['new', 'business'])],
  ['not age: last on its own', 'last', result(['last'])],
  ['not age: last friday', 'last friday', result(['last', 'friday'])],
  ['not age: last 7 with no unit', 'last 7', result(['last', '7'])],
  ['not age: this weekend', 'this weekend', result(['this', 'weekend'])],
  ['age repeated: the last one wins', 'today this week', result([], [age(7)])],

  // --- places ---------------------------------------------------------------
  ['place: london is not a title term, so it is a chip', 'london', result([], [place(LONDON)])],
  ['place: any case', 'LONDON', result([], [place(LONDON)])],
  ['place: a trailing comma is not part of the name', 'London,', result([], [place(LONDON)])],
  ['place: two words', 'united kingdom', result([], [place(UK)])],
  ['place: an alias', 'uk', result([], [place(UK)])],
  ['place: an admin area', 'maryland', result([], [place(MARYLAND)])],
  ['place: the longest alias wins ("london, united kingdom")', 'London, United Kingdom', result([], [place(LONDON)])],
  ['place: four words', 'ho chi minh city', result([], [place(HCMC)])],
  ['place: longest first, four words over two', 'san francisco bay area', result([], [place(BAY_AREA)])],
  ['place: a three word run with no alias falls back to the two it holds', 'san francisco bay', result(['bay'], [place(SF)])],
  ['place: five words are not looked up', 'washington district of columbia usa', result(['washington', 'district', 'of', 'columbia', 'usa'])],
  ['place: accents folded, ü', 'münchen', result([], [place(MUNICH)])],
  ['place: accents folded, upper case', 'MÜNCHEN', result([], [place(MUNICH)])],
  ['place: typed without the accent', 'munchen', result([], [place(MUNICH)])],
  ['place: ł and ó', 'Łódź', result([], [place(LODZ)])],
  ['place: ü', 'Zürich', result([], [place(ZURICH)])],
  ['place: ß', 'Weißenfels', result([], [place(WEISSENFELS)])],
  ['place repeated: the last one wins and the first leaves no trace', 'london paris', result([], [place(PARIS)])],
  ['place and company at one length: place is asked first', 'paris', result([], [place(PARIS)])],
  ['place that is a title term is offered and kept as a word', 'phoenix', result(['phoenix'], [], [{ span: 'phoenix', chip: place(PHOENIX) }])],
  ['offer: the span keeps the reader\'s own spelling', 'Phoenix', result(['Phoenix'], [], [{ span: 'Phoenix', chip: place(PHOENIX) }])],
  ['offer: the same offer twice is listed once, the words stay', 'phoenix phoenix', result(['phoenix', 'phoenix'], [], [{ span: 'phoenix', chip: place(PHOENIX) }])],
  ['new york is a chip: the PHRASE is not a title term, whatever `new` is', 'new york', result([], [place(NEW_YORK)])],
  ['new york city is a chip as the longer alias', 'new york city', result([], [place(NEW_YORK)])],
  ['new york after a word: the place is read, the word stays', 'designer new york', result(['designer'], [place(NEW_YORK)])],
  ['new york before a pay: a place made of a common word is not blocked', 'New York $150k', result([], [place(NEW_YORK), pay(150)])],
  ['new on its own is still just a word beside a place that is not new york', 'new london', result(['new'], [place(LONDON)])],
  ['an offer does not supersede a chip', 'phoenix london', result(['phoenix'], [place(LONDON)], [{ span: 'phoenix', chip: place(PHOENIX) }])],

  // --- companies ------------------------------------------------------------
  ['company: figma', 'figma', result([], [company('Figma')])],
  ['company: a two word alias', 'open ai', result([], [company('OpenAI')])],
  ['company: its own canonical name', 'OpenAI', result([], [company('OpenAI')])],
  ['company repeated: the last one wins', 'figma stripe', result([], [company('Stripe')])],
  ['company that is a title term is offered', 'oracle', result(['oracle'], [], [{ span: 'oracle', chip: company('Oracle') }])],
  ['company beside words', 'figma designer', result(['designer'], [company('Figma')])],
  ['a two-word phrase that IS a title term is offered, both words kept', 'product design', result(['product', 'design'], [], [{ span: 'product design', chip: company('Product Design Co') }])],
  ['a two-word title-term offer keeps the reader\'s spelling and sits beside a chip', 'Product Design london', result(['Product', 'Design'], [place(LONDON)], [{ span: 'Product Design', chip: company('Product Design Co') }])],
  ['the decision follows the matched phrase, not its words: the longer alias is a chip', 'product design studio', result([], [company('Product Design Studio')])],
  ['a longer word that is no alias: the two-word title term is offered, all three words kept', 'product design studios', result(['product', 'design', 'studios'], [], [{ span: 'product design', chip: company('Product Design Co') }])],

  // --- quotes ---------------------------------------------------------------
  ['quoted: a place is just a word', '"london"', result(['london'])],
  ['quoted: a phrase stays whole, without its quotes', '"remote support"', result(['remote support'])],
  ['quoted: the phrase is a word and the rest is read', '"product designer" london', result(['product designer'], [place(LONDON)])],
  ['quoted: pay is a word inside quotes', '"150k"', result(['150k'])],
  ['quoted: between words', 'designer "remote support" 150k', result(['designer', 'remote support'], [pay(150)])],
  ['quoted: an unterminated quote runs to the end', '"remote supp', result(['remote supp'])],
  ['quoted: curly quotes work the same', '“remote support”', result(['remote support'])],
  ['quoted: an empty pair is nothing', '""', result([])],
  ['quoted: an empty pair beside a fact', '"" remote', result([], [REMOTE])],
  ['quoted: a phrase ends at the closing quote, even with no space after', '"london"uk', result(['london'], [place(UK)])],
  ['quoted: a quote is a wall no place spans', 'san "francisco"', result(['san', 'francisco'])],

  // --- several facts at once ------------------------------------------------
  ['multi: the design\'s own example', 'senior designer london remote 150k this week', result(['senior', 'designer'], [place(LONDON), REMOTE, pay(150), age(7)])],
  ['multi: company, kind, pay, window', 'figma product designer hybrid $150k+ last 7 days', result(['product', 'designer'], [company('Figma'), HYBRID, pay(150), age(7)])],
  ['multi: chips come out in canonical order whatever order they were typed', 'this week 150k remote london figma', result([], [place(LONDON), company('Figma'), REMOTE, pay(150), age(7)])],
  ['multi: accents, a spare word, a floor and a window', 'on-site designer in münchen over 120k today', result(['designer', 'in'], [place(MUNICH), ONSITE, pay(120), age(1)])],
  ['multi: an offer beside a pay chip', 'product designer phoenix 150k', result(['product', 'designer', 'phoenix'], [pay(150)], [{ span: 'phoenix', chip: place(PHOENIX) }])],
  ['multi: a ceiling is left in the words, the rest is read', 'designer london remote under 150k', result(['designer', 'under', '150k'], [place(LONDON), REMOTE])],
  ['multi: case does not matter anywhere', 'Designer LONDON REMOTE', result(['Designer'], [place(LONDON), REMOTE])],
  ['multi: repeated pay, last wins', '100k 150k', result([], [pay(150)])],
  ['multi: repeated pay with a floor word, last wins', 'over 100k $200k', result([], [pay(200)])]
];

describe('parseSearch', () => {
  it('has at least sixty table rows, so a deleted rule is a visible diff', () => {
    expect(PARSE_CASES.length).toBeGreaterThanOrEqual(60);
  });

  it.each(PARSE_CASES)('%s', (_label, input, expected) => {
    expect(parseSearch(input, LEX)).toEqual(expected);
  });

  it('is the same on every run for the same text', () => {
    for (const [, input] of PARSE_CASES) expect(parseSearch(input, LEX)).toEqual(parseSearch(input, LEX));
  });

  it('survives input that is not text', () => {
    expect(parseSearch(undefined as unknown as string, LEX)).toEqual(result([]));
    expect(parseSearch(null as unknown as string, LEX)).toEqual(result([]));
  });

  it('never asks the lexicon about a quoted phrase or a syntax fact', () => {
    const lex = makeLexicon();
    parseSearch('"london" remote 150k today this week last 7 days', lex);
    expect(lex.calls).toEqual({ place: [], company: [], title: [] });
  });

  it('asks about a title term once per match, with the whole normalised phrase', () => {
    const lex = makeLexicon();
    parseSearch('senior designer New York', lex);
    expect(lex.calls.title).toEqual(['new york']);
  });

  it('asks about the phrase that matched, the longest one, and never about its words', () => {
    const lex = makeLexicon();
    parseSearch('san francisco bay area', lex);
    expect(lex.calls.title).toEqual(['san francisco bay area']);
  });

  it('asks once per match when there are several', () => {
    const lex = makeLexicon();
    parseSearch('figma london münchen', lex);
    expect(lex.calls.title).toEqual(['figma', 'london', 'munchen']);
  });

  it('never asks about a word nothing matched', () => {
    const lex = makeLexicon();
    parseSearch('senior designer', lex);
    expect(lex.calls.title).toEqual([]);
  });

  it('looks at no more than four words at a time', () => {
    const lex = makeLexicon();
    parseSearch('one two three four five', lex);
    expect(Math.max(...lex.calls.place.map((p) => p.split(' ').length))).toBe(4);
  });

  it('reads only the first 200 characters, the documented cap', () => {
    expect(SEARCH_MAX_CHARS).toBe(200);
  });
});

describe('normalisePhrase', () => {
  it.each([
    ['München', 'munchen'],
    ['Łódź', 'lodz'],
    ['Weißenfels', 'weissenfels'],
    ['Søren Ærø', 'soren aero'],
    ['  Ho   Chi\tMinh City ', 'ho chi minh city'],
    ['London, UK', 'london uk'],
    ['St. Louis,', 'st louis'],
    ['C++', 'c++'],
    ['Winston-Salem', 'winston-salem'],
    ["O'Fallon", "o'fallon"],
    ['', ''],
    [' , ; ', '']
  ])('%j -> %j', (input, expected) => {
    expect(normalisePhrase(input)).toBe(expected);
  });
});

describe('chipsToParams', () => {
  const CASES: Array<[string, Chip[], Record<string, string>]> = [
    ['no chips is no parameters', [], {}],
    ['place writes its key, not its label', [place(LONDON)], { place: 'GB/London' }],
    ['company writes its canonical name', [company('Figma')], { company: 'Figma' }],
    ['remote writes its value', [HYBRID], { remote: 'hybrid' }],
    ['pay writes thousands as pay_min', [pay(150)], { pay_min: '150' }],
    ['age writes days as age_max', [age(7)], { age_max: '7' }],
    ['two remote kinds make a comma list in canonical order', [ONSITE, REMOTE], { remote: 'remote,onsite' }],
    ['the same remote kind twice is written once', [REMOTE, REMOTE], { remote: 'remote' }],
    ['two places: the last wins', [place(LONDON), place(UK)], { place: 'GB' }],
    ['two companies: the last wins', [company('Figma'), company('Stripe')], { company: 'Stripe' }],
    ['two pays: the last wins', [pay(100), pay(150)], { pay_min: '150' }],
    ['two ages: the last wins', [age(1), age(7)], { age_max: '7' }],
    ['a hand-made fractional pay is rounded down', [pay(150.9)], { pay_min: '150' }],
    ['a hand-made pay over the bound is clamped', [pay(9999)], { pay_min: '2000' }],
    ['a hand-made age under the bound is clamped', [age(0)], { age_max: '1' }],
    ['a hand-made age over the bound is clamped', [age(400)], { age_max: '90' }],
    ['a pay that is not a number is not written', [pay(Number.NaN)], {}],
    [
      'every kind at once',
      [age(7), pay(150), ONSITE, REMOTE, company('Figma'), place(LONDON)],
      { place: 'GB/London', company: 'Figma', remote: 'remote,onsite', pay_min: '150', age_max: '7' }
    ]
  ];

  it.each(CASES)('%s', (_label, chips, expected) => {
    expect(chipsToParams(chips)).toEqual(expected);
  });

  it('writes the parameters in one fixed order, so the same search is the same address', () => {
    const params = chipsToParams([age(7), pay(150), ONSITE, company('Figma'), place(LONDON)]);
    expect(Object.keys(params)).toEqual(['place', 'company', 'remote', 'pay_min', 'age_max']);
  });
});

describe('chipsFromParams', () => {
  const from = (query: string) => chipsFromParams(new URLSearchParams(query), LEX);

  const CASES: Array<[string, string, Chip[]]> = [
    ['an empty address has no chips', '', []],
    ['parameters this board does not own are ignored', 'q=designer&page=3&sort=age', []],
    [
      'every parameter',
      'place=GB%2FLondon&company=Figma&remote=hybrid&pay_min=150&age_max=7',
      [place(LONDON), company('Figma'), HYBRID, pay(150), age(7)]
    ],
    ['chips come out in canonical order whatever the address order', 'age_max=7&pay_min=150&remote=onsite&company=Figma&place=london', [place(LONDON), company('Figma'), ONSITE, pay(150), age(7)]],
    ['a place by its key', 'place=US-MD', [place(MARYLAND)]],
    ['a place by an alias a person might type into the address', 'place=london', [place(LONDON)]],
    ['an unknown place is dropped', 'place=atlantis', []],
    ['an empty place is dropped', 'place=', []],
    ['a company by its canonical name', 'company=OpenAI', [company('OpenAI')]],
    ['an unknown company is dropped', 'company=Nobody', []],
    ['a remote comma list', 'remote=remote,hybrid', [REMOTE, HYBRID]],
    ['a remote list is put in canonical order', 'remote=hybrid,remote', [REMOTE, HYBRID]],
    ['repeated remote parameters accumulate', 'remote=remote&remote=onsite', [REMOTE, ONSITE]],
    ['an unknown remote value is dropped', 'remote=mars', []],
    ['the legacy "all" is not a chip', 'remote=all', []],
    ['an unknown value is dropped from a list and the rest is kept', 'remote=remote,mars', [REMOTE]],
    ['remote is read case-insensitively', 'remote=Remote', [REMOTE]],
    ['pay_min at the lower bound', 'pay_min=1', [pay(1)]],
    ['pay_min at the upper bound', 'pay_min=2000', [pay(2000)]],
    ['pay_min 0 is out of range', 'pay_min=0', []],
    ['pay_min 2001 is out of range', 'pay_min=2001', []],
    ['pay_min that is not a number is dropped', 'pay_min=abc', []],
    ['pay_min that is fractional is dropped', 'pay_min=150.5', []],
    ['pay_min that is negative is dropped', 'pay_min=-5', []],
    ['pay_min that is empty is dropped', 'pay_min=', []],
    ['pay_min with a k is dropped, not parsed', 'pay_min=150k', []],
    ['age_max at the lower bound', 'age_max=1', [age(1)]],
    ['age_max at the upper bound', 'age_max=90', [age(90)]],
    ['age_max 0 is out of range', 'age_max=0', []],
    ['age_max 91 is out of range and left to the age strip', 'age_max=91', []],
    ['a repeated parameter takes the last value', 'pay_min=100&pay_min=150', [pay(150)]],
    ['a repeated parameter takes the last VALID value', 'pay_min=100&pay_min=abc', [pay(100)]],
    ['a repeated place takes the last known one', 'place=london&place=atlantis&place=paris', [place(PARIS)]]
  ];

  it.each(CASES)('%s', (_label, query, expected) => {
    expect(from(query)).toEqual(expected);
  });
});

describe('chips and the address round-trip', () => {
  const roundTrip = (chips: Chip[]) => chipsFromParams(new URLSearchParams(chipsToParams(chips)), LEX);

  it.each(PARSE_CASES.filter(([, , parsed]) => parsed.chips.length > 0))('%s', (_label, _input, parsed) => {
    expect(roundTrip(parsed.chips)).toEqual(parsed.chips);
  });

  it('survives the string form of the address, reserved characters and all', () => {
    const { chips } = parseSearch('figma designer london remote hybrid $150k last 7 days', LEX);
    const query = new URLSearchParams(chipsToParams(chips)).toString();
    expect(query).toBe('place=GB%2FLondon&company=Figma&remote=remote%2Chybrid&pay_min=150&age_max=7');
    expect(chipsFromParams(new URLSearchParams(query), LEX)).toEqual(chips);
  });

  it('is empty both ways for no chips', () => {
    expect(chipsToParams([])).toEqual({});
    expect(roundTrip([])).toEqual([]);
  });

  it('re-parsing the words left over adds no chips: nothing is ever read twice', () => {
    for (const [, input] of PARSE_CASES) {
      const first = parseSearch(input, LEX);
      // Offers and quoted phrases keep facts in `words` by design; a plain
      // re-parse of the joined words must not mint a chip the first pass refused,
      // except through those two doors.
      const second = parseSearch(first.words.join(' '), LEX);
      const refused = first.offers.length > 0 || /["“”]/.test(input) || first.words.some((w) => /\s/.test(w));
      if (!refused) expect(second.chips).toEqual([]);
    }
  });
});
