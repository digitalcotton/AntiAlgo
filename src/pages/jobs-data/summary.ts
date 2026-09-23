/**
 * /jobs-data/summary: the numbers behind every chart on the Jobs Data page,
 * for one filter combination.
 *
 * IT RETURNS NO POSTINGS. Every field is a count, a sum, an average, a
 * percentile or a grouping key. There is no row endpoint on this page and no
 * export, by design: the page is a wall of charts and written readings, not a
 * data tool, and a reader manipulates it only by changing the filters that
 * move the numbers. src/lib/jobs-data-agg.ts holds the queries; a test asserts
 * that nothing shaped like a posting appears in any response.
 *
 * WHY IT IS NOT UNDER /api. A directory named api/ at the repository root
 * shadows Astro's own routes on Vercel, which silently killed the waitlist
 * form for a week in September. Endpoints live beside the page they serve,
 * the same way /ledger/prefs and /ledger/watch do.
 *
 * THE GATE IS ON EVERY REQUEST, SERVER SIDE. Not on the page that linked here,
 * not in a token the browser holds: the tier is resolved from the session on
 * each call. Signed out is 401, signed in below paid is 403, and the two are
 * kept apart because they mean different things to the caller and to us.
 *
 * Gate 3: no em dash, no en dash, no curly quotes.
 */
import type { APIContext } from 'astro';
import { isPaidViewer } from '../../lib/ledger-access';
import { viewerFrom } from '../../lib/viewer';
import { cachedView, cachedFacts } from '../../lib/jobs-data-cache';
import { parseFilters, assertAtsKnown, FilterError } from '../../lib/jobs-data-filters';
import { hit, addressOf } from '../../lib/rate-limit';
import type { Viewer } from '../../lib/entitlement';

export const prerender = false;

/**
 * One filter press is one request, and a reader pressing buttons as fast as a
 * mouse allows makes a few per second in bursts. Sixty a minute leaves that
 * untouched and stops a loop.
 */
const PER_ACCOUNT = { max: 60, windowMs: 60_000 };
/** Wider, because one address can be a household or an office behind one NAT,
    and because a signed-out caller never reaches a query anyway. */
const PER_ADDRESS = { max: 240, windowMs: 60_000 };

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A reader's cut is a function of their account's tier, so no shared
      // cache may hold it. The server holds the computed view instead.
      'cache-control': 'private, no-store',
      ...headers
    }
  });
}

export async function GET(context: APIContext): Promise<Response> {
  try {
    // The address limit is counted FIRST, before the session is resolved, so an
    // unauthenticated flood cannot make us do session work per request.
    const addr = hit('addr:' + addressOf(context.request), PER_ADDRESS);
    if (!addr.ok) {
      return json({ error: 'Too many requests.' }, 429, { 'retry-after': String(addr.retryAfter) });
    }

    const onLocals = context.locals.viewer as Viewer | null | undefined;
    const viewer = onLocals ?? (await viewerFrom(context));

    if (!viewer) {
      return json({ error: 'Sign in to read the jobs data.' }, 401);
    }
    if (!isPaidViewer(viewer)) {
      return json({ error: 'The full jobs data is on the paid account.' }, 403);
    }

    const acct = hit('acct:' + viewer.userId, PER_ACCOUNT);
    if (!acct.ok) {
      return json({ error: 'Too many requests.' }, 429, { 'retry-after': String(acct.retryAfter) });
    }

    const filters = parseFilters(new URL(context.request.url).searchParams);
    const facts = await cachedFacts();
    assertAtsKnown(filters, facts.atsOptions.map((a) => a.key));

    const view = await cachedView(filters);
    return json({ stamp: view.stamp, live: view.live, kills: view.kills }, 200, {
      'x-ratelimit-remaining': String(acct.remaining)
    });
  } catch (error) {
    if (error instanceof FilterError) {
      return json({ error: error.message, param: error.param }, 400);
    }
    // Never leak a database error to the browser; the page shows the cut it
    // already has and says the refresh failed.
    console.error('jobs-data/summary: failed', error);
    return json({ error: 'Could not read the jobs data.' }, 500);
  }
}
