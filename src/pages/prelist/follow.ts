/**
 * POST /prelist/follow: follow or unfollow one pre-posting company for the
 * signed-in caller. RUN-FINISH 3.1, MASTER-SPEC F6; db/008_watchlist.sql.
 *
 * MOUNTED UNDER /prelist, NOT /api, FOR THE SAME FORCED REASON
 * src/pages/desk/save.ts is not under /api/desk. See src/pages/auth/
 * [...all].ts's header for the verified evidence: this repo's root api/
 * directory claims every /api/* path before Astro's router is ever
 * consulted, and the /jobs rewrite would land a request here as
 * /api/prelist/follow. Do not move this under /api.
 *
 * MOUNTED UNDER /prelist SPECIFICALLY SO ENTITLEMENT'S ONE ENTRY COVERS IT.
 * src/lib/entitlement.ts's '/prelist' ROUTE_POLICY entry gates this route by
 * prefix, the same way '/desk' covers desk/save.ts and desk/application.ts.
 * An endpoint outside a gated prefix would see Astro.locals.viewer === null
 * on every request, signed in or not, because middleware only resolves a
 * viewer for a path isGated() already says yes to (see needsViewer() in
 * middleware.ts).
 *
 * SCOPED TO THE PASS'S OWN PROSPECTS, ON PURPOSE. A follow is a bookmark
 * against one row of prospectRows() (src/lib/data.ts), and this route
 * resolves the posted prospectId against that list and refuses, quietly,
 * when nothing matches, rather than writing a watchlist row for a company
 * this database never scored. db/008_watchlist.sql's own comment explains
 * why prospect_id is not a foreign key: prospects.json is machine-owned and
 * regenerated wholesale every night, with no stable row for Postgres to
 * reference, so this application-layer check is the only validation there
 * is.
 *
 * WHO THIS CAN ACT ON. No id anywhere but in the POSTed body, and userId
 * comes only from Astro.locals.viewer, resolved server-side by middleware
 * before this file runs. Every watchlist-store.ts call below is scoped to
 * that userId.
 *
 * WORKS WITHOUT JAVASCRIPT. A plain HTML form posting here and redirecting
 * back to /prelist (see ProspectCard.astro), the same shape desk/save.ts
 * already uses for its own save/unsave intents.
 *
 * FOLLOWING TWICE IS A NO-OP, NOT AN ERROR. followProspect() upserts against
 * db/008_watchlist.sql's own primary key (user_id, prospect_id), so a
 * repeated 'follow' for a company already followed changes nothing and
 * still redirects back exactly as a first follow would.
 */
import type { APIContext } from 'astro';
import { prospectRows } from '../../lib/data';
import { followProspect, unfollowProspect } from '../../lib/watchlist-store';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const PRELIST_PATH = '/prelist';

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(path) } });
}

/** Where this action sends the reader back to: the same page they followed
    or unfollowed from, so the list does not jump to page one under them. */
function backTo(form: FormData): string {
  const page = Number(form.get('page'));
  return Number.isInteger(page) && page > 1 ? `${PRELIST_PATH}?page=${page}` : PRELIST_PATH;
}

/** True when prospectId names a row the last pass actually scored. A follow
    against anything else would be a bookmark with nothing behind it: no
    card to render, no fit to show, no basis to cite. */
function isKnownProspect(prospectId: string): boolean {
  return prospectRows().some((job) => job.id === prospectId);
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;

  if (!viewer || verdict?.allow !== true) {
    return new Response('Not signed in.', { status: 401 });
  }

  const userId = viewer.userId;
  const form = await context.request.formData();
  const intent = form.get('intent');
  const prospectId = String(form.get('prospectId') ?? '');
  const target = backTo(form);

  if (!prospectId || !isKnownProspect(prospectId)) {
    return redirect(target);
  }

  if (intent === 'follow') {
    await followProspect(userId, prospectId);
    return redirect(target);
  }

  if (intent === 'unfollow') {
    await unfollowProspect(userId, prospectId);
    return redirect(target);
  }

  return new Response('Unrecognised intent.', { status: 400 });
}
