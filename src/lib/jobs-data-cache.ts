/**
 * jobs-data-cache.ts: hold a computed view until the next crawl replaces it.
 *
 * WHY A CACHE IS SAFE HERE AND USUALLY IS NOT. The jobs table is written by
 * exactly one writer, scripts/ingest-jobs.mjs, which truncates and reloads it
 * once per crawl inside one transaction. Between two crawls the data is
 * immutable, so a cached answer is not a stale answer, it is the same answer.
 * Every entry is stamped with the crawl it was computed from, and a stamp that
 * no longer matches drops the whole cache rather than ageing entries out one by
 * one, because after a crawl every entry is wrong at once.
 *
 * THE UNFILTERED VIEW IS THE ONE THAT MATTERS. It is what every reader sees
 * first and what most never move off, so it is computed once per crawl and held
 * separately from the filtered entries, which are capped and evicted.
 *
 * PER INSTANCE, NOT SHARED. This is a module-level Map inside one serverless
 * function instance. A second instance keeps its own copy and computes its own
 * first answer. That is the honest bound: the alternative is a shared cache
 * service, which is a cost this page does not need, since a miss is one query
 * of a few tens of milliseconds rather than an expensive rebuild.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */

import { getBoardStats } from './job-store';
import { liveAggregates, killAggregates, boardFacts, type Aggregates, type KillAggregates, type BoardFacts } from './jobs-data-agg';
import { cacheKey, isUnfiltered, type Filters } from './jobs-data-filters';

/** The most filter combinations held at once. Each is a few tens of kilobytes,
    so this is a bounded, small amount of memory per instance. */
const MAX_ENTRIES = 120;
/** How often the crawl stamp is re-read. The crawl runs nightly, so a minute
    of lag after it lands is not worth a database round trip per request. */
const STAMP_TTL_MS = 60_000;

export interface JobsDataView {
  stamp: string;
  live: Aggregates;
  kills: KillAggregates;
}

let currentStamp = '';
let stampReadAt = 0;
let facts: BoardFacts | null = null;
let unfiltered: JobsDataView | null = null;
const filtered = new Map<string, JobsDataView>();

/**
 * The crawl this data came from, as an ISO instant. Everything cached is keyed
 * on it, so "until the next crawl" is enforced by the data rather than by a
 * timer nobody can see.
 */
async function crawlStamp(): Promise<string> {
  const now = Date.now();
  if (currentStamp && now - stampReadAt < STAMP_TTL_MS) return currentStamp;
  const bs = await getBoardStats();
  const swept = bs && bs.swept_at ? bs.swept_at : null;
  const next = swept ? (swept instanceof Date ? swept.toISOString() : String(swept)) : 'no-crawl';
  stampReadAt = now;
  if (next !== currentStamp) {
    // A new crawl. Everything held describes the previous one, so none of it
    // survives: dropping it whole is both correct and cheaper than deciding
    // entry by entry.
    currentStamp = next;
    unfiltered = null;
    facts = null;
    filtered.clear();
  }
  return currentStamp;
}

/** The board-wide facts no filter moves, computed once per crawl. */
export async function cachedFacts(): Promise<BoardFacts> {
  await crawlStamp();
  if (!facts) facts = await boardFacts();
  return facts;
}

/**
 * The view for one filter combination. The unfiltered view is precomputed and
 * held for the life of the crawl; a filtered view is computed on request and
 * held until the next crawl or until it is evicted by the cap.
 *
 * `watchedFams` and `watchedTiers` come from the board-wide title index rather
 * than from the cut, because the archive follows the KIND of role a reader
 * watches, not the rows that survived their other filters.
 */
export async function cachedView(f: Filters): Promise<JobsDataView> {
  const stamp = await crawlStamp();

  if (isUnfiltered(f)) {
    if (unfiltered && unfiltered.stamp === stamp) return unfiltered;
    unfiltered = await build(f, stamp);
    return unfiltered;
  }

  const key = cacheKey(f);
  const hit = filtered.get(key);
  if (hit && hit.stamp === stamp) {
    // Re-insert so the cap evicts the least recently asked for, not the oldest.
    filtered.delete(key);
    filtered.set(key, hit);
    return hit;
  }

  const view = await build(f, stamp);
  filtered.set(key, view);
  while (filtered.size > MAX_ENTRIES) {
    const oldest = filtered.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    filtered.delete(oldest);
  }
  return view;
}

async function build(f: Filters, stamp: string): Promise<JobsDataView> {
  const index = (await cachedFacts()).titleIndex;
  const watched = f.watches
    .map((w) => index.find((t) => t.title === w.title))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  const fams = [...new Set(watched.flatMap((t) => t.fams))];
  const tiers = [...new Set(watched.flatMap((t) => t.tiers))];

  const [live, kills] = await Promise.all([
    liveAggregates(f),
    killAggregates(f, fams, tiers)
  ]);
  return { stamp, live, kills };
}

/** Drop everything. Exists for tests; nothing in the request path calls it. */
export function resetJobsDataCache(): void {
  currentStamp = '';
  stampReadAt = 0;
  unfiltered = null;
  facts = null;
  filtered.clear();
}
