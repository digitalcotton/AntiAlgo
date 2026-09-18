/**
 * GET /tasks/nudge: the scheduled confirm-loop nudge sender (F4.1's third
 * channel), behind the `email_send` flag. A Vercel cron (vercel.json) hits this
 * once a day; it finds the still-waiting Desk cards nobody has been nudged about,
 * groups them by person, and sends each person one gentle email to resolve them.
 *
 * WHY IT IS AN ASTRO ROUTE, NOT A ROOT api/ FUNCTION. Rendering an email reads
 * the generated token CSS off disk (emails/lib, the same loadTokens auth.ts uses
 * for the change-email message), which works inside the Astro server function
 * because the whole app is bundled there. A standalone Vercel function under
 * api/ bundles only what it imports and would not reliably carry that CSS or the
 * email stack, so this lives where the working email path already lives. It is
 * NOT under /api, which the root api/ directory shadows before Astro's router.
 *
 * THREE GATES, AND WHY EACH. (1) CRON_SECRET: the route is public by URL, so it
 * rejects any request without `Authorization: Bearer <CRON_SECRET>`. Vercel
 * attaches that header to cron invocations only when CRON_SECRET is set, so with
 * no secret configured nothing can trigger it, which is the safe default. (2)
 * The `email_send` flag: middleware already 404s this route when the flag is off
 * (FLAGGED_ROUTES), and the handler checks it too, so an off flag sends nothing
 * by two independent mechanisms. (3) RESEND_API_KEY: src/lib/email.ts throws
 * without it, so this endpoint checks for it first and no-ops with a logged
 * reason rather than throwing, which is what lets the feature ship on while it is
 * dormant, before the owner has set the key.
 *
 * ONE NUDGE PER CARD. A card is marked confirm_nudged_at (db/029) only after its
 * person's email is accepted, so a send failure leaves the card eligible for the
 * next run rather than silently swallowed, and a delivered card is never nudged
 * again.
 */
import type { APIRoute } from 'astro';
import { isOn } from '../../lib/flags';
import { sendMail } from '../../lib/email';
import { listUnconfirmedForNudge, markConfirmNudged, type NudgeCandidate } from '../../lib/desk-store';
import { routeFor } from '../../data/nav';
import { SITE, absoluteUrl } from '../../data/site';
import { loadTokens } from '../../../emails/lib/tokens.mjs';
import { typeRoles } from '../../../emails/lib/shell.mjs';
import { buildConfirmNudge } from '../../../emails/templates/confirm-nudge.mjs';

export const prerender = false;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

/** The email token kit, loaded once per warm invocation, exactly as auth.ts
    does it: reading src/styles/tokens.css lazily so nothing at build time
    depends on a generated file or a runtime secret. */
let emailTokens: { t: ReturnType<typeof loadTokens>; roles: ReturnType<typeof typeRoles> } | null = null;
function tokensForEmail() {
  if (!emailTokens) {
    const t = loadTokens(new URL('../../styles/tokens.css', import.meta.url));
    emailTokens = { t, roles: typeRoles(t) };
  }
  return emailTokens;
}

const DAY_MS = 86_400_000;
const daysSince = (when: Date): number => Math.max(1, Math.floor((Date.now() - when.getTime()) / DAY_MS));

/** Group the flat candidate list into one batch per person, preserving the
    query's order (most recent click first within a person). */
function groupByUser(candidates: NudgeCandidate[]): Map<string, NudgeCandidate[]> {
  const byUser = new Map<string, NudgeCandidate[]>();
  for (const candidate of candidates) {
    const existing = byUser.get(candidate.userId);
    if (existing) existing.push(candidate);
    else byUser.set(candidate.userId, [candidate]);
  }
  return byUser;
}

export const GET: APIRoute = async ({ request }) => {
  // (1) CRON_SECRET. No secret, or a mismatch, and nothing runs.
  const secret = (process.env.CRON_SECRET ?? '').trim();
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return json({ ok: false, reason: 'unauthorized' }, 401);
  }

  // (2) The flag. Redundant with middleware's 404, kept per the flag standard
  // (gate the handler, not only the render).
  if (!isOn('email_send')) {
    return json({ ok: true, sent: 0, reason: 'email_send is off' });
  }

  // (3) The key. Dormant until the owner sets it: no throw, a logged reason.
  if (!process.env.RESEND_API_KEY) {
    const reason = 'RESEND_API_KEY not set; confirm-loop nudges are dormant';
    console.log(`[tasks/nudge] ${reason}`);
    return json({ ok: true, sent: 0, reason });
  }

  const candidates = await listUnconfirmedForNudge();
  if (candidates.length === 0) {
    return json({ ok: true, sent: 0, users: 0, cards: 0 });
  }

  const { t, roles } = tokensForEmail();
  // The nudge is about pending application cards, which live on the Opportunities
  // tracker (formerly The Desk). buildConfirmNudge still names its param deskUrl.
  const deskUrl = absoluteUrl(routeFor('opportunities'));
  const byUser = groupByUser(candidates);

  let sent = 0;
  let failed = 0;
  let cards = 0;

  for (const [, items] of byUser) {
    const email = items[0].email;
    if (!email) continue;
    const pending = items.map((item) => ({ title: item.title, company: item.company, days: daysSince(item.clickedAt) }));
    const { subject, text, html } = buildConfirmNudge({ t, roles, site: SITE, pending, deskUrl });
    try {
      await sendMail({ to: email, subject, text, html });
      // Mark only after the mail service accepted it, so a failure retries next
      // run rather than being silently dropped.
      await markConfirmNudged(items.map((item) => item.applicationId), new Date());
      sent += 1;
      cards += items.length;
    } catch (error) {
      // One person's send failing must not stop the rest. Their cards stay
      // unnudged and come back next run.
      failed += 1;
      console.error(`[tasks/nudge] send failed for one recipient: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  return json({ ok: true, sent, failed, users: byUser.size, cards });
};
