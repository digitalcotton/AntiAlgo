/**
 * ledger-access.ts: who may use the Ledger. The Ledger is NOT in
 * entitlement.ts's ROUTE_POLICY on purpose: a gated route there redirects a
 * signed-out reader and 403s a non-paid one, but this page wants to render for
 * everyone and show a preview plus an upsell to a reader who is not paid yet.
 * So the gate is in the page and in the Ledger's own POST endpoints, and it is
 * this one predicate, written once.
 *
 * PAID IS A RANK, NOT A NAME. The check compares against the tier ladder in
 * entitlement.ts (public < waitlisted < member < paid < internal) rather than
 * testing tier === 'paid', so 'internal' (above paid) is admitted too and a
 * future tier inserted below paid is handled without editing this line. Email
 * verification is required, the same order entitlement.decide() uses: an
 * unverified account is a claim about an address nobody confirmed.
 */
import type { APIContext } from 'astro';
import { TIERS, type Viewer } from './entitlement';
import { viewerFrom } from './viewer';

const PAID_RANK = TIERS.indexOf('paid');
const MEMBER_RANK = TIERS.indexOf('member');

/** True when this viewer may see the full, personal Ledger. */
export function isPaidViewer(viewer: Viewer | null | undefined): viewer is Viewer {
  return Boolean(viewer) && Boolean(viewer!.emailVerified) && TIERS.indexOf(viewer!.tier) >= PAID_RANK;
}

/** True for a verified member or above: the free account's own rank. Same
    shape as isPaidViewer, one rung lower, for the endpoints the free account
    may use (naming titles, since the owner's free-account design of
    2026-09-20 puts the board's title menu on the free account). */
export function isMemberViewer(viewer: Viewer | null | undefined): viewer is Viewer {
  return Boolean(viewer) && Boolean(viewer!.emailVerified) && TIERS.indexOf(viewer!.tier) >= MEMBER_RANK;
}

/**
 * The paid viewer for a request, or null. Reads the viewer middleware already
 * resolved onto locals, and falls back to resolving it directly, so an endpoint
 * outside a gated prefix (where middleware may not have set locals.verdict) is
 * still safe on its own.
 */
export async function paidViewerFrom(context: APIContext): Promise<Viewer | null> {
  const onLocals = context.locals.viewer as Viewer | null | undefined;
  const viewer = onLocals ?? (await viewerFrom(context));
  return isPaidViewer(viewer) ? viewer : null;
}

/** The member (or above) viewer for a request, or null. The same resolution
    as paidViewerFrom, at the free account's rank. */
export async function memberViewerFrom(context: APIContext): Promise<Viewer | null> {
  const onLocals = context.locals.viewer as Viewer | null | undefined;
  const viewer = onLocals ?? (await viewerFrom(context));
  return isMemberViewer(viewer) ? viewer : null;
}
