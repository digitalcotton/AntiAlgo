/**
 * POST /settings/email: request a change to the signed-in caller's email
 * address. Starts Better Auth's own two-step change-email flow; does
 * not, by itself, change anything in the database. See src/lib/auth.ts's
 * own `user.changeEmail` config and emails/templates/change-email.mjs's
 * header for the full sequence, verified against
 * node_modules/better-auth/dist/api/routes/update-user.mjs and
 * .../email-verification.mjs directly:
 *
 *   1. This route calls Better Auth's POST /change-email. Better Auth mails
 *      a confirmation to the OLD, currently-verified address (built by
 *      change-email.mjs, sent by auth.ts's sendChangeEmailConfirmationMail).
 *   2. Opening that link mails a second, ordinary verification link to the
 *      NEW address.
 *   3. Opening THAT link is what actually updates the row.
 *
 * So a 303 back to /settings after this route runs means "the first mail
 * went out", never "the email changed". settings.astro's own copy says
 * exactly that, not more.
 *
 * MOUNTED UNDER /settings, NOT /api, for the same forced reason every other
 * route in this task is; see record/entry.ts's own header for the
 * preview-deploy evidence.
 *
 * WHO THIS CAN ACT ON. No id anywhere but Astro.locals.viewer; Better
 * Auth's own POST /change-email reads the target user off the session
 * headers this route forwards, never off a body field, so there is nowhere
 * for a request to name a stranger's account either.
 *
 * SESSION FRESHNESS IS BETTER AUTH'S OWN RULE, NOT ONE THIS FILE ADDS.
 * /change-email runs behind `sensitiveSessionMiddleware`
 * (update-user.mjs), which refuses with SESSION_NOT_FRESH once the current
 * session is older than `session.freshAge` (default 24 hours, unset in
 * src/lib/auth.ts, so the default applies even though this app's sessions
 * themselves last seven days). A reader who has been signed in for more
 * than a day hits this on a real, active session; the message below says
 * "sign in again" rather than presenting it as an error with this form.
 */
import type { APIContext } from 'astro';
import { getAuth } from '../../lib/auth';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const SETTINGS_PATH = '/settings';

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(path) } });
}

/** Better Auth's APIError carries `.status` (a BASE_ERROR_CODES status
    string, e.g. "FORBIDDEN") and `.body.code`. Read defensively: this
    file's whole job here is turning a thrown error into one of a small,
    named set of query params settings.astro already knows how to render,
    never into a raw message from the library reaching a reader unfiltered. */
function errorCodeOf(error: unknown): string | null {
  const withCode = error as { body?: { code?: unknown } } | null;
  const code = withCode?.body?.code;
  return typeof code === 'string' ? code : null;
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;

  if (!viewer || verdict?.allow !== true) {
    return new Response('Not signed in.', { status: 401 });
  }

  const form = await context.request.formData();
  const newEmailRaw = form.get('newEmail');
  const newEmail = typeof newEmailRaw === 'string' ? newEmailRaw.trim() : '';

  if (!newEmail) {
    return redirect(`${SETTINGS_PATH}?email-error=empty`);
  }

  try {
    await getAuth().api.changeEmail({
      headers: context.request.headers,
      body: {
        newEmail,
        // Where Better Auth sends a reader once the whole two-step flow
        // finishes (see this file's own header). Base-included, matching
        // every other callbackURL this codebase builds (src/lib/auth.ts's
        // own withCallback()).
        callbackURL: withBase(SETTINGS_PATH)
      }
    });
  } catch (error) {
    const code = errorCodeOf(error);
    console.error('settings/email: change-email request failed.', code ?? error);

    if (code === 'SESSION_NOT_FRESH') {
      return redirect(`${SETTINGS_PATH}?email-error=stale-session`);
    }
    // Better Auth's own change-email handler treats "new email belongs to
    // an existing account" the same way as success (see this file's own
    // header): it never throws for that case, on purpose, to avoid leaking
    // which addresses have accounts. So an actual thrown error here is
    // always one of: same as current email, an address that fails Better
    // Auth's own email().parse(), or change-email genuinely disabled. All
    // three render as the same generic message; the distinction is not
    // worth surfacing to a reader over what is already a rare path.
    return redirect(`${SETTINGS_PATH}?email-error=request-failed`);
  }

  return redirect(`${SETTINGS_PATH}?email-requested=1`);
}
