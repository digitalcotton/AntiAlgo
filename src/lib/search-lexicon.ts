/**
 * search-lexicon.ts: the vocabulary behind the search box, read off the live
 * board. This is the real `Lexicon` that search-parse.ts takes as an argument,
 * plus the two prefix lookups the typeahead needs.
 *
 * WHAT IT IS MADE FROM. Four GROUP BY reads of the live rows, nothing else: the
 * places that postings list, as the most specific key of each (jobs.place_leaves,
 * db/222) with a row count; the country and admin-area keys (jobs.place_keys)
 * with an exact row count; (company) with a row count; and (title) with a row
 * count. A posting that lists several places is under each of them, so the
 * country and admin totals are counted from the keys, once per posting, and not
 * summed from the places, which would count a posting twice for two cities in
 * one country. No place, company or title word comes from a
 * file or a gazetteer, so the box can only ever recognise something the board
 * carries: a reader who types a city with no postings gets a word, never a chip
 * that counts zero. The two tables that name things (country names and aliases,
 * admin area names) are the ones jobs-derived.mjs already reads free text with;
 * they are imported, not restated.
 *
 * THE POPULATION is `status = 'live'`, the same one listBoardFiltered reads when
 * liveOnly is left at its default. A killed row is not on the board, so a place
 * or company carried only by killed rows is not in the vocabulary.
 *
 * KEYS, AND WHAT A KEY MEANS (this is the contract with the SQL layer).
 *   country   `GB`                 the ISO code
 *   admin     `US-MD`              country, a hyphen, the admin code placeOf stores
 *   city      `GB/London`          country, a slash, place_city exactly as stored
 *             `US-MD/Baltimore`    country-admin, a slash, place_city exactly
 * A key's parts are its CONSTRAINTS: `GB/London` is "country GB and city
 * London" with whatever admin area the row has, and `US-MD/Baltimore` adds the
 * admin area. That matters for exactly one shape of row, a city carried both
 * with and without an admin area ("London, ON" 6 rows and "London, Canada" 5):
 * the key `CA/London` is then the 11 of them, which is what a reader who typed
 * "london canada" means, and `CA-ON/London` is the 6. `rows` on a key is the
 * count under that reading. City names are kept EXACTLY as stored, so
 * `Richmond` and `RIchmond` are two keys; that is eight spellings on the board
 * today and the real repair is in the place table, not here.
 *
 * WHAT `place()` ACCEPTS, AND WHAT IT REFUSES ON PURPOSE.
 *   - A country by its English name and by every alias jobs-derived.mjs lists
 *     for it ("united kingdom", "uk", "england", "deutschland", "holland").
 *   - An admin area by its FULL name ("maryland", "new south wales"). Never by
 *     its code: `md`, `on`, `ca` are words and country codes, and they only
 *     mean an admin area in the company of a city.
 *   - A city by its name, by a nickname the place table folds ("nyc", "sf",
 *     "munchen"), and qualified: city + admin code ("london ky"), city + admin
 *     name ("london ontario"), city + country ("london united kingdom",
 *     "london uk", "london gb"), and city + admin + country ("baltimore md
 *     usa"). Only combinations the board actually carries resolve.
 *   - A canonical key, so chipsFromParams can turn `?place=` back into a label:
 *     `GB`, `us-md`, `gb/london`, `us-md/baltimore`.
 *
 *   THE TWO-LETTER COUNTRY CODE IS CASE SENSITIVE, and that is the one place
 *   this file leans on how chipsFromParams asks. The parser lowercases every
 *   token it types, so `in`, `de`, `us` and `gb` always reach place() in lower
 *   case; chipsToParams writes the key as it is stored, upper case, and
 *   chipsFromParams tries the normalised form first and the raw value second.
 *   So `place('GB')` resolves and `place('gb')` does not: a reader typing "in"
 *   is writing a word, and "senior engineer in test" must not become an India
 *   chip. (`us-md` and `gb/london` contain a hyphen or a slash, which no word
 *   does, so they resolve in lower case.)
 *
 * WHEN TWO PLACES ANSWER TO ONE NAME the answer is chosen by rows, with two
 * stated exceptions. (1) A country always wins its own name: Mexico is the
 * country, not Mexico, MO. (2) A city that bears the name of the admin area it
 * sits in (New York, NY inside New York) wins that name when it carries more of
 * the area's rows than the rest of the area together, because rows alone would
 * always hand the name to the area (it contains the city) and nobody typing
 * "new york" into a job board means Buffalo and Albany as well. "washington" is
 * the state: Washington, DC is in another admin area and has fewer rows. A bare
 * city name shared by several cities ("london", "springfield") is the one with
 * the most rows of its own.
 *
 * A NAME THAT IS BOTH A PLACE AND A COMPANY goes to the larger use, by live rows.
 * The parser asks place first, so without this "harvey" would be Harvey, IL (2
 * rows) and the company Harvey (304) could not be reached from the box; three
 * company names on the local board are shadowed that way today (Harvey, Arcadia,
 * Adelaide). A place that is the larger use ("paris") keeps its name.
 *
 * `isTitleTerm` IS DATA, NOT A LIST. A phrase is a title term when it occurs, as
 * consecutive whole words, in at least as many live ROWS' titles as there are
 * live rows carrying the place (or the company) it names. The parser asks only
 * about phrases that already matched, once, of the whole phrase (see its
 * header). Built as an inverted index over the distinct titles, weighted by how
 * many rows carry each, with adjacency verified, so "new york" is asked about
 * as "new york" and not as "new".
 *
 * CACHED PER CRAWL. The lexicon is a function of the rows, and the rows change
 * once a night when the crawl loads, so it is built once per
 * boardRowsLoadedAt() instant and kept at module level. Concurrent first
 * requests share one build (single flight); a failed build is not cached and
 * the next request tries again. Every wait has a terminal state: a build that
 * has not finished in BUILD_TIMEOUT_MS rejects its waiters and is forgotten.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */
import { db } from './db';
import { boardRowsLoadedAt, getBoardStats } from './job-store';
import { ADMIN_NAMES, CITY_ALIAS_NAMES, COUNTRY_ALIAS_NAMES, countryName } from './jobs-derived.mjs';
import { parsePlaceKey, placeKeyLabel } from './place-key';
import { LEXICON_MAX_WORDS, normalisePhrase, type Lexicon } from './search-parse';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One (country, admin1, city, label) group of live rows, as the database counts it:
 *  the rows that list this place as one of theirs. */
export interface PlaceRow {
  country: string;
  admin1: string | null;
  city: string | null;
  label: string | null;
  rows: number;
}
/** How many live rows list one country or admin-area key (`GB`, `US-MD`), each row
 *  once however many places of that country it lists. */
export interface KeyRow {
  key: string;
  rows: number;
}
export interface CompanyRow {
  company: string;
  rows: number;
}
export interface TitleRow {
  title: string;
  rows: number;
}
/** Everything the lexicon is built from. Plain data, so a test builds one by hand. */
export interface LexiconRows {
  places: PlaceRow[];
  /** The exact country and admin-area totals, from the keys. loadLexiconRows
   *  always supplies them. Absent, buildLexicon sums them from `places`, which is
   *  the same number only while no posting lists two places in one country (a
   *  hand-built fixture of one place a row). */
  keys?: KeyRow[];
  companies: CompanyRow[];
  titles: TitleRow[];
}

export type PlaceKind = 'country' | 'admin' | 'city';

/** A place as the typeahead lists it. `rows` is every live row carrying it, with
    no filter applied: the suggest endpoint recounts under the reader's filters,
    this is only for ranking candidates. */
export interface PlaceSuggestion {
  key: string;
  label: string;
  rows: number;
  kind: PlaceKind;
}
export interface CompanySuggestion {
  name: string;
  label: string;
  rows: number;
}

/** Why `isTitleTerm` said what it said. `nameRows` is the live rows carrying the
    place or company the phrase names (0 when it names neither); `titleRows` is
    the live rows whose title holds the phrase as whole adjacent words. */
export interface TitleTermReport {
  phrase: string;
  kind: 'place' | 'company' | null;
  /** The place key or the company name the phrase resolved to. */
  resolved: string | null;
  nameRows: number;
  titleRows: number;
  isTitleTerm: boolean;
}

export interface LexiconStats {
  countries: number;
  adminAreas: number;
  /** City KEYS: `US-MD/Baltimore` and `US/Baltimore` are two keys. */
  cities: number;
  /** Distinct companies after normalisation (two spellings of one name count once). */
  companies: number;
  /** Phrases that resolve to a place without any qualifier being parsed. */
  placePhrases: number;
  titles: number;
  titleWords: number;
  /** Milliseconds spent assembling the structures from rows already in memory. */
  assembleMs: number;
  /** Milliseconds spent reading the three GROUP BYs; 0 for a lexicon built from rows. */
  loadMs: number;
}

export interface BoardLexicon extends Lexicon {
  /** The crawl instant this lexicon was built for (boardRowsLoadedAt), or null. */
  readonly boardRowsAt: string | null;
  readonly stats: LexiconStats;
  /** Places whose name, or any word of it, starts with the prefix, best first:
      names that START with it before names that merely contain a word that does,
      then by rows. At most `limit` (capped at SUGGEST_MAX); an empty prefix
      lists nothing. One entry per distinct label, so two spellings of a city
      show once. */
  placesByPrefix(prefix: string, limit: number): PlaceSuggestion[];
  companiesByPrefix(prefix: string, limit: number): CompanySuggestion[];
  /** The counts behind an `isTitleTerm` verdict, for the report and the tests. */
  explainTitleTerm(phrase: string): TitleTermReport;
}

/** The hard cap on a prefix lookup, whatever the caller asks for. */
export const SUGGEST_MAX = 50;
/** A country is its own name against any city or admin area, by this much. */
const COUNTRY_BOOST = 1_000_000_000;
/** Phrases and prefixes are cut here before anything is compared. */
const PHRASE_MAX_CHARS = 120;
/** Memo tables are bounded: a phrase is arbitrary typed text. */
const MEMO_MAX = 20_000;
export const BUILD_TIMEOUT_MS = 30_000;
/** How long a lexicon built with no crawl instant to key on is trusted. */
const UNSTAMPED_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

interface PlaceEntity {
  key: string;
  label: string;
  kind: PlaceKind;
  /** Live rows under the key's reading (see the header). */
  rows: number;
  country: string;
  /** The admin code, for an admin-qualified city and for an admin area. */
  admin: string | null;
  /** Normalised names the typeahead matches a prefix against. */
  names: string[];
  /** Normalised label, the typeahead's one-per-label key. */
  labelNorm: string;
}

/** A city's own group of rows, before keys are formed. */
interface CityGroup {
  country: string;
  admin: string | null;
  city: string;
  label: string;
  rows: number;
}

interface Candidate {
  entity: PlaceEntity;
  weight: number;
}

/** The better of two readings of one phrase: more weight, then the more specific
    key (the longer), then the key itself, so a tie is the same every build. */
function better(a: Candidate, b: Candidate): boolean {
  if (a.weight !== b.weight) return a.weight > b.weight;
  if (a.entity.key.length !== b.entity.key.length) return a.entity.key.length > b.entity.key.length;
  return a.entity.key < b.entity.key;
}

function addCandidate(table: Map<string, Candidate>, phrase: string, candidate: Candidate): void {
  if (phrase === '') return;
  const held = table.get(phrase);
  if (held === undefined || better(candidate, held)) table.set(phrase, candidate);
}

/** Two-letter country codes are the one kind of key that is also a word. */
function isIsoCode(phrase: string, country: string): boolean {
  return phrase === country.toLowerCase();
}

/**
 * Every phrase a country answers to as free text, normalised, and the subset
 * that may stand ALONE.
 *
 * Alone, the lower-cased ISO code is dropped ("us", "in", "de" are words). The
 * two names jobs-derived.mjs refuses to read as countries are dropped too:
 * "georgia" is the US state and "puerto rico" a US area unless a city says
 * otherwise, and a board that carries rows from the country Georgia still
 * reaches it by its key or by picking it from the typeahead.
 *
 * AFTER A CITY, the code is fine ("berlin de", "paris fr"): the pair is not a
 * word, and the board has to carry that city in that country for it to resolve
 * at all.
 */
function countryPhrases(code: string): { alone: string[]; afterCity: string[]; names: string[] } {
  const display = countryName(code) as string | null;
  const raw = [display ?? code, ...(COUNTRY_ALIAS_NAMES[code] ?? [])];
  const all = [...new Set(raw.map(normalisePhrase).filter((p) => p !== ''))];
  const alone = all.filter((p) => !isIsoCode(p, code) && p !== 'georgia' && p !== 'puerto rico');
  const afterCity = [...new Set([...all, code.toLowerCase()])];
  return { alone, afterCity, names: [...new Set([...all, ...alone])] };
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/**
 * Words of a title, or of a phrase being asked about: each run of letters and
 * digits, after the parser's own normalisation. Splitting on every other
 * character is what lets "New York-based" and "Engineer (London)" hold their
 * place names as whole words, and because the PHRASE is cut the same way,
 * `o'fallon` is asked about as `o fallon` and finds "Manager - O'Fallon, MO".
 */
function titleWords(text: string): string[] {
  const out: string[] = [];
  for (const chunk of normalisePhrase(text).split(' ')) {
    for (const part of chunk.split(/[^\p{L}\p{N}]+/u)) if (part !== '') out.push(part);
  }
  return out;
}

interface TitleIndex {
  words: number;
  titles: number;
  /** Rows whose title holds `phrase` as consecutive whole words. */
  rowsWith(phrase: string): number;
}

function containsRun(haystack: Int32Array, needle: readonly number[]): boolean {
  const last = haystack.length - needle.length;
  for (let i = 0; i <= last; i += 1) {
    let k = 0;
    while (k < needle.length && haystack[i + k] === needle[k]) k += 1;
    if (k === needle.length) return true;
  }
  return false;
}

/**
 * An inverted index over the distinct titles: word -> the titles holding it,
 * each title weighted by the rows that carry it. A phrase takes the postings of
 * its rarest word and checks adjacency in those titles only, so a phrase with
 * one rare word costs a handful of comparisons however common its other words
 * are. Verdicts are memoised per phrase.
 */
function buildTitleIndex(titles: readonly TitleRow[]): TitleIndex {
  const ids = new Map<string, number>();
  const postings: number[][] = [];
  const tokens: Int32Array[] = [];
  const rows: number[] = [];
  for (const t of titles) {
    const words = titleWords(t.title);
    if (words.length === 0) continue;
    const row = tokens.length;
    const wordIds = words.map((w) => {
      let id = ids.get(w);
      if (id === undefined) {
        id = ids.size;
        ids.set(w, id);
        postings.push([]);
      }
      return id;
    });
    tokens.push(Int32Array.from(wordIds));
    rows.push(t.rows);
    for (const id of new Set(wordIds)) postings[id]?.push(row);
  }

  const memo = new Map<string, number>();
  const rowsWith = (phrase: string): number => {
    const held = memo.get(phrase);
    if (held !== undefined) return held;
    const needle: number[] = [];
    let known = true;
    for (const w of titleWords(phrase)) {
      const id = ids.get(w);
      if (id === undefined) known = false;
      else needle.push(id);
    }
    let total = 0;
    if (known && needle.length > 0) {
      let rarest = needle[0] ?? 0;
      for (const id of needle) if ((postings[id]?.length ?? 0) < (postings[rarest]?.length ?? 0)) rarest = id;
      for (const row of postings[rarest] ?? []) {
        const title = tokens[row];
        if (title !== undefined && containsRun(title, needle)) total += rows[row] ?? 0;
      }
    }
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(phrase, total);
    return total;
  };
  return { words: ids.size, titles: tokens.length, rowsWith };
}

// ---------------------------------------------------------------------------
// Prefix lookup
// ---------------------------------------------------------------------------

/** 0 when a name starts with the prefix, 1 when a later word of one does, else null. */
function matchLevel(names: readonly string[], prefix: string): 0 | 1 | null {
  let level: 0 | 1 | null = null;
  for (const name of names) {
    if (name.startsWith(prefix)) return 0;
    if (level === null && name.includes(` ${prefix}`)) level = 1;
  }
  return level;
}

function clampLimit(limit: number): number {
  const n = Number.isFinite(limit) ? Math.floor(limit) : 0;
  return Math.max(0, Math.min(SUGGEST_MAX, n));
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/** The qualifiers a city may carry after its name, for the city's own country
    and admin area. Checked at lookup, not precomputed per city: a phrase has at
    most LEXICON_MAX_WORDS words, and 3,500 cities times a dozen spellings each
    is a large table for what a handful of string compares answer. */
function qualifierMatches(city: PlaceEntity, tail: string, countryTails: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const inCountry = (phrase: string) => countryTails.get(city.country)?.has(phrase) === true;
  if (inCountry(tail)) return true;
  if (city.admin === null) return false;
  const adminForms = adminFormsOf(city.country, city.admin);
  for (const form of adminForms) {
    if (tail === form) return true;
    if (tail.startsWith(`${form} `) && inCountry(tail.slice(form.length + 1))) return true;
  }
  return false;
}

/** The normalised code and full name of an admin area: the two ways a reader
    writes it after a city. */
function adminFormsOf(country: string, admin: string): string[] {
  const name = ADMIN_NAMES[country]?.[admin];
  return [...new Set([normalisePhrase(admin), name === undefined ? '' : normalisePhrase(name)].filter((f) => f !== ''))];
}

export function buildLexicon(input: LexiconRows, boardRowsAt: string | null = null, loadMs = 0): BoardLexicon {
  const started = performance.now();

  // ---- places: sum the rows into countries, admin areas and city keys -----
  const countryRows = new Map<string, number>();
  const adminRows = new Map<string, number>(); // `US-MD`
  const groups = new Map<string, CityGroup>(); // one per (country, admin, city, as stored)
  for (const p of input.places) {
    const country = String(p.country ?? '').toUpperCase();
    if (country === '' || !(p.rows > 0)) continue;
    if (input.keys === undefined) {
      countryRows.set(country, (countryRows.get(country) ?? 0) + p.rows);
      if (p.admin1 !== null && p.admin1 !== '') {
        const key = `${country}-${p.admin1}`;
        adminRows.set(key, (adminRows.get(key) ?? 0) + p.rows);
      }
    }
    if (p.city !== null && p.city !== '') {
      const id = `${country}|${p.admin1 ?? ''}|${p.city}`;
      const held = groups.get(id);
      if (held === undefined) {
        const fallback = `${p.city}, ${(countryName(country) as string | null) ?? country}`;
        groups.set(id, { country, admin: p.admin1 || null, city: p.city, label: p.label || fallback, rows: p.rows });
      } else {
        held.rows += p.rows;
      }
    }
  }

  // The exact totals, when the database counted them: a country or an admin area
  // is as many rows as list it, not as many places as they list.
  for (const k of input.keys ?? []) {
    if (!(k.rows > 0)) continue;
    if (/^[A-Z]{2}$/.test(k.key)) countryRows.set(k.key, k.rows);
    else if (/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(k.key)) adminRows.set(k.key, k.rows);
  }

  const byKey = new Map<string, PlaceEntity>(); // every key as written, and the unambiguous ones normalised
  const entities: PlaceEntity[] = [];
  const countryTails = new Map<string, Set<string>>();
  const exact = new Map<string, Candidate>();
  const countryEntities = new Map<string, PlaceEntity>();

  for (const [code, rows] of [...countryRows].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const phrases = countryPhrases(code);
    const label = (countryName(code) as string | null) ?? code;
    const entity: PlaceEntity = {
      key: code, label, kind: 'country', rows, country: code, admin: null,
      names: phrases.names, labelNorm: normalisePhrase(label)
    };
    entities.push(entity);
    countryEntities.set(code, entity);
    byKey.set(code, entity); // the code as written, upper case: see the header
    countryTails.set(code, new Set(phrases.afterCity));
    for (const phrase of phrases.alone) addCandidate(exact, phrase, { entity, weight: rows + COUNTRY_BOOST });
  }

  const adminEntities = new Map<string, PlaceEntity>();
  for (const [key, rows] of [...adminRows].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const dash = key.indexOf('-');
    const country = key.slice(0, dash);
    const code = key.slice(dash + 1);
    const name = ADMIN_NAMES[country]?.[code] ?? code;
    const norm = normalisePhrase(name);
    const entity: PlaceEntity = { key, label: name, kind: 'admin', rows, country, admin: code, names: [norm], labelNorm: norm };
    entities.push(entity);
    adminEntities.set(key, entity);
    byKey.set(key, entity);
    addCandidate(exact, norm, { entity, weight: rows });
  }

  // City keys. `K-A/City` for a city with an admin area; `K/City` for one without,
  // and that key answers for the city in EVERY admin area of the country (header).
  const cityByName = new Map<string, PlaceEntity[]>(); // normalised name or nickname -> keys
  const cityEntities = new Map<string, PlaceEntity>();
  const anyAdminRows = new Map<string, number>(); // `K/City` -> rows in every admin area
  for (const g of groups.values()) {
    const id = `${g.country}/${g.city}`;
    anyAdminRows.set(id, (anyAdminRows.get(id) ?? 0) + g.rows);
  }
  const ownRows = new Map<string, number>(); // key -> this key's own group rows, for the bare name
  for (const g of [...groups.values()].sort((a, b) => (a.country + a.admin + a.city < b.country + b.admin + b.city ? -1 : 1))) {
    const key = g.admin === null ? `${g.country}/${g.city}` : `${g.country}-${g.admin}/${g.city}`;
    if (cityEntities.has(key)) continue;
    const rows = g.admin === null ? anyAdminRows.get(key) ?? g.rows : g.rows;
    const norm = normalisePhrase(g.city);
    const labelNorm = normalisePhrase(g.label);
    const entity: PlaceEntity = { key, label: g.label, kind: 'city', rows, country: g.country, admin: g.admin, names: [...new Set([norm, labelNorm])], labelNorm };
    entities.push(entity);
    cityEntities.set(key, entity);
    ownRows.set(key, g.rows);
    byKey.set(key, entity);
    const list = cityByName.get(norm);
    if (list === undefined) cityByName.set(norm, [entity]);
    else list.push(entity);
  }

  // The normalised form of every key that has one a reader could not mistake:
  // `us-md`, `gb/london`. Two city spellings that differ only in case or accents
  // (`Richmond` and `RIchmond`) share one, and there neither is registered, so
  // the lookup that chipsFromParams makes first (normalised) finds nothing and
  // the one it makes second (the raw address value, exact) finds the right one.
  const normalisedKeys = new Map<string, PlaceEntity[]>();
  for (const entity of entities) {
    if (entity.kind === 'country') continue;
    const norm = normalisePhrase(entity.key);
    const held = normalisedKeys.get(norm);
    if (held === undefined) normalisedKeys.set(norm, [entity]);
    else held.push(entity);
  }
  for (const [norm, list] of normalisedKeys) {
    if (list.length === 1 && list[0] !== undefined) byKey.set(norm, list[0]);
  }

  // Nicknames the place table folds ("nyc" is New York): the same cities under a
  // second name, for the bare phrase, for the qualified ones, and for the typeahead.
  for (const [alias, target] of Object.entries(CITY_ALIAS_NAMES)) {
    const aliasNorm = normalisePhrase(alias);
    const targets = cityByName.get(normalisePhrase(target));
    if (aliasNorm === '' || targets === undefined) continue;
    const held = cityByName.get(aliasNorm);
    cityByName.set(aliasNorm, held === undefined ? [...targets] : [...held, ...targets.filter((t) => !held.includes(t))]);
    for (const t of targets) if (!t.names.includes(aliasNorm)) t.names.push(aliasNorm);
  }

  // The bare name of a city. Weighted by the key's OWN rows, so a city seen in
  // two admin areas goes to the bigger one; and a city that bears its admin
  // area's name takes the name from the area when it holds the larger share.
  for (const [name, list] of cityByName) {
    for (const entity of list) {
      let weight = ownRows.get(entity.key) ?? entity.rows;
      if (entity.admin !== null) {
        const area = adminEntities.get(`${entity.country}-${entity.admin}`);
        if (area !== undefined && area.names[0] === name && weight * 2 > area.rows) weight = area.rows + 1;
      }
      addCandidate(exact, name, { entity, weight });
    }
  }

  const placePhrases = new Map<string, PlaceEntity>();
  for (const [phrase, candidate] of exact) placePhrases.set(phrase, candidate.entity);

  // ---- companies -----------------------------------------------------------
  const companyBest = new Map<string, { name: string; rows: number }>();
  for (const c of input.companies) {
    const norm = normalisePhrase(c.company);
    if (norm === '' || !(c.rows > 0)) continue;
    const held = companyBest.get(norm);
    if (held === undefined || c.rows > held.rows || (c.rows === held.rows && c.company < held.name)) {
      companyBest.set(norm, { name: c.company, rows: c.rows });
    }
  }
  const companyList = [...companyBest].map(([norm, c]) => ({ norm, name: c.name, rows: c.rows }));

  const titleIndex = buildTitleIndex(input.titles);

  // ---- lookups -------------------------------------------------------------
  const qualified = new Map<string, PlaceEntity | null>();
  const resolveQualified = (phrase: string): PlaceEntity | null => {
    const words = phrase.split(' ');
    if (words.length < 2 || words.length > LEXICON_MAX_WORDS) return null;
    let best: Candidate | null = null;
    for (let k = 1; k < words.length; k += 1) {
      const heads = cityByName.get(words.slice(0, k).join(' '));
      if (heads === undefined) continue;
      const tail = words.slice(k).join(' ');
      for (const city of heads) {
        if (!qualifierMatches(city, tail, countryTails)) continue;
        const candidate = { entity: city, weight: city.rows };
        if (best === null || better(candidate, best)) best = candidate;
      }
    }
    return best === null ? null : best.entity;
  };

  const resolvePlaceName = (phrase: string): PlaceEntity | null => {
    if (typeof phrase !== 'string' || phrase === '' || phrase.length > PHRASE_MAX_CHARS) return null;
    const keyed = byKey.get(phrase);
    if (keyed !== undefined) return keyed;
    const named = placePhrases.get(phrase);
    if (named !== undefined) return named;
    if (qualified.has(phrase)) return qualified.get(phrase) ?? null;
    const found = resolveQualified(phrase);
    if (qualified.size >= MEMO_MAX) qualified.clear();
    qualified.set(phrase, found);
    return found;
  };

  /**
   * A name that is both a place and a company belongs to the larger use. The
   * parser asks place first at every length (so "paris" is the city), which on
   * its own would hand "harvey" to Harvey, IL (2 rows) and make the company
   * Harvey (304 rows) impossible to reach from the box. So a place yields its
   * name to a company that carries more live rows than the place does, and the
   * parser's next question, `company()`, gets it. Canonical keys are untouched:
   * no company is named `us-md`.
   */
  const resolvePlace = (phrase: string): PlaceEntity | null => {
    const hit = resolvePlaceName(phrase);
    if (hit === null) return null;
    const company = companyBest.get(phrase);
    return company !== undefined && company.rows > hit.rows ? null : hit;
  };

  const resolveCompany = (phrase: string): { name: string; rows: number } | null => {
    if (typeof phrase !== 'string' || phrase === '' || phrase.length > PHRASE_MAX_CHARS) return null;
    return companyBest.get(phrase) ?? null;
  };

  const explainTitleTerm = (phrase: string): TitleTermReport => {
    const place = resolvePlace(phrase);
    const company = place === null ? resolveCompany(phrase) : null;
    const kind = place !== null ? 'place' : company !== null ? 'company' : null;
    const nameRows = place?.rows ?? company?.rows ?? 0;
    const titleRows = titleIndex.rowsWith(phrase);
    // A phrase that names neither a place nor a company has no name use to
    // outweigh, so it is plain text: the conservative answer for a caller that
    // would otherwise promote it to a chip.
    const isTitleTerm = kind === null ? true : titleRows >= nameRows;
    return { phrase, kind, resolved: place?.key ?? company?.name ?? null, nameRows, titleRows, isTitleTerm };
  };

  const placesByPrefix = (prefix: string, limit: number): PlaceSuggestion[] => {
    const n = clampLimit(limit);
    const p = normalisePhrase(String(prefix ?? '').slice(0, PHRASE_MAX_CHARS));
    if (n === 0 || p === '') return [];
    const hits: Array<{ entity: PlaceEntity; level: 0 | 1 }> = [];
    for (const entity of entities) {
      const level = matchLevel(entity.names, p);
      if (level !== null) hits.push({ entity, level });
    }
    hits.sort((a, b) =>
      a.level !== b.level ? a.level - b.level
        : a.entity.rows !== b.entity.rows ? b.entity.rows - a.entity.rows
        : a.entity.key < b.entity.key ? -1 : 1);
    const seen = new Set<string>();
    const out: PlaceSuggestion[] = [];
    for (const { entity } of hits) {
      const once = `${entity.kind}|${entity.labelNorm}`;
      if (seen.has(once)) continue;
      seen.add(once);
      out.push({ key: entity.key, label: entity.label, rows: entity.rows, kind: entity.kind });
      if (out.length >= n) break;
    }
    return out;
  };

  const companiesByPrefix = (prefix: string, limit: number): CompanySuggestion[] => {
    const n = clampLimit(limit);
    const p = normalisePhrase(String(prefix ?? '').slice(0, PHRASE_MAX_CHARS));
    if (n === 0 || p === '') return [];
    const hits: Array<{ c: (typeof companyList)[number]; level: 0 | 1 }> = [];
    for (const c of companyList) {
      const level = matchLevel([c.norm], p);
      if (level !== null) hits.push({ c, level });
    }
    hits.sort((a, b) =>
      a.level !== b.level ? a.level - b.level
        : a.c.rows !== b.c.rows ? b.c.rows - a.c.rows
        : a.c.name < b.c.name ? -1 : 1);
    return hits.slice(0, n).map(({ c }) => ({ name: c.name, label: c.name, rows: c.rows }));
  };

  const stats: LexiconStats = {
    countries: countryEntities.size,
    adminAreas: adminEntities.size,
    cities: cityEntities.size,
    companies: companyBest.size,
    placePhrases: placePhrases.size,
    titles: titleIndex.titles,
    titleWords: titleIndex.words,
    assembleMs: Math.round((performance.now() - started) * 10) / 10,
    loadMs
  };

  return {
    boardRowsAt,
    stats,
    place(phrase) {
      const hit = resolvePlace(phrase);
      return hit === null ? null : { key: hit.key, label: hit.label };
    },
    company(phrase) {
      return resolveCompany(phrase)?.name ?? null;
    },
    isTitleTerm(phrase) {
      return explainTitleTerm(phrase).isTitleTerm;
    },
    placesByPrefix,
    companiesByPrefix,
    explainTitleTerm
  };
}

// ---------------------------------------------------------------------------
// Reading the board, and the per-crawl cache
// ---------------------------------------------------------------------------

/**
 * The four reads, in parallel. `count(*)::int` because the pg driver returns a
 * bigint as a string and a string row count would compare as text. Each is one
 * GROUP BY over the live rows, so what leaves the database is a few thousand
 * short rows (the place groups, 1.4k companies, 26.7k titles on the local board
 * of 37k rows), never the postings.
 *
 * THE PLACES come from the leaves: one key per place a posting lists, so a
 * posting that lists London and Berlin is a row in each city's group. Only a
 * leaf with a city is a city group, and its label is placeKeyLabel(leaf), which
 * is the label placeOf writes into place_label for the same place (a test holds
 * the two equal for every one-place row on the board). A key with a slash in it
 * is a city key and one without is a country or a region, which is how the two
 * reads below split the keys: the countries and regions are counted from
 * place_keys itself, so no posting is counted twice in a country.
 */
export async function loadLexiconRows(): Promise<LexiconRows> {
  const pool = db();
  const [leaves, keys, companies, titles] = await Promise.all([
    pool.query<{ leaf: string; rows: number }>(
      `SELECT leaf, count(*)::int AS rows
         FROM jobs, unnest(place_leaves) AS leaf
        WHERE status = 'live' AND position('/' in leaf) > 0
        GROUP BY leaf`
    ),
    pool.query<KeyRow>(
      `SELECT k AS key, count(*)::int AS rows
         FROM jobs, unnest(place_keys) AS k
        WHERE status = 'live' AND position('/' in k) = 0
        GROUP BY k`
    ),
    pool.query<CompanyRow>(
      `SELECT company, count(*)::int AS rows FROM jobs
        WHERE status = 'live' AND company IS NOT NULL AND company <> '' GROUP BY company`
    ),
    pool.query<TitleRow>(
      `SELECT title, count(*)::int AS rows FROM jobs
        WHERE status = 'live' AND title IS NOT NULL AND title <> '' GROUP BY title`
    )
  ]);
  const places: PlaceRow[] = [];
  for (const { leaf, rows } of leaves.rows) {
    const key = parsePlaceKey(leaf);
    if (key === null || key.city === null) continue;
    places.push({ country: key.country, admin1: key.admin1, city: key.city, label: placeKeyLabel(leaf), rows });
  }
  return { places, keys: keys.rows, companies: companies.rows, titles: titles.rows };
}

interface Cached {
  key: string;
  at: number;
  lexicon: BoardLexicon;
}
let cached: Cached | null = null;
const building = new Map<string, Promise<BoardLexicon>>();
const UNSTAMPED = 'unstamped';

/** Forget the cache. For a test; nothing in the site calls it. */
export function forgetLexicon(): void {
  cached = null;
  building.clear();
}

async function buildFromBoard(boardRowsAt: string | null): Promise<BoardLexicon> {
  const t0 = performance.now();
  const rows = await loadLexiconRows();
  const loadMs = Math.round((performance.now() - t0) * 10) / 10;
  return buildLexicon(rows, boardRowsAt, loadMs);
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`search-lexicon: the build did not finish in ${ms} ms`));
    }, ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * The lexicon for the board as it is now, built once per crawl.
 *
 * `boardRowsAt` is the crawl instant (boardRowsLoadedAt of the board's stats).
 * A page that already read the stats passes it, which saves the one-row read
 * this would otherwise make on every call; omit it and the stamp is read here.
 * Pass null for "the board has no stamp": that lexicon is trusted for ten
 * minutes rather than forever, since nothing then says when the rows change.
 */
export async function getLexicon(boardRowsAt?: string | null): Promise<BoardLexicon> {
  const stamp = boardRowsAt === undefined ? boardRowsLoadedAt(await getBoardStats()) : boardRowsAt;
  const key = stamp ?? UNSTAMPED;
  if (cached !== null && cached.key === key && (key !== UNSTAMPED || Date.now() - cached.at < UNSTAMPED_TTL_MS)) {
    return cached.lexicon;
  }
  const pending = building.get(key);
  if (pending !== undefined) return pending;

  const build = buildFromBoard(stamp).then((lexicon) => {
    cached = { key, at: Date.now(), lexicon };
    return lexicon;
  });
  const shared = withTimeout(build, BUILD_TIMEOUT_MS, () => {
    if (building.get(key) === shared) building.delete(key);
  });
  building.set(key, shared);
  // Whatever happens, the next call after this one settles starts clean.
  const forget = () => {
    if (building.get(key) === shared) building.delete(key);
  };
  shared.then(forget, forget);
  return shared;
}
