/**
 * One page of the Pre-List, filtered, counted, sorted and sliced in memory.
 *
 * WHY THIS EXISTS AT ALL. The board reads its rows from Postgres and lets SQL do
 * the work (job-store.ts listBoardFiltered: LIMIT and OFFSET, one page per
 * request). The Pre-List's population is not in the store; it is the static
 * prospects.json that prospectRows() holds in memory. So /prelist had no way to
 * ask for one page and passed the whole list to Board.astro, which in client
 * mode renders every row into the document and merely hides the ones past the
 * first page (JobTable.astro, `paging="client"`). Measured on 2026-09-19 that
 * was a 6.3 MB document holding 25,623 elements for 375 rows, which is what
 * crashed phones and stalled desktops. This file is the array-shaped equivalent
 * of listBoardFiltered so the page can hand Board one page and nothing more.
 *
 * IT MIRRORS THE STORE'S SEMANTICS DELIBERATELY. Every predicate below is the
 * in-memory reading of a clause in job-store.ts, and every facet is read through
 * data.ts facetsOf() rather than off the row, so the counts a reader sees and
 * the rows they get are produced by the same rule. Where the two could drift the
 * comment says so.
 */
import { ageOf, facetsOf, sortJobs, COMP_BANDS, type Job, type JobFacets } from './data';
import type { BoardQuery } from './board-query';

/** The same shape job-store.ts FacetCounts has, so facetGroupsFromCounts reads it. */
export interface ProspectCounts {
  total: number;
  location: Record<string, number>;
  comp: Record<string, number>;
  freshness: Record<string, number>;
}

export interface ProspectPage {
  /** One page, already sorted. Never the whole list. */
  rows: Job[];
  /** How many rows matched, across every page. */
  total: number;
  counts: ProspectCounts;
}

/**
 * The search box. The store ORs title and company (job-store.ts match_q); a
 * pre-posting row has no title, so in practice this reads the company name, but
 * the title is included so the rule is the store's rule and not a special case.
 */
function matchesQ(job: Job, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  return `${job.title ?? ''} ${job.company}`.toLowerCase().includes(needle);
}

/**
 * The age strip. A row with no measurable age is outside any range that is set,
 * because it has no position on the axis to be inside of (board-query.ts). Every
 * prospect has a null age today, so any range set on the board and carried here
 * empties the list exactly as it empties the board's own unmeasurable rows.
 */
function matchesAge(job: Job, min: number | null, max: number | null): boolean {
  if (min === null && max === null) return true;
  const age = ageOf(job);
  if (age === null) return false;
  return age.days >= (min ?? Number.NEGATIVE_INFINITY) && age.days <= (max ?? Number.POSITIVE_INFINITY);
}

/**
 * Location, with the exemption that keeps this page from emptying itself.
 *
 * A company that has not posted has no workplace, so facetsOf() reads it
 * 'unknown' and JobTable lets it through whatever Location is selected
 * (data.ts). Dropping that exemption here would reinstate the bug fixed on
 * 2026-09-10: a "Remote" filter chosen on the board travels in the address, and
 * the Pre-List answers with zero of its rows and no explanation.
 */
function matchesLocation(facets: JobFacets, selected: string): boolean {
  return selected === 'all' || facets.location === 'unknown' || facets.location === selected;
}

/** The base set: the two filters that always apply, whatever the facets say. */
function baseSet(jobs: readonly Job[], query: BoardQuery): Job[] {
  return jobs.filter((job) => matchesQ(job, query.q) && matchesAge(job, query.ageMin, query.ageMax));
}

/**
 * The counts behind the filter controls.
 *
 * Counted over the base set, each group independent of what the other two are
 * set to. The store narrows each group by the other groups' selections
 * (job-store.ts facetCountSql); this does not, which is a real difference and a
 * deliberate one: every prospect is 'unknown' location, 'not-listed' comp and
 * 'unknown' freshness, so cross-narrowing would compute the same numbers through
 * more code. If the Pre-List ever carries real variety, this is the function to
 * upgrade, and facetGroupsFromCounts above it needs no change.
 */
function countFacets(base: readonly Job[]): ProspectCounts {
  const facets = base.map(facetsOf);
  const tally = (pick: (facet: JobFacets) => string, keys: readonly string[]): Record<string, number> => {
    const out: Record<string, number> = { all: base.length };
    for (const key of keys) out[key] = 0;
    for (const facet of facets) {
      const key = pick(facet);
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };

  return {
    total: base.length,
    location: tally((f) => f.location, ['remote', 'onsite']),
    comp: tally((f) => f.comp, [...COMP_BANDS.map((b) => b.key), 'not-listed']),
    freshness: tally((f) => f.freshness, ['fresh', 'older', 'unknown'])
  };
}

/**
 * One page of the Pre-List for an address, the way the store answers the board.
 *
 * The caller clamps the page against `total` (board-query.ts clampPage) and
 * redirects when the address names a page past the end, so this returns an empty
 * `rows` for an out-of-range page rather than guessing what was meant.
 */
export function listProspectsFiltered(jobs: readonly Job[], query: BoardQuery): ProspectPage {
  const base = baseSet(jobs, query);
  const counts = countFacets(base);

  const matched = base.filter((job) => {
    const facets = facetsOf(job);
    return (
      matchesLocation(facets, query.location) &&
      (query.comp === 'all' || facets.comp === query.comp) &&
      (query.freshness === 'all' || facets.freshness === query.freshness)
    );
  });

  const offset = (query.page - 1) * query.per;
  return {
    rows: sortJobs(matched, query.sort).slice(offset, offset + query.per),
    total: matched.length,
    counts
  };
}
