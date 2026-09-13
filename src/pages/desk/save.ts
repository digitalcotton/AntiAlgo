/**
 * POST /desk/save: save or unsave one verified posting for the signed-in
 * caller. MASTER-SPEC 3.5, F4; db/006_desk.sql's desk_saved_job.
 *
 * ONE FILE, TWO INTENTS, THE SAME one-file-per-resource SHAPE
 * src/pages/profile/entry.ts and src/pages/profile/artifact.ts
 * already use: both actions act on the same resource (one desk_saved_job
 * row) and need the same preamble first (refuse a null viewer, never accept
 * a userId from the request).
 *
 * MOUNTED UNDER /desk, NOT /api, FOR THE SAME FORCED REASON
 * src/pages/profile/entry.ts is not under /api. See
 * src/pages/auth/[...all].ts's header for the verified evidence: this
 * repo's root api/ directory claims every /api/* path before Astro's router
 * is consulted, and the /jobs rewrite would land a request here as
 * /api/desk/save. Do not move this under /api.
 *
 * SCOPED TO THE SWEEP'S OWN JOBS, ON PURPOSE. A save is a bookmark against
 * one of our verified postings, matching db/006_desk.sql's own comment on
 * desk_saved_job: unlike an application (which F4.2 lets a person start from
 * any pasted URL), a save has nothing of ours to attach to a posting we
 * never verified. This route resolves the pasted URL against
 * src/lib/data.ts's own loadJobs() and refuses, quietly, when nothing
 * matches, rather than inventing a bookmark against a URL this database has
 * no record of.
 *
 * WHO THIS CAN ACT ON. No id anywhere but in the POSTed body, and userId
 * comes only from Astro.locals.viewer, resolved server-side by middleware
 * before this file runs ('/desk' is a gated prefix, and '/desk/save' matches
 * it by prefix, so no second ROUTE_POLICY entry is needed). Every
 * desk-store.ts call below is scoped to that userId.
 */
import type { APIContext } from 'astro';
import { loadJobs } from '../../lib/data';
import { saveJob, unsaveJob } from '../../lib/desk-store';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const DESK_PATH = '/desk';

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(path) } });
}

function backTo(form: FormData): string {
  const view = form.get('view');
  return view === 'table' ? `${DESK_PATH}?view=table` : DESK_PATH;
}

/** The same URL-to-verified-posting match desk/application.ts's click
    intent uses, kept as its own small function here rather than shared:
    two four-line matches are cheaper to read than a shared helper module
    for one predicate this small, and the two routes are not guaranteed to
    stay identical (a save is deliberately narrower than a click, per this
    file's own header). */
function jobForUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return null;
  return loadJobs().find((job) => job.apply_url === trimmed || job.source_url === trimmed) ?? null;
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
  const target = backTo(form);

  if (intent === 'save') {
    const url = String(form.get('url') ?? '');
    const job = jobForUrl(url);
    // No match: nothing is saved, and nothing is reported as saved. A save
    // against a posting this database never verified would be a bookmark
    // with no fate overlay and no auto-link behind it, which is exactly
    // the case db/006_desk.sql's own comment on desk_saved_job rules out.
    if (job) {
      await saveJob(userId, job.id);
    }
    return redirect(target);
  }

  if (intent === 'unsave') {
    const jobId = String(form.get('jobId') ?? '');
    if (jobId) {
      await unsaveJob(userId, jobId);
    }
    return redirect(target);
  }

  return new Response('Unrecognised intent.', { status: 400 });
}
