/**
 * jobs-derived.mjs: ONE DEFINITION of every field the Jobs Data page derives
 * from a posting rather than reads from it.
 *
 * WHY THIS FILE EXISTS. Until 2026-09-23 these definitions lived in
 * src/lib/ledger-market.ts and ran in the browser, once per row, on every
 * render: seniority was a regex over the title, region was a regex over the
 * location, family was the department trimmed, and friction was the literal
 * string 'easy' on every row. That forced the whole board into the page as
 * JSON (12.0 MB at 31,310 live rows) because no filter could be a SQL WHERE
 * against a column that did not exist.
 *
 * Now the derivation happens ONCE, at ingest, into real columns, and the page
 * filters on those columns. This file is the single owner of the rules:
 *
 *   - scripts/ingest-jobs.mjs calls it on every row it writes (nightly);
 *   - scripts/backfill-derived.mjs calls it to fill rows written before
 *     db/207 added the columns (and db/220 and db/222, which added the
 *     place_* columns and the place_keys and place_leaves arrays);
 *   - src/lib/jobs-data-agg.ts NEVER re-derives; it reads the columns.
 *
 * So there is no second copy to drift. A rule change here is a code change
 * plus one backfill, and both halves of the data agree by construction.
 *
 * PLAIN .mjs ON PURPOSE. scripts/ingest-jobs.mjs is a plain Node script that
 * cannot import a TypeScript module (the same reason src/lib/upsert-sql.mjs is
 * .mjs). TypeScript callers import it directly; the shapes are documented in
 * jobs-derived.d.ts.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */

/**
 * The seniority ladder, lowest to highest. Order is load bearing: the pay
 * ladder chart draws in this order and reads the step between neighbours.
 *
 * ONE DECLARATION, AND IT LIVES HERE because it sits beside tierFromTitle, the
 * only thing that produces these four strings. It was declared four times —
 * again as LADDER in jobs-data-agg.ts, again as the RoleTier type in data.ts,
 * and again as a browser fallback in ledger-v4-app.js — with nothing testing
 * that the four agreed.
 *
 * IT IS NOT CALLED `TIERS` ANY MORE, on purpose. `TIERS` also means the ACCOUNT
 * tier (tiers.config.mjs: public / waitlisted / member / paid / internal), and
 * two exported constants with the same name and unrelated meanings is a trap
 * for whoever next reaches for the wrong import. The browser payload key stays
 * `TIERS` because check-dom-contracts.mjs asserts on that name.
 */
export const SENIORITY_LADDER = /** @type {const} */ (['Senior', 'Staff', 'Lead', 'Director']);

/** Every region regionOf can answer. 'Unknown' is a real answer, not a gap:
 *  it means the posting printed a location this rule does not recognise. */
export const REGIONS = [
  'US West', 'US East', 'US Central', 'EU', 'UK',
  'Canada', 'APAC', 'LATAM', 'Worldwide', 'Unknown'
];

/** The two friction levels. See frictionOf for what they mean and the
 *  evidence behind the mapping. */
export const FRICTIONS = ['easy', 'hard'];

// ---------------------------------------------------------------------------
// Seniority.
// ---------------------------------------------------------------------------

/**
 * Seniority read from the posted title, or null when the title prints no
 * seniority word. Never defaulted to Senior: a title with no level word is a
 * posting that did not state a level, and the page shows that as a gap.
 *
 * Order matters. "Principal Design Lead" is Lead, not Senior, because the
 * ladder is tested from the top down.
 */
import { familyOf } from './job-family.mjs';

export function tierFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(director|head of|vp|vice president|chief)\b/.test(t)) return 'Director';
  if (/\b(principal|lead)\b/.test(t)) return 'Lead';
  if (/\bstaff\b/.test(t)) return 'Staff';
  if (/\b(senior|sr|snr)\b/.test(t)) return 'Senior';
  return null;
}

// ---------------------------------------------------------------------------
// Family (function).
// ---------------------------------------------------------------------------

/**
 * The family the employer's own department string names. Null when the
 * applicant system published none, or when what it published names no family
 * (`FLZR`, `Cody Agency`, a bare `Service`).
 *
 * IT USED TO RETURN THE DEPARTMENT VERBATIM, which meant `derived_fam` held
 * 3,350 distinct values and grouped nothing. The clustering lives in
 * job-family.mjs; this function keeps its department-only contract so the claim
 * it makes is still "the employer filed this under a role of this kind".
 *
 * STILL NOT INFERRED FROM THE TITLE. The original note here was right that a
 * guess from the title is a weaker claim, and that the danger is it wearing the
 * same name. Department alone classifies 67.8% of the board and the title
 * rescues another 7,520 postings, so the answer is to keep BOTH and say which
 * one you are holding — see derivedFor()'s `derived_fam_source`. What that note
 * ruled out was an unlabelled blend, and this is not one.
 */
export function famFromDepartment(department) {
  return familyOf(department, null);
}

/**
 * The family, falling back to the title when the department names none.
 *
 * Returns the family AND its source, never the family alone, because the two
 * carry different weight: 'department' is a field an employer filled in,
 * 'title' is this repo reading a string. A caller that only trusts the stated
 * one can filter on the source; a caller that wants coverage takes both. The
 * one thing neither can do is mistake the second for the first.
 */
export function familyWithSource(department, title) {
  const stated = familyOf(department, null);
  if (stated) return { fam: stated, source: 'department' };
  const read = familyOf(null, title);
  if (read) return { fam: read, source: 'title' };
  return { fam: null, source: null };
}

// ---------------------------------------------------------------------------
// Region.
// ---------------------------------------------------------------------------

/** The two text tests every branch of the word list below is written in. */
function textTests(t) {
  return {
    has: (s) => t.includes(s),
    word: (w) => new RegExp('\\b' + w + '\\b').test(t)
  };
}

/**
 * The US sub-region a lowercased location names, or null when it names none.
 * Pulled out of regionOf so the country-first path (regionFor) can ask the
 * US question alone: regionOf also answers UK, EU, Canada and the rest, and a
 * posting whose country is already known to be the US must never be handed one
 * of those because a city shares a name with a European one ("London, Ohio").
 *
 * The three branches and their order are exactly what regionOf always had.
 */
function usSubRegionOf(t) {
  const { has, word } = textTests(t);
  if (has('san francisco') || word('sf') || has('foster city') || has('mountain view') ||
      has('seattle') || has('los angeles') || word('ca') || word('wa') || word('or')) return 'US West';
  if (has('new york') || has('nyc') || word('ny') || has('boston') || word('ma') ||
      has('washington') || word('dc') || has('atlanta') || has('miami')) return 'US East';
  if (has('austin') || word('tx') || has('chicago') || word('il') || has('denver') ||
      word('co') || has('texas')) return 'US Central';
  return null;
}

/**
 * The region a posted location falls in. A word list, in precedence order:
 * worldwide-remote first, then countries and regions, then US sub-regions,
 * then the bare-US catch-all. Anything unrecognised is 'Unknown'.
 *
 * THIS READS FREE TEXT AND NOTHING ELSE. It is the right tool for a location
 * string and the wrong one for an ISO 3166 code: it reads `CA` as California
 * and `US` as the catch-all, and does not know `GB`, `FR` or `DE` at all. The
 * ingest used to hand it the code first (regionOf(country || location)), which
 * is how every row whose upstream country was Canada came out as 'US West'.
 * Rows that carry a code go through regionFor() now; this stays the answer for
 * a row that carries only text.
 */
export function regionOf(locationText) {
  const t = String(locationText || '').toLowerCase();
  const { has, word } = textTests(t);
  if (has('remote') && (has('worldwide') || has('global') || has('anywhere'))) return 'Worldwide';
  if (has('united kingdom') || has('london') || has('england') || has('scotland') || word('uk')) return 'UK';
  if (has('ireland') || has('dublin') || has('spain') || has('germany') || has('berlin') ||
      has('france') || has('paris') || has('netherlands') || has('amsterdam') ||
      has('portugal') || has('lisbon') || has('europe') || word('eu')) return 'EU';
  if (has('canada') || has('toronto') || has('vancouver') || has('montreal')) return 'Canada';
  if (has('singapore') || has('tokyo') || has('sydney') || has('apac') ||
      has('bangalore') || has('india') || has('australia')) return 'APAC';
  if (has('mexico') || has('brazil') || has('argentina') || has('latam') || has('sao paulo')) return 'LATAM';
  const us = usSubRegionOf(t);
  if (us) return us;
  if (has('north america') || has('united states') || word('us') || has('remote')) return 'US West';
  return 'Unknown';
}

// The country sets behind regionFor. Every value they produce is a member of
// REGIONS; the Jobs Data page groups on those strings and a new one would be a
// bar with no label.
//
// EU is every member state, plus the rest of continental Europe. REGIONS has no
// separate "other Europe" value and regionOf already files the text "europe"
// under 'EU', so Switzerland, Norway and the like land there rather than in
// 'Unknown'. That is a geographic reading of the label, not a claim of
// membership, and it is the one place this table stretches a name.
const EU_MEMBERS = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE';
const OTHER_EUROPE = 'CH NO IS LI AD MC SM VA AL BA ME MK RS XK MD UA BY';
const APAC_COUNTRIES =
  'AU NZ JP KR KP CN HK MO TW SG MY TH VN ID PH IN PK BD LK NP BT MV MM KH LA BN MN FJ PG WS TO VU SB GU';
const LATAM_COUNTRIES =
  'MX BR AR CL CO PE UY PY BO EC VE GY SR GF CR PA GT HN SV NI BZ DO CU HT JM TT BS BB PR ' +
  'AG DM GD KN LC VC AW CW SX KY VG VI TC MS AI';

const REGION_OF_COUNTRY = new Map();
for (const [region, codes] of [
  ['EU', EU_MEMBERS], ['EU', OTHER_EUROPE], ['UK', 'GB'], ['Canada', 'CA'],
  ['APAC', APAC_COUNTRIES], ['LATAM', LATAM_COUNTRIES]
]) {
  for (const code of codes.split(' ')) REGION_OF_COUNTRY.set(code, region);
}

/**
 * Which US sub-region a state falls in, when the word list names none.
 *
 * THE CONVENTION IS TIME ZONES, and it is the only one that agrees with every
 * assignment the word list already makes: California, Washington and Oregon are
 * West; New York, Massachusetts and DC are East; Texas, Illinois and Colorado
 * are Central. So West is Pacific time plus Alaska and Hawaii, East is Eastern
 * time, and Central is everything on Mountain or Central time, Colorado
 * included. A state split by a zone line goes where most of its people are.
 * It is a convention and not a fact about the states; it exists so that
 * "Fort Stewart, Georgia" does not read as the West Coast because the word list
 * has no word for Georgia.
 */
const US_REGION_OF_STATE = {};
for (const [region, codes] of [
  ['US West', 'CA OR WA NV AK HI'],
  ['US East', 'ME NH VT MA RI CT NY NJ PA DE MD DC VA WV NC SC GA FL OH MI IN KY PR'],
  ['US Central', 'MT ID WY UT CO AZ NM ND SD NE KS OK TX MN IA MO AR LA WI IL MS AL TN']
]) {
  for (const code of codes.split(' ')) US_REGION_OF_STATE[code] = region;
}

/**
 * The region of one posting, as a function of the place it resolves to.
 *
 * ONE FACT, ONE DEFINITION. place_country and derived_region both answer
 * "where is this posting", and until 2026-10-02 they were computed by two
 * different rules: the place by placeOf(), the region by a word list over the
 * text whenever the crawl had no country. So 9,777 rows carried a resolved
 * country (DE, say) beside a region of 'Unknown'. The region is now read off
 * the same resolved place the place_* columns hold, and the word list is the
 * answer only when placeOf resolves no country at all.
 *
 * The country decides the bucket. Canada is Canada, Great Britain is UK,
 * France is EU, Japan is APAC, Brazil is LATAM, and a country on none of those
 * lists (Israel, South Africa, the UAE) is 'Unknown' rather than a guess.
 *
 * Only the US is split further, and it is split from the text: the word list
 * first, then the state the place parser found, then the bare-US catch-all.
 * THE US BRANCH CAN ONLY ANSWER A US REGION, and no other country can reach one
 * from a code or from two letters of text ("TX"). The one way a row carrying a
 * non-US code reaches a US region is placeOf()'s exception: when the string
 * spells out a different country in words ("Albuquerque, New Mexico" under an
 * upstream Mexico) the place, and so the region, follows the string. 167 of the
 * 5,960 non-US-coded rows on the local board (2026-10-02) are such rows, all of
 * them US places the crawl filed under another country.
 *
 * A row whose place has no country ('Remote', 'Worldwide', 'Multiple
 * Locations', a bare city nobody has said the country of) falls back to
 * regionOf() over the text, as the page always did.
 *
 * `place` is the one place the row reduces to (summaryOf, which for a one-place
 * row is placeOf()'s answer); derivedFor passes the one it already computed so
 * the text is parsed once. `country` is the crawl's column, which only matters
 * because placeOf reads it.
 */
export function regionFor(country, location, place) {
  const p = place || placeOf(location, country);
  if (!p.country) return regionOf(location);
  if (p.country !== 'US') return REGION_OF_COUNTRY.get(p.country) ?? 'Unknown';
  const fromText = usSubRegionOf(String(location || '').toLowerCase());
  if (fromText) return fromText;
  const fromState = p.admin1 ? US_REGION_OF_STATE[p.admin1] : undefined;
  return fromState || 'US West';
}

// ---------------------------------------------------------------------------
// Places.
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS. The board carries a location string on 99.5% of its rows and
// a resolved country on 40.3% (15,023 of 37,286 live rows, 2026-10-02), and the
// strings number 7,640 distinct. Country, state and city are what a search box
// and a "where" filter need, and region (above) is a lossy copy of them: five
// US buckets, one for all of Europe, nothing for the Middle East. placeOf()
// reads what the row already says and no more.
//
// NO GAZETTEER IS DOWNLOADED. Country names come from Intl.DisplayNames, which
// ships with the runtime. States and provinces are a hand table (the US, Canada
// and Australia, the three countries the board carries admin areas for). City
// to country is LEARNED from the rows whose upstream country is set, committed
// as src/data/place-cities.json by scripts/build-place-table.mjs, and measured
// on a held-out split there. A city this board never printed, in a country it
// never named, stays unresolved: null is an answer, a wrong country is not.

import PLACE_CITIES from '../data/place-cities.json' with { type: 'json' };

/**
 * ISO 3166-1 alpha-2, the 249 assigned codes plus XK (Kosovo, user assigned,
 * and used by every applicant system anyway). HAND LISTED, not read off
 * Intl.DisplayNames, because the runtime's list is CLDR's and CLDR keeps
 * deprecated codes alive for old data: it answers UK, AN, CS, DD, SU, YU and
 * about ten more as if they were countries, and `UK` is not one.
 */
const ISO_ALPHA2 =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT ' +
  'BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ' +
  'ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT ' +
  'HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS ' +
  'LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI ' +
  'NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG ' +
  'SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW';
const ISO_SET = new Set(ISO_ALPHA2.split(' '));

/** Every country code placeOf can return, for callers that need the set. */
export const ISO_COUNTRIES = Object.freeze([...ISO_SET]);

/**
 * The alpha-2 code in `value`, or null. `value` is the crawl's `country`
 * column, which holds a code, nothing, or the string 'remote_unresolved' (the
 * crawl's own "this is a remote posting and I could not place it"). Only a real
 * code is a fact about the posting; the other two are the absence of one.
 */
export function isoCountry(value) {
  const c = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return ISO_SET.has(c) ? c : null;
}

// Three letters, because several applicant systems print them ("Bengaluru,
// Karnataka, IND") and a three letter token is unambiguous in a way a two
// letter one is not. The countries a job board names; not every ISO entry.
const ALPHA3 = {
  AFG: 'AF', ALB: 'AL', DZA: 'DZ', AGO: 'AO', ARG: 'AR', ARM: 'AM', AUS: 'AU', AUT: 'AT', AZE: 'AZ',
  BHR: 'BH', BGD: 'BD', BLR: 'BY', BEL: 'BE', BOL: 'BO', BIH: 'BA', BRA: 'BR', BGR: 'BG', KHM: 'KH',
  CMR: 'CM', CAN: 'CA', CHL: 'CL', CHN: 'CN', COL: 'CO', CRI: 'CR', HRV: 'HR', CUB: 'CU', CYP: 'CY',
  CZE: 'CZ', DNK: 'DK', DOM: 'DO', ECU: 'EC', EGY: 'EG', SLV: 'SV', EST: 'EE', ETH: 'ET', FIN: 'FI',
  FRA: 'FR', GEO: 'GE', DEU: 'DE', GHA: 'GH', GRC: 'GR', GTM: 'GT', HND: 'HN', HKG: 'HK', HUN: 'HU',
  ISL: 'IS', IND: 'IN', IDN: 'ID', IRN: 'IR', IRQ: 'IQ', IRL: 'IE', ISR: 'IL', ITA: 'IT', JAM: 'JM',
  JPN: 'JP', JOR: 'JO', KAZ: 'KZ', KEN: 'KE', KOR: 'KR', KWT: 'KW', LVA: 'LV', LBN: 'LB', LTU: 'LT',
  LUX: 'LU', MYS: 'MY', MLT: 'MT', MEX: 'MX', MDA: 'MD', MAR: 'MA', NPL: 'NP', NLD: 'NL', NZL: 'NZ',
  NGA: 'NG', NOR: 'NO', OMN: 'OM', PAK: 'PK', PAN: 'PA', PRY: 'PY', PER: 'PE', PHL: 'PH', POL: 'PL',
  PRT: 'PT', PRI: 'PR', QAT: 'QA', ROU: 'RO', RUS: 'RU', SAU: 'SA', SRB: 'RS', SGP: 'SG', SVK: 'SK',
  SVN: 'SI', ZAF: 'ZA', ESP: 'ES', LKA: 'LK', SWE: 'SE', CHE: 'CH', TWN: 'TW', THA: 'TH', TUN: 'TN',
  TUR: 'TR', UKR: 'UA', ARE: 'AE', GBR: 'GB', USA: 'US', URY: 'UY', UZB: 'UZ', VEN: 'VE', VNM: 'VN',
  YEM: 'YE', ZWE: 'ZW', TZA: 'TZ', UGA: 'UG', SEN: 'SN', RWA: 'RW', MUS: 'MU', PRK: 'KP', MMR: 'MM',
  LAO: 'LA', MNG: 'MN', BRN: 'BN', MAC: 'MO', MKD: 'MK', MNE: 'ME', XKX: 'XK', BHS: 'BS', BRB: 'BB',
  TTO: 'TT', HTI: 'HT', NIC: 'NI', PSE: 'PS', SYR: 'SY', LBY: 'LY', SDN: 'SD', ZMB: 'ZM', MOZ: 'MZ',
  BWA: 'BW', NAM: 'NA', KGZ: 'KG', TJK: 'TJ', TKM: 'TM', FJI: 'FJ', PNG: 'PG'
};

/**
 * Fold a string to the form every lookup here is keyed on: accents and case
 * gone, "&" read as "and", everything else that is not a letter or digit a
 * single space. "Montréal", "MONTREAL" and "Montreal" are one key, and so are
 * "U.S.A." and "U S A".
 */
function fold(s) {
  const t = String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u00f8\u00e6\u0153\u00df\u0111\u0142\u0131]/g, (c) =>
      ({ '\u00f8': 'o', '\u00e6': 'ae', '\u0153': 'oe', '\u00df': 'ss', '\u0111': 'd', '\u0142': 'l', '\u0131': 'i' })[c]);
  return t.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** English country names, from the runtime, with the few that read badly
 *  as printed ("Hong Kong SAR China", "Myanmar (Burma)") replaced. */
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const NAME_OVERRIDES = { HK: 'Hong Kong', MO: 'Macao', MM: 'Myanmar', CD: 'Congo (Kinshasa)', CG: 'Congo (Brazzaville)' };

/** The English name of an ISO country code, or null for anything else. */
export function countryName(code) {
  const c = isoCountry(code);
  if (c === null) return null;
  return NAME_OVERRIDES[c] || REGION_NAMES.of(c);
}

// What a country is called in free text. The runtime's English names first,
// then the aliases a job board actually prints: abbreviations, the home nations
// that are not ISO countries, the local spelling the applicant system used
// ("Nederland", "Deutschland", "Polska") and a handful of French and German
// exonyms. Matching is on the folded form, so accents and case cost nothing.
const COUNTRY_BY_NAME = new Map();
for (const code of ISO_SET) COUNTRY_BY_NAME.set(fold(countryName(code)), code);
// BA is "Bosnia & Herzegovina" to the runtime and "Bosnia" to the five live
// postings that name it (2026-10-02): the short form is the one printed.
const COUNTRY_ALIASES = {
  BA: ['Bosnia'],
  GB: ['UK', 'U.K.', 'United Kingdom', 'Great Britain', 'Britain', 'England', 'Scotland', 'Wales',
       'Northern Ireland', 'Royaume-Uni'],
  US: ['US', 'U.S.', 'USA', 'U.S.A.', 'United States of America', 'United States', 'Etats-Unis'],
  DE: ['Deutschland', 'Allemagne'], ES: ['Espana', 'Espagne'], BR: ['Brasil'],
  NL: ['Nederland', 'Holland', 'The Netherlands', 'Pays-Bas'],
  CH: ['Schweiz', 'Suisse', 'Svizzera'], AT: ['Osterreich'], SE: ['Sverige'], NO: ['Norge'],
  DK: ['Danmark'], FI: ['Suomi'], PL: ['Polska'], IT: ['Italia', 'Italie'], IE: ['Eire', 'Republic of Ireland', 'Irlande'],
  BE: ['Belgie', 'Belgique', 'Belgien'], LU: ['Luxemburg'], CZ: ['Czech Republic', 'Cesko'], HU: ['Magyarorszag'],
  RO: ['Romania'], TR: ['Turkey', 'Turkiye'], KR: ['Korea', 'Republic of Korea'], HK: ['Hong Kong'], MO: ['Macau'],
  AE: ['UAE', 'U.A.E.'], CI: ['Ivory Coast'], MX: ['Mexico'], PT: ['Portugal'], FR: ['France'],
  VN: ['Viet Nam'], RU: ['Russian Federation'], MM: ['Burma'], PS: ['Palestine'], CD: ['DR Congo', 'DRC']
};
for (const [code, names] of Object.entries(COUNTRY_ALIASES)) {
  for (const n of names) COUNTRY_BY_NAME.set(fold(n), code);
}
for (const [alpha3, code] of Object.entries(ALPHA3)) {
  if (!ISO_SET.has(code)) throw new Error(`jobs-derived: ALPHA3 ${alpha3} maps to ${code}, which is not an ISO code`);
}
// Two names the runtime gives to countries are also the name of a US place a
// posting is far more likely to mean. "Georgia" is the state until a city the
// table knows says otherwise, and Puerto Rico is a US area with its own code
// in the state list below, so neither is read as a country from text. A row
// whose upstream country IS 'GE' or 'PR' is still believed.
COUNTRY_BY_NAME.delete('georgia');
COUNTRY_BY_NAME.delete('puerto rico');

// Admin areas. These are the countries the board carries a state or province
// for, hand listed. A code means the same thing as its name and the two are
// kept together so neither can be added without the other.
const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico'
};
const CA_PROVINCES = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut',
  ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon'
};
// Australia's two letter codes (SA, WA, NT) collide with Washington and the
// Northwest Territories, and the three letter ones do not, so only the three
// letter codes are read; the two letter states are read by name.
const AU_STATES = {
  NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', SA: 'South Australia',
  WA: 'Western Australia', TAS: 'Tasmania', ACT: 'Australian Capital Territory', NT: 'Northern Territory'
};

const ADMIN_BY_CODE = new Map();
const ADMIN_BY_NAME = new Map();
for (const [country, table, codesToo] of [
  ['US', US_STATES, true], ['CA', CA_PROVINCES, true], ['AU', AU_STATES, false]
]) {
  for (const [code, name] of Object.entries(table)) {
    // First country listed wins a shared two letter code: WA is Washington,
    // NT is the Northwest Territories.
    if (codesToo || code.length === 3) {
      if (!ADMIN_BY_CODE.has(code)) ADMIN_BY_CODE.set(code, { country, code });
    }
    if (!ADMIN_BY_NAME.has(fold(name))) ADMIN_BY_NAME.set(fold(name), { country, code });
  }
}
ADMIN_BY_NAME.set('d c', { country: 'US', code: 'DC' });
ADMIN_BY_NAME.set('washington dc', { country: 'US', code: 'DC' });

/**
 * The admin tables and the country aliases above this line, which a reader of
 * the board needs from OUTSIDE this file, exported read-only
 * (src/lib/search-lexicon.ts). placeOf() stores an
 * admin area as its CODE ("MD", "ON", "NSW") in jobs.place_admin1, and the
 * search box has to turn that back into the name a person types ("maryland"),
 * for exactly the three countries this file reads admin areas for. The country
 * aliases are the other half: "UK", "Deutschland" and "Holland" are what a
 * reader types for GB, DE and NL, and they are listed once, here, because this
 * is where free text is already read as a country.
 *
 * FROZEN COPIES, not the tables themselves, so a caller cannot edit the
 * vocabulary placeOf() reads. No behaviour here: nothing in this file reads
 * these two exports.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const ADMIN_NAMES = Object.freeze({
  US: Object.freeze({ ...US_STATES }),
  CA: Object.freeze({ ...CA_PROVINCES }),
  AU: Object.freeze({ ...AU_STATES })
});
/** The aliases half of the pair above: ISO code to the names it is printed under.
 *  @type {Readonly<Record<string, readonly string[]>>} */
export const COUNTRY_ALIAS_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(COUNTRY_ALIASES).map(([code, names]) => [code, Object.freeze([...names])]))
);

// Countries that print their state or province as a code in the label.
const ADMIN_IN_LABEL = new Set(['US', 'CA', 'AU']);

/** Words that say how a job is worked, not where. Stripped before parsing, so
 *  "Remote (United States)", "US Remote" and "Hybrid - Austin" all reduce to
 *  the place. */
const ARRANGEMENT =
  /\b(?:remote|hybrid|on[\s-]?site|in[\s-]?office|office|hq|headquarters|wfh|telecommute|home\s?office|homeoffice|distributed|flexible|virtual|within)\b/gi;
const ARRANGEMENT_ONLY =
  /^(?:(?:remote|hybrid|on[\s-]?site|in[\s-]?office|office|hq|headquarters|wfh|flexible|virtual|or|and|\/|,|-)\s*)+$/i;

/** Tokens that carry no place at all. "Worldwide" and its kin are here on
 *  purpose: they are a fact about the job, not a country, and the row that
 *  prints only them has no place to resolve.
 *
 *  THE SECOND HALF IS THE REGION WORDS (2026-10-02), and they are here because a
 *  list made them places. "Europe" is not a city and not a country, but read as a
 *  token of "United States / Canada / London / Europe" it was the one unknown word
 *  in the string, and the old reader took the first such word for the city: the
 *  board carried cities called Europe, Apac and All France. A region is a fact
 *  about the job, like "Worldwide", so it is noise. The entries are the FOLDED
 *  spellings, because fold() turns a hyphen into a space: "Asia-Pacific" arrives
 *  here as 'asia pacific' and "Ile-de-France" as 'ile de france'. */
const NOISE = new Set([
  'unavailable', 'various', 'multiple', 'multiple locations', 'location negotiable after selection',
  'tbd', 'tba', 'na', 'n a', 'anywhere', 'worldwide', 'global', 'international', 'nationwide', 'job', 'jobs',
  'location', 'locations', 'within', 'based', 'area', 'metro', 'and', 'or', 'the', 'freelance',
  'europe', 'eu', 'european union', 'emea', 'apac', 'asia pacific', 'latam', 'latin america', 'americas',
  'north america', 'south america', 'asia', 'nordics', 'dach', 'benelux', 'middle east', 'mena', 'africa',
  'ile de france', 'deutschlandweit'
]);

/** The key a city is stored under in src/data/place-cities.json, so the builder
 *  and the reader fold names the same way. What it drops is what makes two
 *  spellings one place: "San Francisco Bay Area" is San Francisco for a facet,
 *  and "Greater Boston" is Boston. */
export function cityKey(raw) {
  const k = fold(raw).replace(/ (?:bay area|metro area|metropolitan area|area|metro)$/, '').replace(/^greater /, '');
  return Object.hasOwn(CITY_ALIASES, k) ? CITY_ALIASES[k] : k;
}

/** The table entry for a city as printed, or undefined. Own keys only: a place
 *  string is free text, and "constructor" must not find Object's. */
function cityOf(cities, raw) {
  const key = cityKey(raw);
  return Object.hasOwn(cities, key) ? cities[key] : undefined;
}
const CITY_ALIASES = {
  sf: 'san francisco', nyc: 'new york', 'new york city': 'new york', munchen: 'munich', koln: 'cologne',
  wien: 'vienna', goteborg: 'gothenburg', bangalore: 'bengaluru'
};
/** The same table, read-only, for src/lib/search-lexicon.ts: what a reader types
 *  ("nyc", "munchen") against the folded city name placeOf stores it under. A
 *  frozen copy, so the search box cannot edit what the ingest reads.
 *  @type {Readonly<Record<string, string>>} */
export const CITY_ALIAS_NAMES = Object.freeze({ ...CITY_ALIASES });

/**
 * One learned city: its display name, the country (and state, where the parser
 * reads states for that country) it belongs to, and the rows behind it.
 * @typedef {{ city: string, country: string, admin1: string|null, n?: number }} CityEntry
 * @typedef {Record<string, CityEntry>} CityTable
 */

/** The city table, keyed by cityKey(). @type {CityTable} */
const CITIES = PLACE_CITIES.cities;

/** True when a token reads as a place name rather than an address, a postal
 *  code, an upper case code or a sentence. */
function cityLike(raw) {
  if (Object.hasOwn(CITY_ALIASES, fold(raw))) return true;
  if (/\d/.test(raw) || raw.length < 2 || raw.length > 40) return false;
  // A sentence fragment, not a name: "BC & ON only", "EST Timezone Only",
  // "Remote-UK&I", "Germany & Netherlands". Each was a city of its own.
  if (/[!?&@#]|\bonly\b|\btime ?zone\b/i.test(raw)) return false;
  if (raw.split(/\s+/).length > 5) return false;
  if (/^[A-Z]{2,3}$/.test(raw)) return false;
  return /[A-Za-z\u00c0-\u024f]/.test(raw);
}

/** A city as printed, tidied: an all upper case name is title cased, nothing
 *  else is touched. */
function tidyCity(raw) {
  const t = raw.replace(/\s+/g, ' ').trim();
  return t === t.toUpperCase() && t.length > 3 ? t.toLowerCase().replace(/(^|[\s-])(\S)/g, (_, a, b) => a + b.toUpperCase()) : t;
}

/** One token of a place string, read for what it is. */
function classify(piece) {
  const raw = piece
    .replace(ARRANGEMENT, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-:.]+|[\s\-:]+$/g, '')
    .replace(/\s+(?:metro|metro area|metropolitan area)$/i, '');
  if (!raw) return null;
  const f = fold(raw);
  // A state code is read before the noise words: "OR" is Oregon in "Bend, OR"
  // and only a conjunction in lower case.
  if (/^[A-Z]{2}$/.test(raw) && ADMIN_BY_CODE.has(raw)) {
    // A code that is ALSO a country ("DE", "IN", "CA", "PA") is a state by
    // default and is looked at again in readPart, where the city is known.
    return { kind: 'admin', raw, ...ADMIN_BY_CODE.get(raw), alsoCountry: ISO_SET.has(raw) ? raw : null };
  }
  if (!f || NOISE.has(f) || /^\d+ locations?$/.test(f)) return { kind: 'noise' };
  // "EMEA Region", "Company Wide": a scope, whatever word comes before it.
  if (/ (?:region|wide)$/.test(f)) return { kind: 'noise' };
  // "Anywhere in France", "All France", "Across Spain", "Throughout Belgium": the
  // words in front only widen the scope, so what follows is read on its own, and
  // only when it is a country or a state ("All Hands" is not one). 82 live rows
  // print one of these (2026-10-02), and "All France" was a city on the board.
  const widened = /^(?:anywhere in|all|across|throughout)\s+(.+)$/i.exec(raw);
  if (widened) {
    const inner = classify(widened[1]);
    if (inner && (inner.kind === 'country' || inner.kind === 'admin')) return inner;
  }
  if (/^[A-Z]{3}$/.test(raw)) {
    if (ADMIN_BY_CODE.has(raw)) return { kind: 'admin', raw, ...ADMIN_BY_CODE.get(raw) };
    if (ALPHA3[raw]) return { kind: 'country', raw, code: ALPHA3[raw] };
  }
  const cc = COUNTRY_BY_NAME.get(f);
  if (cc) return { kind: 'country', raw, code: cc };
  // A two letter code that is not a state or a province can only be a country:
  // "Cape Town, ZA", "Kings Langley, GB", "Baghdad, IQ".
  if (/^[A-Z]{2}$/.test(raw) && ISO_SET.has(raw)) return { kind: 'country', raw, code: raw };
  const ad = ADMIN_BY_NAME.get(f);
  if (ad) return { kind: 'admin', raw, ...ad };
  return { kind: 'other', raw };
}

/** Normalise a location string before it is split: dashes, quotes, the two
 *  spellings that carry a comma inside a name, and parentheses (a group that
 *  only says how the job is worked vanishes, any other becomes a part). */
function cleanText(location) {
  return String(location ?? '')
    .normalize('NFC')
    .replace(/[\u00a0\u2009\u202f]/g, ' ')
    .replace(/[\u2013\u2014\u2212]/g, ' - ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\bKorea,\s*Republic of\b/gi, 'South Korea')
    // "AZ-Phoenix", "WI-Hales Corner": a state code stuck to its city with a
    // hyphen, which reads as one unrecognisable token unless it is turned round.
    .replace(/\b([A-Z]{2})-([A-Z][A-Za-z .'-]+)/g, (m, st, city) => (ADMIN_BY_CODE.has(st) ? `${city}, ${st}` : m))
    .replace(/\bwashington,?\s+d\.?\s?c\b\.?/gi, 'Washington, DC')
    // "Capelle a/d IJssel" (17 rows) is a Dutch name with a slash inside it, and
    // "Frankfurt / Main" is the one German city that is written with a spaced
    // slash; both would otherwise be split into two places by PART_SPLIT below.
    .replace(/\ba\/d\b/g, 'aan den')
    .replace(/\bFrankfurt\s*\/\s*Main\b/gi, 'Frankfurt am Main')
    .replace(/\(([^)]*)\)/g, (_, inner) => (ARRANGEMENT_ONLY.test(inner.trim()) ? ' ' : ', ' + inner + ', '));
}

// Several places in one string are separated by a bullet, a slash, a
// semicolon, a pipe or the word "or"; the pieces of one place by a comma or a
// spaced hyphen.
const PART_SPLIT = /\s*[\u2022|;/]\s*|\s+or\s+/i;
const TOKEN_SPLIT = /\s*,\s*|\s+-\s+/;

/**
 * "Hamburg-Germany", "Barcelona- Spain": a city and its country joined by a
 * hyphen, which TOKEN_SPLIT only splits when the hyphen has a space on BOTH
 * sides. Turned into "Hamburg, Germany" when what follows the last hyphen is a
 * country, and only when the hyphen has a space on one side or the head is a
 * city the table knows: "Ile-de-France" must stay one name, and "Timor-Leste"
 * and "Winston-Salem" are not a city and a country. Applied to each piece after
 * PART_SPLIT, so a slash list is split first.
 */
function splitCountryTail(piece, cities) {
  return piece.replace(/^(.*\p{L}\.?)(\s*)-(\s*)(\p{L}[\p{L} ]*)$/u, (m, head, before, after, tail) =>
    classify(tail)?.kind === 'country' && (before || after || cityOf(cities, head.trim())) ? `${head}, ${tail}` : m);
}

/**
 * Read ONE place out of a string that names one: its country, state, city, and
 * whether the text itself carried a country.
 *
 * Tokens are classified (country, state or province, other, noise) and then
 * reconciled, because the same word means different things by position. Only
 * the LAST state-like token is the state: "New York, New York" and "Indiana,
 * Pennsylvania" name a city first. A country-like token to the LEFT of a state
 * of another country is a city ("Lebanon, New Hampshire", "Jordan, Minnesota").
 * A state that belongs to a country other than the one stated is dropped.
 *
 * `upstream` is a valid ISO code or null, and when it is present it is the
 * country: it is the stronger fact. `cities` is the learned table; it picks the
 * city among several candidates and fills in the state when the city has one
 * state in the data. With no state and no country on the page, a city counts
 * ONLY if the table knows it, because a bare token with nothing around it is
 * as likely to be "Bashor Campus" as a place.
 */
function readPart(part, upstream, cities) {
  const toks = [];
  for (const piece of part.split(TOKEN_SPLIT)) {
    const t = classify(piece);
    if (t && t.kind !== 'noise') toks.push(t);
  }
  if (toks.length === 0) return null;

  // "Markham, ON, CA": a province code followed by CA is a Canadian address
  // ending in its country code. Everywhere else a two letter token in free text
  // is a US state (ON is never one, so the pair settles it), which is the one
  // place that rule would be plainly wrong.
  const last = toks.length - 1;
  if (last > 0 && toks[last].raw === 'CA' && toks[last].kind === 'admin' &&
      toks[last - 1].kind === 'admin' && toks[last - 1].country === 'CA') {
    toks[last] = { kind: 'country', raw: 'CA', code: 'CA', weak: true };
  }

  // A code that is both a state (or a province) and a country, and a city the
  // table has learned in that COUNTRY: "Berlin, DE" is Germany, because Berlin
  // is German on this board and the string says DE. Anything the table does not
  // know stays a state ("Dover, DE" is Delaware, "San Francisco, CA" is
  // California), which is what these codes overwhelmingly are in free text.
  //
  // Two signals agreeing, a learned city and a code, is evidence in full: it
  // outranks an upstream country that read the code as a state. The crawl has
  // 69 rows like "Bengaluru, UNAVAILABLE, IN" and "Stuttgart, DE" filed under
  // the US (2026-10-02), which is Indiana and Delaware read off an Indian and a
  // German city.
  toks.forEach((t, i) => {
    if (t.kind !== 'admin' || !t.alsoCountry) return;
    const learned = toks.some((o) => o !== t && o.kind !== 'country' && o.raw.length > 2 &&
      cityOf(cities, o.raw)?.country === t.alsoCountry);
    if (learned) toks[i] = { kind: 'country', raw: t.raw, code: t.alsoCountry };
  });

  // "Dallas, TX, Chicago, IL, Columbus, OH": two or more state CODES in one
  // comma list is a list of places, not one place with a state. There is no
  // telling which city goes with which code from here, so the answer is the
  // country they agree on and nothing finer.
  const codeAdmins = toks.filter((t) => t.kind === 'admin' && t.raw.length === 2);
  if (codeAdmins.length >= 2) {
    // A country named in the same list counts too: "Buffalo, NY, Cincinnati, OH,
    // Petrolia, Canada" is two countries, so it is none.
    const lands = [...new Set([...codeAdmins.map((t) => t.country), ...toks.filter((t) => t.kind === 'country').map((t) => t.code)])];
    const text = lands.length === 1 ? lands[0] : null;
    return { country: upstream || text, admin1: null, city: null, textCountry: text, strong: null, weak: true, listed: true };
  }

  // A lone token that names a state AND a city the table knows is the city:
  // "New York" and "Washington" on their own are the places people mean, and
  // the table says which state they are in.
  if (toks.length === 1 && toks[0].kind === 'admin' && cityOf(cities, toks[0].raw)) toks[0].kind = 'other';

  // The state is the last state-like token, and when the country is already
  // known it is the last one that BELONGS to that country: "UNAVAILABLE, BC,
  // CA" under an upstream Canada is British Columbia, and the "CA" is a US
  // state code that has nothing to say about it. Any other state-like token is
  // a city that shares a name with one ("New York, New York", "Indiana,
  // Pennsylvania").
  let lastAdmin = -1;
  toks.forEach((t, i) => { if (t.kind === 'admin' && (!upstream || t.country === upstream)) lastAdmin = i; });
  if (lastAdmin < 0) toks.forEach((t, i) => { if (t.kind === 'admin') lastAdmin = i; });
  toks.forEach((t, i) => {
    if (t.kind === 'admin' && i !== lastAdmin) t.kind = /^[A-Z]{2,3}$/.test(t.raw) ? 'noise' : 'other';
  });
  // A country-like token to the LEFT of a state of another country is a city:
  // "Lebanon, New Hampshire", "Jordan, Minnesota", "Peru, Illinois".
  if (lastAdmin >= 0) {
    toks.forEach((t, i) => {
      if (t.kind === 'country' && i < lastAdmin && t.code !== toks[lastAdmin].country) t.kind = 'other';
    });
  }
  const countries = [...new Set(toks.filter((t) => t.kind === 'country').map((t) => t.code))];
  if (countries.length > 1) {
    // "Argentina, Brazil, Chile, ...": a list of countries is not a place.
    return { country: upstream, admin1: null, city: null, textCountry: null, strong: null, weak: false, listed: true };
  }
  let admin = lastAdmin >= 0 && toks[lastAdmin].kind === 'admin' ? toks[lastAdmin] : null;
  // Read before the upstream country gets a chance to demote the state below:
  // "New Mexico" under an upstream Mexico is exactly the case it proves.
  const strongAdmin = admin && admin.raw.length !== 2 && toks.length >= 2 && admin.raw.toLowerCase() !== 'georgia'
    ? admin.country : null;
  const statedCountry = countries[0] || null;
  if (admin && statedCountry && admin.country !== statedCountry) {
    admin.kind = /^[A-Z]{2,3}$/.test(admin.raw) ? 'noise' : 'other';
    admin = null;
  }
  const textCountry = statedCountry || (admin ? admin.country : null);
  const country = upstream || textCountry;
  if (admin && country && admin.country !== country) {
    // A state of some other country than the one we are going with ("San
    // Francisco, CA" under an upstream Canada). Only a code is dropped; a name
    // may still be a city.
    admin.kind = /^[A-Z]{2,3}$/.test(admin.raw) ? 'noise' : 'other';
    admin = null;
  }

  const anchors = [];
  toks.forEach((t, i) => { if (t.kind === 'country' || t.kind === 'admin') anchors.push(i); });

  // How much the text itself proves about the country. A country NAME, or a
  // state spelled out, is strong: "New Mexico" is not Mexico and "Sydney, New
  // South Wales" is not the UK. A two letter code that could be a state ("DE",
  // "IN", "AL", "TX") is weak: it is a state in one reading and a country in
  // the other, and nothing here can tell which. A code that can only be a
  // country ("GB", "ZA"), or that a learned city has settled as one, is a
  // country. A lone "Georgia" or "Victoria" is as likely the country or the BC
  // city as the state. Weak evidence never overrides an upstream country;
  // strong evidence does.
  const strongTok = toks.find((t) => t.kind === 'country' && !t.weak);
  const strong = strongTok ? strongTok.code : strongAdmin;
  // The only anchors are bare two letter codes: the row says almost nothing.
  const weak = anchors.length > 0 && anchors.every((i) => toks[i].kind === 'admin' && toks[i].raw.length === 2);

  const candidates = [];
  toks.forEach((t, i) => { if (t.kind === 'other' && cityLike(t.raw)) candidates.push({ t, i }); });

  // Two cities the table knows, and different ones ("Barcelona, Berlin"), are a
  // list. The country is the one they share, if they share one.
  const hits = candidates.filter((c) => cityOf(cities, c.t.raw));
  if (new Set(hits.map((c) => cityKey(c.t.raw))).size >= 2) {
    const lands = [...new Set(hits.map((c) => cityOf(cities, c.t.raw).country))];
    const text = statedCountry || (lands.length === 1 ? lands[0] : null);
    return { country: upstream || text, admin1: null, city: null, textCountry: text, strong: null, weak: false, listed: true };
  }

  // Which candidate is the city. One the table knows wins outright. Otherwise
  // it is positional: with a state on the page, the token just before it
  // ("Portsmouth" in "Naval Medical Center, Portsmouth, Virginia"); with only a
  // country, the first token ("Amsterdam" in "Amsterdam, Noord-Holland,
  // Nederland", where the middle one is a province this table does not hold);
  // with the country or state FIRST ("Japan - Tokyo", "US, CA, Santa Clara") the
  // first token after it; and with nothing around it, the first token.
  let chosen = candidates.find((c) => cityOf(cities, c.t.raw)) || null;
  if (!chosen && candidates.length) {
    if (anchors.length === 0) chosen = candidates[0];
    else if (anchors[0] === 0) chosen = candidates.find((c) => c.i > anchors[anchors.length - 1]) || null;
    else if (admin) {
      const before = candidates.filter((c) => c.i < toks.indexOf(admin));
      chosen = before.length ? before[before.length - 1] : null;
    } else chosen = candidates.find((c) => c.i < anchors[0]) || null;
  }

  const entry = chosen ? cityOf(cities, chosen.t.raw) || null : null;
  let resolvedCountry = country;
  let admin1 = admin && admin.country === country ? admin.code : null;
  if (!resolvedCountry && entry) resolvedCountry = entry.country;
  if (entry && !admin1 && entry.country === resolvedCountry) admin1 = entry.admin1 || null;
  const named = chosen ? (entry ? entry.city : tidyCity(chosen.t.raw)) : null;
  return {
    country: resolvedCountry || null,
    admin1: resolvedCountry ? admin1 : null,
    city: resolvedCountry ? named : null,
    // The city this part names even when no country settled, so that a list
    // ("Baghdad/Erbil, IQ") cannot lend one part's city to the whole string.
    named,
    textCountry,
    strong,
    weak
  };
}

/**
 * The structural read of a whole location string: one result per place named,
 * merged. Several places agree on a country only when every one that resolved
 * names the same one; they agree on a state or a city only when every place
 * names the same one. Anything else is left null rather than picked.
 *
 * Exported because scripts/build-place-table.mjs learns the city table from the
 * same parse the table is later read through, so the two cannot disagree about
 * what the city token of a string is. Callers that want an answer use placeOf.
 */
export function readPlace(/** @type {unknown} */ location, /** @type {unknown} */ upstream, /** @type {CityTable} */ cities = CITIES) {
  const up = isoCountry(upstream);
  const pieces = cleanText(location).split(PART_SPLIT).map((p) => splitCountryTail(p, cities));
  const read = (country) => pieces.map((p) => readPart(p, country, cities)).filter(Boolean);
  let parts = read(up);
  let overrode = false;
  if (parts.length === 0) {
    return { country: up, admin1: null, city: null, textCountry: null, parts: 0 };
  }
  // THE ONE PLACE THE CRAWL'S COUNTRY IS NOT BELIEVED. A string whose own text
  // states a different country beats the code: a country name, a state written
  // in full, a code that can only be a country ("ZA"), or a code that could be
  // a state together with a city learned in that country ("Berlin, DE"). Every
  // place the string names that proves anything must prove the SAME country. The crawl's resolver has put "Albuquerque, New
  // Mexico" under Mexico (140 rows), "Sydney, New South Wales" under the UK (36)
  // and "Melbourne, Victoria" under Canada (21): the string is right and the
  // code is the leftover of a substring match. A two letter code that could be
  // a state never overrides (see readPart), and a string that names two
  // countries ("United States / Canada") proves neither.
  if (up && !parts.some((p) => p.listed)) {
    const proven = [...new Set(parts.map((p) => p.strong).filter(Boolean))];
    if (proven.length === 1 && proven[0] !== up) {
      parts = read(null);
      overrode = true;
    }
  }
  const textCountries = [...new Set(parts.map((p) => p.textCountry).filter(Boolean))];
  const textCountry = textCountries.length === 1 ? textCountries[0] : null;
  if (parts.length === 1) return { ...parts[0], textCountry, parts: 1, overrode };
  // A part that names no city does not contradict one that does: "San
  // Francisco, CA / Remote, USA" is San Francisco. Two parts that name
  // different cities are a list, and the answer is null. A part counts as
  // naming a city even when no country settled for it, so "Baghdad/Erbil, IQ"
  // is Iraq and not Erbil.
  const names = [...new Set(parts.map((p) => p.named).filter(Boolean))];
  const countrySet = [...new Set(parts.map((p) => p.country).filter(Boolean))];
  const country = (overrode ? null : up) || (countrySet.length === 1 ? countrySet[0] : null);
  // A part that names a city but no state counts against a state another part
  // names: "London / Europe / Toronto" under Canada is not Ontario.
  const adminVals = [...new Set(parts.map((p) => p.admin1 || (p.named ? 'none:' + p.named : null)).filter(Boolean))];
  const admin1 = adminVals.length === 1 && !adminVals[0].startsWith('none:') ? adminVals[0] : null;
  return {
    country,
    admin1: country ? admin1 : null,
    city: country && names.length === 1 ? names[0] : null,
    textCountry,
    parts: parts.length,
    overrode
  };
}

/** @typedef {{ country: string|null, admin1: string|null, city: string|null, label: string|null }} Place */

/**
 * The place a posting names: ISO country, state or province code, city, and
 * the label a reader sees.
 *
 *   placeOf('Austin, TX', null)           -> US / TX / Austin / "Austin, TX"
 *   placeOf('Vancouver, BC', 'CA')        -> CA / BC / Vancouver / "Vancouver, BC"
 *   placeOf('Bangalore, India', null)     -> IN / null / Bangalore / "Bangalore, India"
 *   placeOf('Remote', 'remote_unresolved') -> all null
 *
 * `country` is the crawl's column. A valid code in it is believed. Two letters
 * in free text are read by what they can be:
 *   - a code that is only a country ("ZA", "GB", "IQ") is that country;
 *   - a code that is only a state or province ("TX", "ON") is that state;
 *   - a code that is BOTH ("DE": Delaware or Germany; "CA", "IN", "PA", "AL",
 *     "MA" and the rest, computed as the intersection of the state lists and
 *     the ISO list) is the country when the city table has learned the city in
 *     that country ("Berlin, DE"), and otherwise the state ("Dover, DE", "San
 *     Francisco, CA"), because on this board that is what it overwhelmingly is.
 * A string that names no country, no state and no city the table knows
 * resolves to nothing, and so does a string that names several places in
 * several countries: those are a gap in what the employer printed, and the
 * page shows a gap.
 *
 * THIS IS THE ONE-PLACE READING. A string that lists several places is read by
 * placesOf() below, which finds every one of them; the place_* columns are
 * summaryOf() of that, and are this function's answer exactly for a string
 * with one place.
 *
 * City and state are returned only alongside a country. A city with no country
 * is a guess about a word, and a facet built on it would count "Bashor Campus".
 *
 * @param {string|null|undefined} location
 * @param {string|null|undefined} country
 * @param {CityTable} [cities] the learned city table; the committed one unless a
 *   test or the table builder passes its own
 * @returns {Place}
 */
export function placeOf(location, country, cities = CITIES) {
  const r = readPlace(location, country, cities);
  if (!r.country) return { country: null, admin1: null, city: null, label: null };
  const city = r.city || null;
  const admin1 = r.admin1 || null;
  return { country: r.country, admin1, city, label: placeLabel(r.country, admin1, city) };
}

/** "City, ADMIN" for the countries that print one, "City, Country" for the
 *  rest, the country alone when there is no city. */
function placeLabel(country, admin1, city) {
  const name = countryName(country);
  if (!city) return name;
  if (admin1 && ADMIN_IN_LABEL.has(country)) return `${city}, ${admin1}`;
  return `${city}, ${name}`;
}

// ---------------------------------------------------------------------------
// Every place a posting lists.
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS (2026-10-02, owner decision, report decision 8, option B). A
// posting that lists several places is found under EACH of them, and each
// place's count includes it. placeOf() above answers a different question, "the
// ONE place this row reduces to", and for a list it had to pick: it took the
// upstream country, which is the crawl's choice of one place from the list, and
// the one city the list names. On the local board (37,286 live rows) that was
// wrong for 24 of the 99 " / " lists that were given a city ("London, Canada"
// for London, UK; "New York, Canada"; a city called "Europe"), and a job
// listing London and Berlin was found under neither city.
//
// THE TWO ANSWERS ARE ONE DEFINITION. placesOf() reads the list; summaryOf()
// reduces it to the single place the place_country, place_admin1, place_city and
// place_label columns hold, and derived_region is read off that. So the columns
// a reader of one place sees and the keys a reader of every place filters on come
// out of one call and cannot disagree. A string with one place never takes the
// list path: it is placeOf()'s answer, unchanged by construction, except where
// the token rules above change what a token is (177 rows, every one a junk city
// removed or a city found).

/**
 * The keys one place answers to, most general first: the country, the country
 * and state, the country and city (the state left open: "Baltimore, any state"),
 * and the country, state and city. These are exactly the `place=` values the
 * board accepts (GB, US-MD, GB/London, US-MD/Baltimore; src/lib/place-key.ts owns
 * that grammar, and is TypeScript that imports this file, so the shape is
 * written here again and a test holds the two to each other).
 *
 * Every level is a key so that a filter at any level is one array-contains probe,
 * and `US/Baltimore` is there so that a bookmarked address that means "Baltimore,
 * any state" keeps meaning it.
 *
 * @param {{ country: string, admin1: string|null, city: string|null }} place
 * @returns {string[]}
 */
export function placeKeysOf(place) {
  const keys = [place.country];
  if (place.admin1) keys.push(`${place.country}-${place.admin1}`);
  if (place.city) {
    keys.push(`${place.country}/${place.city}`);
    if (place.admin1) keys.push(`${place.country}-${place.admin1}/${place.city}`);
  }
  return keys;
}

/** A place found in a list: always has a country, unlike Place, whose country is
 *  null for a posting that names none.
 *  @typedef {{ country: string, admin1: string|null, city: string|null, label: string }} ListedPlace */

/** The most specific key of a place: what a place is counted under when each
 *  place is counted once (`US-MD/Baltimore`, `GB/London`, `GB`).
 *  @param {{ country: string, admin1: string|null, city: string|null }} place
 *  @returns {string} */
export function placeLeafOf(place) {
  return /** @type {string} */ (placeKeysOf(place).at(-1));
}

/** A word that is a state or a country by name and a place a person means by
 *  another reading: a lone "Georgia" in a list is as likely the country as the
 *  state, and a lone "Victoria" the London station as the Australian state. */
const LONE_AMBIGUOUS = new Set(['georgia', 'victoria']);

/** The tokens of one comma list, classified, with the noise gone. */
function listTokens(piece) {
  return piece.split(TOKEN_SPLIT).map((raw) => ({ raw, t: classify(raw) })).filter((x) => x.t && x.t.kind !== 'noise');
}

/**
 * The places ONE comma list names, once readPart has called it a list
 * ("Chicago, IL, Evanston, IL"; "Argentina, Brazil, Chile"; "Barcelona, Berlin").
 * Empty when it names none this can place, and the caller then falls back to
 * the country readPart found.
 *
 * Four rules, in this order, because the first two decide what a two letter code
 * IS and the rest read the list that results:
 *
 *   1. A code followed by a country it does not belong to is that country's
 *      subdivision code and is dropped ("La Ceiba, AT, HN": AT is a Honduran
 *      department, not Austria). A code followed by its own country is a state
 *      ("GA, US"). In a list that names other countries, a code that is also a
 *      country and is not followed by its own is the country ("Trelew, U, AR"
 *      in a list of Latin American countries).
 *   2. Two or more state codes: each takes the token just before it as its city,
 *      when that token is city-like ("Chicago, IL, Evanston, IL" is Chicago and
 *      Evanston, both Illinois). Countries named in the list count as well.
 *   3. Otherwise two or more countries: each country.
 *   4. Otherwise two or more cities the table knows: each city, in the country
 *      and state the table gives it.
 */
function listPlaces(piece, cities) {
  let toks = listTokens(piece);
  const isCountryTok = (x) => x && x.t.kind === 'country';
  toks = toks.filter((x, i) => !(/^[A-Z]{2}$/.test(x.raw.trim()) && isCountryTok(toks[i + 1]) &&
    toks[i + 1].t.code !== (x.t.kind === 'admin' ? x.t.country : x.t.code)));
  const named = new Set(toks.filter(isCountryTok).map((x) => x.t.code));
  toks = toks.map((x, i) => {
    if (x.t.kind !== 'admin' || !x.t.alsoCountry) return x;
    const own = toks[i + 1] && isCountryTok(toks[i + 1]) && toks[i + 1].t.code === x.t.country;
    const others = [...named].some((c) => c !== x.t.country);
    return !own && others ? { raw: x.raw, t: { kind: 'country', raw: x.t.raw, code: x.t.alsoCountry } } : x;
  });
  const out = [];
  const codes = toks.filter((x) => x.t.kind === 'admin' && x.t.raw.length === 2);
  if (codes.length >= 2) {
    toks.forEach((x, i) => {
      if (!(x.t.kind === 'admin' && x.t.raw.length === 2)) return;
      const prev = toks[i - 1];
      const city = prev && prev.t.kind === 'other' && cityLike(prev.raw.trim())
        ? (cityOf(cities, prev.raw)?.city ?? prev.raw.trim()) : null;
      out.push({ country: x.t.country, admin1: x.t.code, city });
    });
    toks.filter(isCountryTok).forEach((x) => out.push({ country: x.t.code, admin1: null, city: null }));
    return out;
  }
  const countries = toks.filter(isCountryTok);
  if (countries.length >= 2) return countries.map((x) => ({ country: x.t.code, admin1: null, city: null }));
  const known = toks.filter((x) => x.t.kind === 'other' && cityOf(cities, x.raw));
  if (known.length >= 2) {
    return known.map((x) => {
      const e = cityOf(cities, x.raw);
      return { country: e.country, admin1: e.admin1 || null, city: e.city };
    });
  }
  return out;
}

/**
 * Every place a posting lists, each with the label a reader sees. An empty list
 * means the posting names no place ("Not stated").
 *
 *   placesOf('London / Germany', null)             -> London, UK and Germany
 *   placesOf('Chicago, IL, Evanston, IL', null)    -> Chicago, IL and Evanston, IL
 *   placesOf('Haarlem; Lugano; Singapore', 'SG')   -> Singapore
 *   placesOf('Austin, TX', null)                   -> Austin, TX, as placeOf says
 *
 * ONE PLACE. A string with at most one piece, and that piece not a list, is
 * placeOf()'s answer (or none, when it has no country), identical to what the
 * board has always said.
 *
 * A LIST. Every piece is read on its own, WITHOUT the upstream country
 * (readPart(piece, null)): its own text, then the city table. The upstream code
 * is the crawl's pick of ONE place from the list, so it is not lent to the
 * others: "London / Germany" under an upstream DE is London, UK and Germany, not
 * London, Germany. Then:
 *
 *   - A piece that is itself a comma list is read by listPlaces above.
 *   - A lone "Georgia" or "Victoria" counts only when another piece of the list
 *     is in the same country (a London list ends in "Victoria").
 *   - "Germany & Netherlands": two country names joined by & or "and" are both.
 *   - A piece with no country of its own (a city the table does not know) takes
 *     the upstream code ONLY when no piece of the list names a country in its
 *     text and every place found is in the upstream country. Otherwise it is
 *     dropped, because the upstream code would be a guess about it: "Haarlem;
 *     Lugano; Singapore" under SG is Singapore, not Haarlem, Singapore.
 *   - A list that resolves to nothing, under a valid upstream code, is that
 *     country.
 *   - One entry per leaf key, so a place listed twice is one place.
 *
 * Measured over the 37,286 live rows (2026-10-02): 2,201 read as a list, 477 of
 * them across several countries; 14 more countries appear (95 to 109); London,
 * UK goes from 676 to 903; 7 rows lose the country they had, all of them wrong
 * (one Latin America posting and one European one filed under the US, and
 * "Vancouver, Washington" filed under Canada).
 *
 * @param {string|null|undefined} location
 * @param {string|null|undefined} upstream the crawl's country column
 * @param {CityTable} [cities]
 * @returns {ListedPlace[]}
 */
export function placesOf(location, upstream, cities = CITIES) {
  const up = isoCountry(upstream);
  const pieces = cleanText(location).split(PART_SPLIT).map((p) => splitCountryTail(p, cities));
  const readAll = pieces.map((p) => readPart(p, up, cities)).filter(Boolean);
  if (readAll.length <= 1 && !readAll.some((p) => p.listed)) {
    const one = placeOf(location, upstream, cities);
    return one.country ? [/** @type {ListedPlace} */ (one)] : [];
  }

  const found = [];
  const deferred = [];
  const loneAmbiguous = [];
  /** Every country the TEXT of the list states, by any piece. */
  const stated = new Set();
  for (const piece of pieces) {
    const own = readPart(piece, null, cities);
    if (!own) continue;
    if (own.textCountry) stated.add(own.textCountry);
    if (own.listed) {
      const inList = listPlaces(piece, cities);
      for (const p of inList) stated.add(p.country);
      if (inList.length > 0) found.push(...inList);
      else if (own.country) found.push({ country: own.country, admin1: null, city: null });
      continue;
    }
    const toks = listTokens(piece);
    if (toks.length === 1 && toks[0].t.kind === 'admin' && LONE_AMBIGUOUS.has(toks[0].raw.trim().toLowerCase())) {
      loneAmbiguous.push({ country: own.country, admin1: own.admin1, city: null });
      continue;
    }
    if (own.country) {
      found.push({ country: own.country, admin1: own.admin1, city: own.city });
      continue;
    }
    const joined = piece.split(/\s+(?:&|and)\s+/i).map((s) => classify(s.trim()));
    if (joined.length >= 2 && joined.every((t) => t && t.kind === 'country')) {
      for (const t of joined) {
        found.push({ country: t.code, admin1: null, city: null });
        stated.add(t.code);
      }
      continue;
    }
    deferred.push(piece);
  }
  // The upstream code is lent to a piece that names no country only when nothing
  // in the list contradicts it: no country stated in any piece's text, and every
  // place already found in the upstream country.
  const lend = up && stated.size === 0 && found.every((p) => p.country === up) ? up : null;
  if (lend) {
    for (const piece of deferred) {
      const read = readPart(piece, lend, cities);
      if (read && read.country) found.push({ country: lend, admin1: read.admin1, city: read.city });
    }
  }
  for (const p of loneAmbiguous) if (found.some((q) => q.country === p.country)) found.push(p);
  if (found.length === 0 && up) found.push({ country: up, admin1: null, city: null });

  const byLeaf = new Map();
  for (const p of found) if (p.country) byLeaf.set(placeLeafOf(p), p);
  return [...byLeaf.values()].map((p) => ({ ...p, label: placeLabel(p.country, p.admin1, p.city) }));
}

/**
 * The ONE place a row reduces to, for the place_* columns and derived_region.
 *
 * One country: that country, with its state if every place agrees on one and its
 * city if every place agrees on one. Several countries: the upstream code if it
 * is one of them, otherwise none, and then no state and no city, because a state
 * or a city of one of several countries is a claim about the others. No places:
 * none. (A single place reduces to itself, so a one-place row's columns are
 * placeOf()'s answer exactly.)
 *
 * @param {ListedPlace[]} places placesOf()'s answer
 * @param {string|null|undefined} upstream the crawl's country column
 * @returns {Place}
 */
export function summaryOf(places, upstream) {
  const up = isoCountry(upstream);
  if (places.length === 0) return { country: null, admin1: null, city: null, label: null };
  const countries = [...new Set(places.map((p) => p.country))];
  if (countries.length > 1) {
    const country = up && countries.includes(up) ? up : null;
    return { country, admin1: null, city: null, label: country ? placeLabel(country, null, null) : null };
  }
  const admins = [...new Set(places.map((p) => p.admin1 || ''))];
  const cityNames = [...new Set(places.map((p) => p.city || ''))];
  const country = /** @type {string} */ (countries[0]);
  const admin1 = admins.length === 1 && admins[0] ? admins[0] : null;
  const city = cityNames.length === 1 && cityNames[0] ? cityNames[0] : null;
  return { country, admin1, city, label: placeLabel(country, admin1, city) };
}

// ---------------------------------------------------------------------------
// Apply friction.
// ---------------------------------------------------------------------------

/**
 * ACCOUNT-WALLED APPLICANT SYSTEMS. An applicant system is on this list when
 * the applicant must create an account, or sign in to an existing one, BEFORE
 * the application form can be reached. Everything not on the list is 'easy':
 * the form is the first thing the apply link shows, and a name, an email and a
 * resume submit it.
 *
 * MEASURED, NOT ASSUMED (2026-09-23). Every applicant system carrying live
 * rows was checked by loading a real posting's apply link in a browser and
 * reading what came back. The rendered page is the only honest test here:
 * most of these are single-page apps whose served HTML is an empty shell, so
 * a fetch-and-grep reads every one of them as having no form at all.
 *
 *   usajobs  hard  /Applicant/... redirects to login.usajobs.gov/Account/Login
 *   workday  hard  the apply flow opens on "step 1 of 6: Create Account/Sign In"
 *   amazon   hard  /applicant/jobs/<id>/apply redirects to passport.amazon.jobs,
 *                  titled "Log in or create account"
 *   yc       hard  "Apply to role" goes to account.ycombinator.com/authenticate
 *                  with signUpActive=true
 *
 *   ashby, greenhouse, teamtailor, breezy, personio, recruitee, jobvite,
 *   lever, workable, rippling, netflix  easy  the apply link renders a form
 *   carrying name, email and a resume file input, and no password field.
 *
 * NETFLIX IS THE REASON THIS WAS MEASURED. It runs its own careers portal, so
 * it read as an account wall by analogy with Amazon. It is not one:
 * explore.jobs.netflix.net/careers/apply?pid=<id> renders the form directly.
 *
 * KEYED ON THE APPLICANT SYSTEM, NOT THE EMPLOYER. The account requirement is
 * a property of the platform's apply flow, which employers on that platform do
 * not configure. Checked against eight distinct employers per platform: no
 * platform split. Where an employer redirects its apply link to a flow of its
 * own the crawl records that posting under a different applicant system, so it
 * is classified by the system it actually lands on.
 *
 * The four walled systems carry 16,463 of 31,310 live rows (52.6%), so this is
 * the difference between half the board and the other half, not a rounding
 * detail.
 */
export const ACCOUNT_WALLED_ATS = Object.freeze([
  // Measured here, 2026-09-23, by loading a real posting's apply link.
  'usajobs',
  'workday',
  'amazon',
  'yc',
  // NOT MEASURED HERE, BECAUSE THEY CARRY NO LIVE ROWS TONIGHT, but already on
  // record in the crawler's own ACCOUNT_GATED_HOSTS (jobmachine sweep.py), which
  // reaches the same verdict from the apply URL's host rather than from the
  // adapter. Their adapters shipped on 2026-09-22 and will bring rows; listing
  // them now means the first night they appear is classified rather than
  // silently defaulted. They move no number today.
  'taleo',
  'icims',
  'successfactors'
]);

/**
 * Every applicant system whose apply flow has actually been checked, by either
 * route. frictionOf defaults anything else to 'easy', which is the honest
 * default for a two-level field but IS a default, so the backfill names any
 * system that is not on this list. A new adapter's first night then shows up as
 * a line in the receipt instead of as a silent 'easy' on a few thousand rows.
 */
export const MEASURED_ATS = Object.freeze([
  'usajobs', 'workday', 'amazon', 'yc', 'taleo', 'icims', 'successfactors',
  'ashby', 'greenhouse', 'lever', 'workable', 'rippling', 'personio',
  'recruitee', 'breezy', 'teamtailor', 'jobvite', 'netflix'
]);

const WALLED = new Set(ACCOUNT_WALLED_ATS);
const MEASURED = new Set(MEASURED_ATS);

/** True when this applicant system's apply flow has been checked. */
export function isMeasuredAts(ats) {
  return MEASURED.has(String(ats || '').toLowerCase());
}

/**
 * 'hard' when the applicant must hold an account with the applicant system
 * before applying, 'easy' when the apply link opens the form itself.
 *
 * An unknown applicant system is 'easy'. That is the honest default: the
 * walled list is the set we have evidence for, and inventing a wall for a
 * system nobody has checked would print a claim the crawl cannot support. A
 * new system joins the list when it is measured, and the backfill moves its
 * rows in one pass.
 */
export function frictionOf(ats) {
  return WALLED.has(String(ats || '').toLowerCase()) ? 'hard' : 'easy';
}

// ---------------------------------------------------------------------------
// Posted pay.
// ---------------------------------------------------------------------------

/**
 * The posted range in thousands, or nulls when the posting printed none.
 *
 * priced is true only when a structured minimum above zero was published. A
 * range parsed out of prose is not a printed range, and an absent range is a
 * gap, never a zero and never a number below a reader's floor.
 *
 * comp_range arrives as the crawl's JSON object ({min, max, currency, ...});
 * max falls back to min so a single posted figure is a range of width zero
 * rather than a null that would drop the row out of every pay view.
 */
export function payOf(compRange) {
  const cr = compRange && typeof compRange === 'object' ? compRange : null;
  const rawMin = cr && typeof cr.min === 'number' ? cr.min : null;
  if (rawMin === null || !(rawMin > 0)) {
    return { priced: false, min_k: null, max_k: null, mid_k: null };
  }
  const rawMax = typeof cr.max === 'number' && cr.max > 0 ? cr.max : rawMin;
  const min_k = Math.round(rawMin / 1000);
  const max_k = Math.round(rawMax / 1000);
  return { priced: true, min_k, max_k, mid_k: Math.round((min_k + max_k) / 2) };
}

// ---------------------------------------------------------------------------
// The one call the writers make.
// ---------------------------------------------------------------------------

/**
 * Every derived field for one crawl row, as the columns db/207, db/220 and db/222 added.
 * The ingest spreads this onto the row it writes; the backfill writes exactly
 * these columns and nothing else.
 *
 * Region reads the country code first and falls back to location when the row
 * has no usable code (regionFor): a posting that names a country has stated the
 * stronger fact, and location is often a city with no country on it. It does
 * NOT hand the code to the word list, which is what it did until 2026-10-02 and
 * is why every Canadian posting read 'US West'.
 *
 * The place_* columns are the one place the row reduces to (summaryOf over
 * placesOf), and place_keys and place_leaves (db/222) are every place it lists.
 * All of them come out of the one placesOf() call here, shared with regionFor so
 * the text is parsed once per row, and so the single place and the list can never
 * be two readings of the string.
 *
 * place_keys is every key of every place, distinct and sorted; empty means "Not
 * stated". place_leaves is the most specific key of each place, distinct and
 * sorted, one per place. Both are written sorted so that a re-run over an
 * unchanged row compares equal, which is what lets the backfill skip it.
 */
export function derivedFor(row) {
  const pay = payOf(row.comp_range);
  const fam = familyWithSource(row.department, row.title);
  const places = placesOf(row.location, row.country);
  const place = summaryOf(places, row.country);
  return {
    derived_tier: tierFromTitle(row.title),
    derived_fam: fam.fam,
    derived_fam_source: fam.source,
    derived_region: regionFor(row.country, row.location, place),
    derived_friction: frictionOf(row.ats),
    priced: pay.priced,
    comp_min_k: pay.min_k,
    comp_max_k: pay.max_k,
    comp_mid_k: pay.mid_k,
    place_country: place.country,
    place_admin1: place.admin1,
    place_city: place.city,
    place_label: place.label,
    place_keys: [...new Set(places.flatMap(placeKeysOf))].sort(),
    place_leaves: [...new Set(places.map(placeLeafOf))].sort()
  };
}
