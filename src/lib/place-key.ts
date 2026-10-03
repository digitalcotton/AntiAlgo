/**
 * place-key.ts: the grammar of the board's `place=` value, written once.
 *
 * It lives here, and not in board-query.ts where it was written, because two
 * files that cannot import each other need it: board-query.ts reads the address
 * with it, and data.ts (which board-query.ts imports for its own tables) draws a
 * label for the place the address names. A module that imported the other would
 * be evaluated before the constants it reads at load time. board-query.ts
 * re-exports everything below, so every existing import of it keeps working.
 *
 * Pure: no database, no browser, nothing but the English country names the
 * derivation already uses (jobs-derived.mjs), so a label here is the label the
 * search box's chips carry.
 */
import { ADMIN_NAMES, countryName } from './jobs-derived.mjs';

/** A place key taken apart. `admin1` and `city` are null where the key stops short of them. */
export interface PlaceKey {
  country: string;
  admin1: string | null;
  city: string | null;
}

/**
 * THE ONE `place=` VALUE THAT IS NOT A PLACE: `place=unstated`, the postings the
 * board could not resolve to a country (jobs.place_country IS NULL). Location's
 * "Not stated" row writes it, so a reader can ask for the roles whose place the
 * employer never named, which is 18% of the live board and a fact worth asking for
 * rather than a hole in the list.
 *
 * It cannot collide with a place key: every one of those starts with two UPPER CASE
 * letters (parsePlaceKey), and this is eight lower case ones. It is deliberately
 * not read by parsePlaceKey. That function answers "which country, region and city
 * is this" and every caller of it binds the three parts into a predicate; an
 * `unstated` it returned as a place with no country would be bound as "no place
 * chosen" and match every row, silently, in a caller that forgot the case. So the
 * one place that reads it as a filter, job-store.ts, asks isPlaceUnstated() first,
 * and everything that only has to know whether an address is acceptable asks
 * isPlaceKey().
 */
export const PLACE_UNSTATED = 'unstated';

/** True for the one key that means "no resolved country". */
export function isPlaceUnstated(key: string | null | undefined): boolean {
  return key === PLACE_UNSTATED;
}

/** True for every value `place=` accepts: a place key (parsePlaceKey) or `unstated`. */
export function isPlaceKey(key: string | null | undefined): boolean {
  return isPlaceUnstated(key) || parsePlaceKey(key) !== null;
}

/**
 * A place key read strictly, or null.
 *
 *   GB                 a country (ISO 3166-1 alpha-2, upper case)
 *   US-MD              a country and one of its regions (1 to 3 upper case
 *                      letters or digits: MD, ON, NSW)
 *   GB/London          either of those, a slash, and a city
 *   US-MD/Baltimore    exactly as the board spells it in place_city
 *
 * The part left of the FIRST slash is the country or country and region; what
 * is right of it is the city, taken whole and case-sensitively, because it is
 * compared with place_city for equality and a "repaired" spelling would match
 * nothing. A city may itself contain a slash or a dot ("St. John's",
 * "Rio/Janeiro" would both survive); what it may not do is carry a control
 * character, run longer than 80 characters, or start or end with a space.
 *
 * Strict means a lower-case `gb`, a region with no country (`-MD`), `US-`, a
 * trailing slash and a four-letter region are all null. The caller drops a null
 * and the board runs unnarrowed: a stale bookmark is the board without that
 * narrowing, never an error and never a guess at what was meant.
 */
export function parsePlaceKey(key: string | null | undefined): PlaceKey | null {
  if (typeof key !== 'string') return null;
  const match = /^([A-Z]{2})(?:-([A-Z0-9]{1,3}))?(?:\/([^\p{C}]{1,80}))?$/u.exec(key);
  if (!match) return null;
  const city = match[3] ?? null;
  // A city is a name: it starts and ends on a non-space and holds at least one
  // letter or digit ("GB//" is not a city called slash).
  if (city !== null && (city !== city.trim() || !/[\p{L}\p{N}]/u.test(city))) return null;
  return { country: match[1], admin1: match[2] ?? null, city };
}

/** A place key written back out: the inverse of parsePlaceKey. */
export function formatPlaceKey(place: PlaceKey): string {
  return `${place.country}${place.admin1 ? `-${place.admin1}` : ''}${place.city ? `/${place.city}` : ''}`;
}

/** The countries whose city labels print the region ("Austin, TX") and not the
    country ("London, United Kingdom"): the same three jobs-derived.mjs placeOf
    writes place_label with. */
const REGION_IN_LABEL: ReadonlySet<string> = new Set(['US', 'CA', 'AU']);

/**
 * What a place key reads as, for a control that has to name the place the
 * address chose when the list in front of it holds only countries:
 *
 *   GB                  United Kingdom
 *   US-MD               Maryland
 *   GB/London           London, United Kingdom
 *   US-MD/Baltimore     Baltimore, MD
 *   unstated            Location not stated
 *
 * The same four shapes jobs-derived.mjs placeOf() and the search lexicon print,
 * so the strip and the chip beside it say one thing. A key that does not parse
 * is returned as it came: a label is never the reason a control goes blank.
 * `unstated` is worded in full, "Location not stated", because it is also the
 * label of the search box's chip, where a bare "Not stated" would not say what is
 * not stated; the Location menu's own row keeps its short name.
 */
export function placeKeyLabel(key: string | null | undefined): string {
  if (isPlaceUnstated(key)) return 'Location not stated';
  const place = parsePlaceKey(key);
  if (place === null) return typeof key === 'string' ? key : '';
  const country = (countryName(place.country) as string | null) ?? place.country;
  if (place.city === null) {
    return place.admin1 === null ? country : (ADMIN_NAMES[place.country]?.[place.admin1] ?? place.admin1);
  }
  return place.admin1 !== null && REGION_IN_LABEL.has(place.country) ? `${place.city}, ${place.admin1}` : `${place.city}, ${country}`;
}
