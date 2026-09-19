/**
 * POST /desk/job-draft/<slug>/restore: make an earlier draft version the current
 * one (db/202). The room's "Earlier drafts are kept" panel posts here with the
 * kind and the version id to bring back. Viewer-scoped through
 * restoreJobRenderVersion, so a version id alone never touches a stranger's
 * draft, and a static segment like run.ts / status.ts so it wins over [doc].ts.
 *
 * The viewer is resolved by middleware (a gated /desk path); a member reaches
 * it. Astro's CSRF is off site-wide and the origin gate in src/middleware.ts
 * covers this POST. Whatever the outcome, it lands back on the draft room, which
 * renders the now-current version.
 */
import type { APIContext } from 'astro';
import { restoreJobRenderVersion, type RenderKind } from '../../../../lib/generated-render-store';
import { jobDraftPath } from '../../../../data/nav';

export const prerender = false;

function kindFrom(form: FormData): RenderKind {
  return form.get('kind') === 'cover' ? 'cover' : 'resume';
}

export async function GET(context: APIContext): Promise<Response> {
  // Any non-POST hit just goes back to the room rather than erroring.
  const slug = decodeURIComponent(context.params.slug ?? '');
  return context.redirect(jobDraftPath(slug), 303);
}

export async function POST(context: APIContext): Promise<Response> {
  const slug = decodeURIComponent(context.params.slug ?? '');
  try {
    const viewer = context.locals.viewer;
    if (!viewer) {
      return new Response('Not available on your account.', { status: 403 });
    }
    const form = await context.request.formData();
    const versionId = String(form.get('versionId') ?? '').trim();
    if (slug && versionId) {
      await restoreJobRenderVersion(viewer.userId, slug, kindFrom(form), versionId);
    }
  } catch (error) {
    // A transient failure must not become a 500 page: log it and return to the
    // room, which shows whatever the current version still is.
    console.error('desk/job-draft/restore: failed; returning to the room.', error);
  }
  return context.redirect(jobDraftPath(slug), 303);
}
