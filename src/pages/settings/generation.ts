/**
 * POST /settings/generation: turns "draft my resume and cover letter when
 * I apply" on or off for the signed-in account. The other half of the
 * setting src/pages/settings.astro's "Drafting" panel writes to, and
 * src/pages/desk/application.ts's 'click' intent reads (through
 * src/lib/generation-preference-store.ts's getGenerationPreference())
 * before it will ever attempt a background render.
 *
 * MOUNTED UNDER /settings, NOT /api, FOR THE SAME FORCED REASON
 * settings/name.ts, settings/email.ts AND settings/handle.ts ARE. See any
 * of those files' own headers for the preview-deploy evidence: this
 * repo's root api/ directory claims every /api/* path before Astro's
 * router runs.
 *
 * WHO THIS CAN ACT ON. No id anywhere but Astro.locals.viewer, resolved
 * server-side from the session before this file runs ('/settings' is a
 * gated prefix, and '/settings/generation' matches it by prefix, so no
 * second ROUTE_POLICY entry is needed). There is nowhere to put a
 * stranger's user id even if a request tried to.
 *
 * A CHECKBOX, READ THE WAY A CHECKBOX ACTUALLY POSTS. An unchecked HTML
 * checkbox sends no field at all, not `generateOnApply=false`; this is why
 * the read below is `form.has('generateOnApply')` (present, in any value,
 * means checked) rather than reading a value and comparing it to a
 * string. The settings.astro form supplies no explicit `value` other than
 * the browser's own default 'on', so this file does not depend on that
 * default either: presence is the only signal it trusts.
 *
 * SETTING THIS ON DOES NOT GENERATE ANYTHING, HERE OR EVER, ON ITS OWN.
 * This route writes one boolean and redirects. src/lib/
 * generation-preference.ts's decideGenerationTrigger() treats this
 * preference as one of four required gates, never as a trigger by itself;
 * see that file's own header.
 */
import type { APIContext } from 'astro';
import { setGenerationPreference } from '../../lib/generation-preference-store';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const SETTINGS_PATH = '/settings';

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(path) } });
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;

  if (!viewer || verdict?.allow !== true) {
    return new Response('Not signed in.', { status: 401 });
  }

  const form = await context.request.formData();
  const enabled = form.has('generateOnApply');

  const updated = await setGenerationPreference(viewer.userId, enabled);
  if (!updated) {
    // Same "no app_user_profile row" edge settings/handle.ts's own header
    // names: every account gets one at creation, so this means something
    // went wrong rather than that this person is new. Nothing here can
    // repair that; the response says so rather than claiming a save that
    // did not happen.
    console.error(`settings/generation: setGenerationPreference found no app_user_profile row for user ${viewer.userId}.`);
    return redirect(`${SETTINGS_PATH}?generation-error=no-profile`);
  }

  return redirect(`${SETTINGS_PATH}?generation-updated=1`);
}
