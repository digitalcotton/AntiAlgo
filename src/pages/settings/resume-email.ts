/**
 * POST /settings/resume-email: sets which email a drafted resume prints, and
 * the custom address it uses when that is not the login email. The write half
 * of src/pages/settings.astro's resume-email controls, read on the render side
 * by src/lib/record-store.ts's resolveResumeEmail() (through
 * generation-preference-store.ts's buildRenderHeader()).
 *
 * MOUNTED UNDER /settings, NOT /api, for the same forced reason
 * settings/generation.ts and settings/email.ts are; see either header.
 *
 * WHO THIS CAN ACT ON. No id anywhere but Astro.locals.viewer, resolved
 * server-side; '/settings' is a gated prefix, so '/settings/resume-email'
 * inherits it and needs no second policy entry.
 *
 * TOGGLE AND FIELD, THE db/016 RULE. The checkbox posts as presence
 * (form.has), the same way settings/generation.ts reads its own. The custom
 * field is always shown and always submitted, pre-filled with the stored
 * value, so writing it back is either a no-op (unchanged) or a real edit: a
 * person clears the custom email only by clearing the field, never by flipping
 * the switch. That is db/016's promise that toggling never deletes the custom
 * address, expressed as the one write below.
 */
import type { APIContext } from 'astro';
import { setResumeEmailSettings } from '../../lib/record-store';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const SETTINGS_PATH = '/settings';
const MAX_EMAIL_LENGTH = 320;

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
  const useLogin = form.has('resumeEmailUseLogin');
  const raw = typeof form.get('resumeEmail') === 'string' ? String(form.get('resumeEmail')).trim() : '';
  const custom = raw.length === 0 ? null : raw;

  // A light shape check, not an ownership proof: this is a display string the
  // person puts on their own resume, not an address this site sends mail to
  // (the change-email flow in settings/email.ts is the one that verifies an
  // address). It must look like an email and fit the column: one @, no
  // whitespace, within db/016's length cap.
  if (custom !== null && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(custom) || custom.length > MAX_EMAIL_LENGTH)) {
    return redirect(`${SETTINGS_PATH}?resume-email-error=invalid`);
  }

  await setResumeEmailSettings(viewer.userId, { useLogin, custom });
  return redirect(`${SETTINGS_PATH}?resume-email-updated=1`);
}
