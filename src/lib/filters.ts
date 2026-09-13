/**
 * filters.ts: the pure half of MASTER-SPEC F10's second bullet, "Deterministic,
 * stateful search: exact filters that persist between sessions (account-backed
 * when signed in), never replaced by a chat box, ordered by observed data,
 * never by payment", and the pure half of F10's first bullet where that
 * bullet needs arithmetic rather than storage: applied suppression.
 *
 * PURE ON PURPOSE, THE SAME REASON entitlement.ts AND desk.ts ARE. This file
 * touches no database, no localStorage, no request. That is what lets a
 * selection be validated, and a suppressed set be computed, with no
 * connection string and no browser, which matters here specifically because
 * a connection string is the one thing a worker in this repository is not
 * allowed to open. The impure halves are src/lib/filters-store.ts (the
 * account-backed reads and writes db/009_account_filter_state.sql holds) and
 * the client script in src/components/Filters.astro (localStorage,
 * sessionStorage, fetch).
 *
 * WHY THE SELECTION IS VALIDATED HERE AND NOT ENCODED AS A DATABASE
 * CONSTRAINT. See db/009_account_filter_state.sql's own comment on its
 * `selection` column: the vocabulary a filter value may take (which comp
 * bands exist, which freshness buckets exist) is derived from the sweep by
 * src/lib/data.ts's filterGroups(), not fixed in this repository the way
 * STM-0002's states are. Copying that vocabulary into a SQL CHECK constraint
 * would be a second copy of it, and the two would drift the day a band is
 * renamed in data.ts and not in a migration nobody remembered to write.
 * normalizeFilterSelection() below is the one place that vocabulary is
 * actually enforced, run against the live groups every time a selection is
 * read from storage or written to it, so a stale or tampered value never
 * reaches the table a row hides behind, never a chat box's fuzzy guess.
 *
 * DETERMINISTIC MEANS NO ROW EVER MOVES FOR A REASON THIS FILE INVENTS.
 * suppressApplied() below is a plain set membership test: a job is
 * suppressed because its id is in the caller's own applied set, nothing
 * ranked, nothing scored, nothing reordered. That is the whole of what
 * MASTER-SPEC F10 asks this half of the feature to be.
 */
import type { FilterGroup, Job } from './data';

/** One value per filter group, keyed by the group's own `key`. Never a score,
    never free text: every value here is either 'all' or one of that group's
    own `options[].value`, which normalizeFilterSelection() is what actually
    enforces. */
export type FilterSelection = Record<string, string>;

/**
 * Storage keys, named once so src/components/Filters.astro's client script,
 * db writes and a future reader all spell the same string. A key duplicated
 * by hand in two files is exactly the drift this file exists to prevent for
 * the filter vocabulary itself; these are the same discipline applied to the
 * strings that locate the state rather than the state's own shape.
 */
export const FILTER_STORAGE_KEY = 'ti-index-filters:v1';
export const SEEN_STORAGE_KEY = 'ti-index-seen:v1';
export const SEEN_DIMMER_STORAGE_KEY = 'ti-index-seen-dimmer:v1';

/** The seen dimmer's own starting state, MASTER-SPEC F10: "user-toggleable,
    default on". Named so the client script and any test asserting on the
    default read the same constant rather than a literal `true` typed twice. */
export const DEFAULT_SEEN_DIMMER_ENABLED = true;

/**
 * A selection, made safe. Every group filterGroups() currently offers gets an
 * entry; a group this call was not given (a stale key from a selection saved
 * before a group existed, or one saved after a group was retired, per
 * filterGroups()'s own dead-option pruning) is dropped rather than carried
 * forward as an orphan, and a value that is not 'all' and not one of that
 * group's own option values falls back to 'all' rather than being trusted.
 *
 * `raw` is `unknown` on purpose: it is what JSON.parse() on a browser's own
 * localStorage, or a request body this repository does not control the
 * shape of, actually hands back. A malformed value here is never a thrown
 * error and never a half-applied selection; it is silently the safest
 * reading of what a stranger's browser or a network hiccup left behind.
 */
export function normalizeFilterSelection(raw: unknown, groups: readonly FilterGroup[]): FilterSelection {
  const source: Record<string, unknown> =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const normalized: FilterSelection = {};
  for (const group of groups) {
    const candidate = source[group.key];
    const isKnownValue =
      typeof candidate === 'string' && group.options.some((option) => option.value === candidate);
    normalized[group.key] = isKnownValue ? (candidate as string) : 'all';
  }
  return normalized;
}

/** True when every group in `selection` is set to 'all': the state a fresh
    visitor and a visitor who cleared every filter are both in, and the
    state not worth persisting a write for. */
export function isDefaultSelection(selection: FilterSelection): boolean {
  return Object.values(selection).every((value) => value === 'all');
}

export interface SuppressionResult {
  /** Every row this person has not applied to, in the caller's own order. */
  visible: Job[];
  /** Every row this person has applied to, same order, same population. */
  suppressed: Job[];
}

/**
 * Splits a job list against a set of applied job ids. Set membership only:
 * no rank, no score, no reordering, matching MASTER-SPEC F10's own ban on
 * anything that would sort rows "by payment" or a chat box's guess extended
 * here to mean no invented ordering of any kind. `visible` and `suppressed`
 * between them are exactly `jobs`, partitioned, never a row dropped and
 * never a row counted twice.
 *
 * appliedJobIds carries Job.id values (desk_application.job_id, MASTER-SPEC
 * F4.2's own key), not slugs: the Desk and this table both key on the
 * sweep's own stable id, and a caller matching against a URL slug instead
 * would silently suppress nothing the day a slug and an id next disagree.
 */
export function suppressApplied(jobs: readonly Job[], appliedJobIds: ReadonlySet<string>): SuppressionResult {
  const visible: Job[] = [];
  const suppressed: Job[] = [];
  for (const job of jobs) {
    if (appliedJobIds.has(job.id)) suppressed.push(job);
    else visible.push(job);
  }
  return { visible, suppressed };
}

/**
 * The same split, named by the one attribute the browser actually has to
 * act on. JobRow.astro writes `data-slug` on every row and nothing else that
 * identifies a posting to the client (see that file's own header on why:
 * the facets and ranks travel as data attributes so filtering never ships
 * the data twice), so a client script suppressing rows in the DOM needs
 * slugs, not the ids the Desk stores. Resolving that mapping is done once,
 * here, against the same Job objects the id lookup already has, rather than
 * asking the browser to hold an id-to-slug table of its own.
 */
export function suppressedSlugs(jobs: readonly Job[], appliedJobIds: ReadonlySet<string>): string[] {
  return suppressApplied(jobs, appliedJobIds).suppressed.map((job) => job.slug);
}

/**
 * Parses a stored JSON string the way every caller in this feature needs to:
 * a missing value, a malformed one, or a value that is not even an object
 * where an object was expected all read as "nothing was stored", never as a
 * thrown error a browser script would have to catch a second time. Returns
 * `unknown` rather than a narrowed type because the two callers (a filter
 * selection, an array of seen slugs) narrow it differently; see
 * normalizeFilterSelection() above and normalizeSeenSlugs() below.
 */
export function parseStoredJSON(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Every string in `raw`, discarding anything that is not one. A slug list
    read back from storage that has been hand-edited, truncated, or written
    by a future version of this file with a different shape degrades to
    "no rows are marked seen" rather than throwing. */
export function normalizeSeenSlugs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string');
}

/** The seen dimmer's on/off state, read back the same defensive way: only an
    actual boolean is trusted, anything else (absent, malformed, a stray
    string) resolves to DEFAULT_SEEN_DIMMER_ENABLED rather than to off,
    because a reader who never touched the control should see the default
    they were promised, not a value a storage glitch invented for them. */
export function normalizeSeenDimmerEnabled(raw: unknown): boolean {
  return typeof raw === 'boolean' ? raw : DEFAULT_SEEN_DIMMER_ENABLED;
}
