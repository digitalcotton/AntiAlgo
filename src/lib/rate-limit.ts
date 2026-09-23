/**
 * rate-limit.ts: a fixed-window counter, in memory, per function instance.
 *
 * WHAT IT IS FOR. The Jobs Data endpoints answer one request per filter press.
 * That is a handful per reader per minute in normal use, and a script could
 * make thousands. This caps both the account and the source address so a single
 * caller cannot turn the page into a load generator against the database.
 *
 * WHAT IT IS NOT. It is not a shared limiter. Each serverless instance keeps
 * its own counters, so a caller spread across N instances gets up to N times
 * the limit. Closing that gap needs a shared store, which is a paid service
 * this page was explicitly not to add. The bound that matters is still there:
 * the expensive path is a cache miss, and a caller hammering one filter
 * combination hits the cache from the second request onward, so the cost of
 * abuse is bounded by the number of DISTINCT filter combinations, not by the
 * request count.
 *
 * NO DATABASE. Counters are integers in a Map, swept lazily. A rate limiter
 * that writes to Postgres on every request would add exactly the load it exists
 * to prevent.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();
/** Stop the Map growing without bound on an instance that lives a long time. */
const MAX_BUCKETS = 5_000;

export interface Limit {
  /** How many requests one key may make per window. */
  max: number;
  /** The window, in milliseconds. */
  windowMs: number;
}

export interface LimitResult {
  ok: boolean;
  /** Requests left in this window. */
  remaining: number;
  /** Seconds until the window resets, for Retry-After. */
  retryAfter: number;
}

/**
 * Count one request against `key`. Returns whether it is allowed, how many
 * remain, and when the window resets.
 */
export function hit(key: string, limit: Limit, now = Date.now()): LimitResult {
  let w = buckets.get(key);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + limit.windowMs };
    if (buckets.size >= MAX_BUCKETS) sweep(now);
    buckets.set(key, w);
  }
  w.count += 1;
  const retryAfter = Math.max(1, Math.ceil((w.resetAt - now) / 1000));
  if (w.count > limit.max) return { ok: false, remaining: 0, retryAfter };
  return { ok: true, remaining: limit.max - w.count, retryAfter };
}

/** Drop every expired window. Called only when the Map reaches its cap, so the
    common path stays two Map operations. */
function sweep(now: number): void {
  for (const [k, w] of buckets) if (w.resetAt <= now) buckets.delete(k);
  // Still full of live windows: drop the oldest insertions to keep the bound.
  if (buckets.size >= MAX_BUCKETS) {
    let drop = Math.ceil(MAX_BUCKETS / 4);
    for (const k of buckets.keys()) {
      buckets.delete(k);
      if (--drop <= 0) break;
    }
  }
}

/**
 * The address a request came from, as the platform reports it. Used only as a
 * rate-limit key: it is never stored, logged or joined to an account.
 *
 * x-forwarded-for is a list, client first, appended to by each proxy. Only the
 * first entry is meaningful here, and it is still caller-supplied, which is why
 * the account limit is the one that actually protects a signed-in reader and
 * this one only blunts unauthenticated noise.
 */
export function addressOf(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Drop every counter. For tests. */
export function resetRateLimits(): void {
  buckets.clear();
}
