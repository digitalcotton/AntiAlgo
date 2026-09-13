/**
 * POST /settings/handle: claim, change, or release the signed-in account's
 * /u/<handle>. MASTER-SPEC F8's acceptance line covers the route
 * (src/pages/u/[handle].astro); this is the other half, the form a
 * person actually uses to choose the value that route later checks
 * ownership against.
 *
 * MOUNTED UNDER /settings, NOT /api, FOR THE SAME FORCED REASON export.ts,
 * delete.ts, settings/name.ts AND settings/email.ts ARE. See any of those
 * files' own headers for the preview-deploy evidence: this repo's root
 * api/ directory claims every /api/* path before Astro's router runs.
 *
 * WHO THIS CAN ACT ON. No id anywhere but Astro.locals.viewer, resolved
 * server-side from the session before this file runs ('/settings' is a
 * gated prefix, and '/settings/handle' matches it by prefix, so no
 * second ROUTE_POLICY entry is needed). There is nowhere to put a
 * stranger's user id even if a request tried to.
 *
 * NEVER REVEALS WHOSE HANDLE IT IS. src/lib/record-store.ts's setHandle()
 * already collapses a unique-constraint failure to the single result
 * 'taken', with no owner attached; this route repeats that discipline on
 * the way out, turning 'taken' into one fixed message that says only that
 * the handle is unavailable, never who holds it and never whether the
 * caller already holds it themselves under a different case.
 *
 * BLANK CLEARS, RATHER THAN BEING A VALIDATION ERROR. A person who wants
 * no public handle at all should be able to say so by submitting an empty
 * field, not by being told an empty string is an invalid format for
 * something they were trying to remove. See record-store.ts's own
 * clearHandle(), kept as a separate function from setHandle() for the
 * identical reason: "give this up" is a different request from "here is a
 * new value", and conflating them would make the empty-string branch of
 * setHandle() carry a special case validateHandleFormat() itself should
 * never have to know about.
 *
 * WHY THE SUBMITTED VALUE IS TRIMMED BEFORE ANYTHING ELSE. This is not
 * RUN-FINISH 2.1's verbatim-storage rule: that rule is about a person's
 * NAME, and this task's own brief is explicit that "a handle is different
 * from a name". A handle is a constrained-alphabet identifier, not free
 * text someone is being quoted back, so trimming incidental leading or
 * trailing whitespace (the kind a paste or an autocomplete leaves behind)
 * is a kindness to the format check, not a cleanup of what somebody
 * "said they are called". Nothing here collapses interior whitespace or
 * changes case beyond the fold setHandle() itself already performs.
 */
import type { APIContext } from 'astro';
import { clearHandle, setHandle } from '../../lib/record-store';
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
  const raw = form.get('handle');
  const typed = typeof raw === 'string' ? raw.trim() : '';

  if (typed === '') {
    await clearHandle(viewer.userId);
    return redirect(`${SETTINGS_PATH}?handle-cleared=1`);
  }

  const result = await setHandle(viewer.userId, typed);

  if (result === 'ok') {
    return redirect(`${SETTINGS_PATH}?handle-updated=1`);
  }
  if (result === 'taken') {
    return redirect(`${SETTINGS_PATH}?handle-error=taken`);
  }
  if (result === 'invalid') {
    return redirect(`${SETTINGS_PATH}?handle-error=invalid`);
  }

  // 'no-profile-row': every account gets an app_user_profile row at
  // creation (see record-store.ts's own createEntry() comment on the
  // identical invariant), so this means something went wrong rather than
  // that this person is new; nothing here can repair that, so the
  // response says so rather than claiming a save that did not happen.
  console.error(`settings/handle: setHandle found no app_user_profile row for user ${viewer.userId}.`);
  return redirect(`${SETTINGS_PATH}?handle-error=no-profile`);
}
