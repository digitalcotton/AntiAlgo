/**
 * The one capture endpoint.
 *
 * Same shape as the mothership's `site/api/subscribe.ts`, which this follows
 * deliberately: a Vercel function at the repository root rather than an Astro
 * route, because the site is a static build of a nightly sweep and adding a
 * server adapter to serve one POST would turn every page into a rendered
 * response. The function sits beside the build; the build stays static.
 *
 * WHAT IS DIFFERENT HERE, AND WHY
 *
 * The mothership captures an address and nothing else. The Index captures an
 * address plus two consents, because it sends two different things and a reader
 * should be able to want one without the other:
 *
 *   digest  the weekly roundup. On by default, and the default is stated on the
 *           form rather than assumed by this endpoint.
 *   alerts  one mail per matching role, which only means anything alongside the
 *           filter state that defines "matching". The filter string is stored
 *           with the consent and is dropped when the consent is absent, because
 *           a stored filter with nobody subscribed to it is data held for no
 *           stated reason.
 *
 * No accounts, no password, no profile. The address plus two booleans plus a
 * string is the entire record, and every one of them came from a control the
 * reader operated.
 *
 * FOUR OUTCOMES, EACH ONE A REAL STATE
 *
 *   #joined   the platform accepted it
 *   #pending  no sending platform is connected, so nothing was stored, and the
 *             form says exactly that
 *   #pick     neither consent was given, so there was nothing to subscribe to
 *   #retry    it failed
 *
 * `#pending` is the one worth defending. The obvious stub returns success and
 * shows "You are in" while dropping the address on the floor, which is a lie
 * told by a site whose entire argument is that it does not tell them. See
 * DECISIONS.md, and the Blocked entry naming what is needed to retire it.
 */

export const config = { runtime: 'edge' };

// One @, no whitespace, a dot in the domain. The real verification is the
// platform's double opt-in; this only refuses obvious non-addresses.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Outcome = 'joined' | 'pending' | 'pick' | 'retry';

/**
 * Where to land after the POST: back on the page the form was on. Only the
 * referrer's path is kept, so the redirect can never leave the site.
 */
function returnPath(request: Request): string {
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const path = new URL(referer).pathname;
      if (path.startsWith('/') && !path.startsWith('//')) return path;
    } catch {
      // An unparseable referrer falls through to the default.
    }
  }
  return '/';
}

const seeOther = (path: string, outcome: Outcome): Response =>
  new Response(null, { status: 303, headers: { Location: `${path}#${outcome}` } });

/**
 * The placements a form is allowed to name.
 *
 * An unlisted value still goes through, so a typo can never cost a signup, but
 * it is logged so the typo shows up in the function logs rather than quietly
 * becoming a new column in the mailing list.
 */
const APPROVED_PLACEMENTS = new Set(['site', 'index', 'desk', 'kills', 'report']);

/** Lowercase, trim, cap. Anything from a URL a stranger can edit gets this. */
function normalize(value: FormDataEntryValue | null, limit = 64): string {
  return String(value ?? '').trim().toLowerCase().slice(0, limit);
}

/** A checkbox is present or it is not. Nothing here infers a consent. */
const checked = (value: FormDataEntryValue | null): boolean => value !== null && String(value) !== '';

/**
 * The filter state, kept only in the shape the capture module produces.
 *
 * That string is written by `filterGroups()` labels joined with a middle dot:
 * "Location: Remote / Comp: Range posted". Stripping anything outside letters,
 * digits, spaces and that small punctuation set means a hand-edited form field
 * cannot post arbitrary text into the mailing list under a field name that
 * claims to be a filter.
 */
function cleanFilters(value: FormDataEntryValue | null): string {
  return String(value ?? '')
    .trim()
    .replace(/[^\w\s:,.()+·-]/g, '')
    .slice(0, 200);
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const path = returnPath(request);

  try {
    const form = await request.formData();

    // The honeypot: a hidden field no person ever fills. A submission that fills
    // it gets the success response and nothing else; the address is dropped.
    if (String(form.get('website') ?? '') !== '') {
      return seeOther(path, 'joined');
    }

    const email = String(form.get('email') ?? '').trim();
    if (email.length > 254 || !EMAIL_SHAPE.test(email)) {
      return seeOther(path, 'retry');
    }

    const wantsDigest = checked(form.get('digest'));
    const wantsAlerts = checked(form.get('alerts'));
    if (!wantsDigest && !wantsAlerts) {
      return seeOther(path, 'pick');
    }

    // The filter string belongs to the alert consent and travels with it. With
    // no alert consent there is no alert to define, so the string is discarded
    // here rather than stored against an address that will never be matched.
    const filters = wantsAlerts ? cleanFilters(form.get('filters')) : '';

    // Which surface carried the form. The channel a reader arrived through is a
    // different question and arrives, when it arrives at all, as utm_source.
    // With no script injecting one, "site" is the honest default and it is the
    // label this property uses.
    const placement = normalize(form.get('source')) || 'site';
    if (!APPROVED_PLACEMENTS.has(placement)) {
      // The address is never logged, only the offending label.
      console.warn(`[subscribe] unapproved placement: ${JSON.stringify(placement)}`);
    }
    const channel = normalize(form.get('utm_source')) || 'site';
    const medium = normalize(form.get('utm_medium'));
    const campaign = normalize(form.get('utm_campaign'));

    // Trimmed: a pasted value can carry a trailing newline, which makes an
    // otherwise correct key fail authentication.
    const publicationId = (process.env.BEEHIIV_PUBLICATION_ID ?? '').trim();
    const apiKey = (process.env.BEEHIIV_API_KEY ?? '').trim();

    if (!publicationId || !apiKey) {
      // The stub. Nothing is stored and the form says so. The shape of what
      // would have been sent is logged, without the address, so the wiring can
      // be proved end to end before a key exists.
      console.warn(
        `[subscribe] no sending platform configured, nothing stored. placement=${placement} digest=${wantsDigest} alerts=${wantsAlerts} filters=${JSON.stringify(filters)}`
      );
      return seeOther(path, 'pending');
    }

    // Field names follow beehiiv's POST /v2/publications/{id}/subscriptions.
    // `custom_fields` carries the two consents and the filter string; those
    // three fields have to exist on the publication first or beehiiv drops them
    // silently. Flagged in emails/README.md, because nothing in this repository
    // has been able to check them against a live account.
    const customFields: Array<{ name: string; value: string }> = [
      { name: 'weekly_digest', value: String(wantsDigest) },
      { name: 'instant_alerts', value: String(wantsAlerts) }
    ];
    if (filters) customFields.push({ name: 'alert_filters', value: filters });

    const response = await fetch(`https://api.beehiiv.com/v2/publications/${publicationId}/subscriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        utm_source: channel,
        ...(medium ? { utm_medium: medium } : {}),
        ...(campaign ? { utm_campaign: campaign } : {}),
        utm_content: placement,
        reactivate_existing: true,
        send_welcome_email: true,
        custom_fields: customFields
      })
    });

    // A duplicate reads as success: the reader is on the list either way.
    if (response.ok || response.status === 409) {
      return seeOther(path, 'joined');
    }
    return seeOther(path, 'retry');
  } catch {
    return seeOther(path, 'retry');
  }
}
