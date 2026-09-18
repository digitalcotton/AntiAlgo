/**
 * POST /ledger/watch: add, remove or reshelf one watched title for the
 * signed-in paid caller. db/137_ledger_watch.sql; the store is
 * src/lib/ledger-watch-store.ts.
 *
 * NOT UNDER /api, for the same forced reason src/pages/prelist/follow.ts is
 * not: this repo's root api/ directory claims every /api/* path before Astro's
 * router. Mounted under /ledger with the page.
 *
 * GATED IN THIS FILE, NOT BY MIDDLEWARE. /ledger is deliberately absent from
 * entitlement.ts's ROUTE_POLICY (see src/lib/ledger-access.ts for why), so this
 * endpoint resolves the paid viewer itself via paidViewerFrom() rather than
 * trusting a verdict the middleware only sets for gated prefixes. userId comes
 * only from that resolved viewer, never from the POSTed body.
 *
 * WORKS WITHOUT JAVASCRIPT. A plain HTML form posting here and redirecting back
 * to /ledger, the same shape prelist/follow.ts uses.
 *
 * ADDING A TITLE ALREADY WATCHED MOVES ITS SHELF, IT IS NOT AN ERROR: the
 * store's upsert against (user_id, title) guarantees that (db/137).
 */
import type { APIContext } from 'astro';
import { addWatch, removeWatch, setShelf, type Shelf } from '../../lib/ledger-watch-store';
import { paidViewerFrom } from '../../lib/ledger-access';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const LEDGER_PATH = '/ledger';
const MAX_TITLE = 200;

function redirect(): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(LEDGER_PATH) } });
}

/** The shelf a form field names, defaulting to 'core' for anything else so a
    stray value never throws; the DB's own CHECK is the backstop. */
function shelfOf(value: FormDataEntryValue | null): Shelf {
  return value === 'stretch' ? 'stretch' : 'core';
}

/** A posted title, trimmed and bounded. Empty or over-long is rejected upstream
    by returning '', which every intent below treats as nothing to do. */
function titleOf(form: FormData): string {
  const raw = String(form.get('title') ?? '').trim();
  return raw.length >= 1 && raw.length <= MAX_TITLE ? raw : '';
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = await paidViewerFrom(context);
  if (!viewer) return new Response('Not available on your account.', { status: 403 });

  const form = await context.request.formData();
  const intent = form.get('intent');
  const title = titleOf(form);

  if (!title) return redirect();

  if (intent === 'add') {
    await addWatch(viewer.userId, title, shelfOf(form.get('shelf')));
    return redirect();
  }
  if (intent === 'reshelf') {
    await setShelf(viewer.userId, title, shelfOf(form.get('shelf')));
    return redirect();
  }
  if (intent === 'remove') {
    await removeWatch(viewer.userId, title);
    return redirect();
  }

  return new Response('Unrecognised intent.', { status: 400 });
}
