/**
 * GET/POST /settings/filters: the signed-in half of MASTER-SPEC F10.
 *
 * TWO BULLETS, ONE ROUTE, BECAUSE THE INDEX NEEDS BOTH ON THE SAME LOAD.
 * GET answers both halves of F10 a signed-in visit to / needs before it can
 * honestly render itself: the filter selection this person last saved
 * (F10's second bullet, db/009_account_filter_state.sql via
 * src/lib/filters-store.ts) and which of the sweep's verified rows they
 * have already applied to (F10's first bullet, "signed-in users stop seeing
 * rows they have applied to", read from the Desk's own desk_application
 * table via src/lib/desk-store.ts, no new table for it). Splitting these
 * into two routes would double the round trip the index pays on every
 * signed-in load for no gain: both reads are scoped to the same userId, run
 * from the same middleware-resolved viewer, and exist to answer the same
 * question, "what does this person need this page to already know."
 *
 * POST saves only the filter selection. There is no POST for applied
 * suppression here, and there should never be one: applying to a job is the
 * Desk's own write path (src/pages/desk/application.ts's transition to
 * 'applied'), not a fact this route could ever be asked to set. Suppression
 * is read-only, derived fresh from the Desk on every GET, never cached
 * anywhere this route can go stale against a fresh application.
 *
 * MOUNTED UNDER /settings, NOT /api, FOR THE SAME FORCED REASON
 * src/pages/settings/export.ts is not under /api/settings. See that file's
 * own header for the verified evidence (this repo's root api/ directory
 * claims every /api/* path before Astro's router is ever consulted); this
 * route lives inside the same '/settings' prefix export.ts and delete.ts
 * already use, so no second src/lib/entitlement.ts ROUTE_POLICY entry is
 * needed for it.
 *
 * WHO THIS CAN ACT ON. No id anywhere but in the POSTed body's selection
 * values, and userId comes only from Astro.locals.viewer, resolved
 * server-side by middleware before this file runs. Every filters-store.ts
 * and desk-store.ts call below is scoped to that userId; there is no path
 * from this file to any other person's rows.
 *
 * A GET SIGNED OUT IS NOT AN ERROR TO THE CALLER. src/components/Filters.astro's
 * client script reads a non-200 here as "this visitor is signed out," the
 * same information a null session cookie already carries, and falls back to
 * localStorage/sessionStorage-only behaviour. 401 is still the honest status
 * to send: this route does refuse the request, it just refuses it in a way
 * the caller already has a plan for.
 */
import type { APIContext } from 'astro';
import { filterGroups, verifiedJobs } from '../../lib/data';
import { normalizeFilterSelection, suppressApplied } from '../../lib/filters';
import { getFilterState, saveFilterState } from '../../lib/filters-store';
import { listApplications } from '../../lib/desk-store';

export const prerender = false;

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Not signed in.' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function GET(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;
  if (!viewer || verdict?.allow !== true) {
    return unauthorized();
  }

  const [stored, applications] = await Promise.all([
    getFilterState(viewer.userId),
    listApplications(viewer.userId)
  ]);

  // job_id, never external_url: MASTER-SPEC F4.2's XOR (db/006_desk.sql)
  // means an application against a pasted URL we never verified has no row
  // in verifiedJobs() to suppress in the first place.
  const appliedJobIds = new Set(
    applications.map((application) => application.jobId).filter((jobId): jobId is string => jobId !== null)
  );
  const { suppressed } = suppressApplied(verifiedJobs(), appliedJobIds);

  return new Response(
    JSON.stringify({
      selection: stored?.selection ?? null,
      // Slugs, not ids: see src/lib/filters.ts's suppressedSlugs() comment
      // for why the client needs the id-to-slug mapping resolved server
      // side rather than shipping one down to do it itself.
      suppressedSlugs: suppressed.map((job) => job.slug)
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;
  if (!viewer || verdict?.allow !== true) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Malformed request body.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const raw =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>).selection : undefined;

  // Validated against the live groups, never trusted as posted: see
  // normalizeFilterSelection()'s own comment on why that vocabulary is
  // enforced here and not by a database constraint.
  const groups = filterGroups(verifiedJobs());
  const selection = normalizeFilterSelection(raw, groups);
  const stored = await saveFilterState(viewer.userId, selection);

  return new Response(JSON.stringify({ selection: stored.selection }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
