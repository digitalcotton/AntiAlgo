/**
 * POST /settings/name: change the signed-in caller's name. The gap the
 * owner named directly: "there is no way to edit your name after sign-up."
 *
 * MOUNTED UNDER /settings, NOT /api, FOR THE SAME FORCED REASON export.ts,
 * delete.ts, record/entry.ts AND record/artifact.ts ARE. See any of those
 * files' own headers for the preview-deploy evidence: this repo's root
 * api/ directory claims every /api/* path before Astro's router runs.
 *
 * WHO THIS CAN ACT ON. No id anywhere but Astro.locals.viewer, resolved
 * server-side from the session before this file runs ('/settings' is a
 * gated prefix, and '/settings/name' matches it by prefix, so no second
 * ROUTE_POLICY entry is needed). There is nowhere to put a stranger's
 * user id even if a request tried to.
 *
 * STORED VERBATIM, PER RUN-FINISH 2.1. Every field this form submits is run
 * through src/lib/auth.ts's sanitiseNameForStorage(), the safety-only half
 * of that file's name cleaning (control characters flattened, length capped
 * at the database's own CHECK constraint), never through sanitiseName(),
 * which additionally collapses whitespace and trims the ends. That
 * additional cleaning is correct for a name typed once at sign-up
 * (namesFrom(), the same file); it would be a silent violation of 2.1 here,
 * where the person is deliberately typing their name again, on purpose,
 * possibly to fix exactly the kind of leading or trailing detail a lesser
 * settings form would "helpfully" strip back out. See sanitiseNameForStorage()'s
 * own comment for the full reasoning.
 *
 * TWO WRITES, ONE PERSON FACT. app_user_profile.first_name/last_name (via
 * src/lib/record-store.ts's setPersonName(), added alongside this file) is
 * this app's own record and the one MASTER-SPEC 3.1 (Person) and every
 * outreach draft actually reads. Better Auth's own `user.name` is a
 * separate, required string the library keeps for its own purposes; it is
 * updated here too, composed from the same two verbatim parts with a single
 * joining space and nothing else touched, so the one place inside this
 * codebase that still reads Better Auth's name (none, inside this task's
 * file list, today) cannot see it silently drift out of date the day one
 * does. Neither write depends on the other's success; see the two try/catch
 * blocks below for what each failure means on its own.
 */
import type { APIContext } from 'astro';
import { getAuth, sanitiseNameForStorage } from '../../lib/auth';
import { setPersonName } from '../../lib/record-store';
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
  const firstNameRaw = form.get('firstName');
  const lastNameRaw = form.get('lastName');
  const firstName = sanitiseNameForStorage(typeof firstNameRaw === 'string' ? firstNameRaw : '');
  const lastName = sanitiseNameForStorage(typeof lastNameRaw === 'string' ? lastNameRaw : '');

  const updated = await setPersonName(viewer.userId, firstName, lastName);
  if (!updated) {
    // No app_user_profile row for this user id. Every account gets one at
    // creation (see record-store.ts's own createEntry() comment on the
    // identical invariant), so this means something went wrong rather than
    // that this person is new; nothing here can repair that, so the
    // response says so rather than claiming a save that did not happen.
    console.error(`settings/name: setPersonName found no app_user_profile row for user ${viewer.userId}.`);
    return redirect(`${SETTINGS_PATH}?name-error=1`);
  }

  // Best-effort sync into Better Auth's own `name` field. A failure here
  // does not undo the write above: app_user_profile is this app's own
  // record and already holds the truth, and Better Auth's copy is a
  // secondary convenience nothing in this task's file list currently reads.
  // Logged, not surfaced as the whole request having failed.
  try {
    await getAuth().api.updateUser({
      headers: context.request.headers,
      body: { name: `${firstName} ${lastName}` }
    });
  } catch (error) {
    console.error('settings/name: app_user_profile updated, but syncing Better Auth\'s user.name failed.', error);
  }

  return redirect(`${SETTINGS_PATH}?name-updated=1`);
}
