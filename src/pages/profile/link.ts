/**
 * POST /profile/link: add or remove one of a person's job-related profile
 * links (GitHub, LinkedIn, a portfolio, and the rest). MASTER-SPEC 3.1's
 * Person, the identity above the record. See profile/artifact.ts's own header
 * for why a link like this is a separate file, and a separate table, from an
 * entry's own evidence: an artifact backs up one role, a profile link belongs
 * to the person.
 *
 * MOUNTED UNDER /profile, NOT /api, for the same forced reason export.ts,
 * delete.ts and profile/entry.ts are; see any of their headers for the
 * preview-deploy evidence.
 *
 * WHO THIS CAN ACT ON. Same rule as every other record endpoint: userId comes
 * only from Astro.locals.viewer, never the request body, and every
 * record-store.ts call is scoped to it.
 *
 * THE ONE DECISION THIS ROUTE MAKES, AND WHERE IT LIVES. Whether a typed
 * string is a URL safe to store and later render as an href is
 * src/lib/profile-links.ts's normaliseLinkUrl(), not this file: the same
 * split every record endpoint draws against record.ts. This route reads the
 * platform and the raw string, hands the string to that validator, and either
 * stores what it returns or relays the reason it refused. A javascript: or
 * data: URL is refused there, before a row is written, so it can never reach
 * the profile page as a live link.
 */
import type { APIContext } from 'astro';
import { addLink, removeLink } from '../../lib/record-store';
import { normaliseLinkUrl } from '../../lib/profile-links';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const RETURN_PATH = '/profile';
const RELAY_COOKIE = 'profile_link_relay';

interface RelayPayload {
  scope: 'link';
  url: string;
  reason: string;
}

function redirect(): Response {
  // Back to the links section by anchor, so a person who scrolled down to add
  // a link lands back where they were rather than at the top of the page.
  return new Response(null, { status: 303, headers: { Location: `${withBase(RETURN_PATH)}#links` } });
}

function setRelayCookie(context: APIContext, payload: RelayPayload): void {
  context.cookies.set(RELAY_COOKIE, JSON.stringify(payload), {
    // Scoped to the page that reads it, the literal '/profile', matching the
    // convention every other relay cookie on this page already uses (see
    // profile.astro's own header on the cookie-path trap).
    path: withBase(RETURN_PATH),
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    maxAge: 120
  });
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

  if (intent === 'remove') {
    const linkId = String(form.get('linkId') ?? '');
    if (linkId.length > 0) {
      await removeLink(userId, linkId);
    }
    return redirect();
  }

  if (intent === 'add') {
    const rawUrl = typeof form.get('url') === 'string' ? String(form.get('url')) : '';

    // The platform is no longer typed by a person: normaliseLinkUrl() reads it
    // off the URL's own hostname (detectPlatform), so the person pastes a link
    // and we know what it is. That is also where the http/https scheme check
    // lives, so a javascript: or data: URL is still refused here before storage.
    const result = normaliseLinkUrl(rawUrl);
    if (!result.ok) {
      // The typed value is relayed back so the person can see and fix it. A
      // link is not a secret the way a provider key is, so unlike the keys
      // relay this one may carry the input: it is the person's own public
      // URL, and showing it back is how they correct a typo.
      setRelayCookie(context, { scope: 'link', url: rawUrl, reason: result.reason });
      return redirect();
    }

    await addLink(userId, result.platform, result.url);
    return redirect();
  }

  return new Response('Unrecognised intent.', { status: 400 });
}
