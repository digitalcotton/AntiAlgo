/**
 * /ledger/watch: add, remove, or reshelf one watched title for the signed-in
 * paid reader. The watch list this edits is the same one The Desk reads and the
 * one that narrows /board, so a change here changes both on the next render.
 *
 * NOT UNDER A GATED PREFIX, SO IT GUARDS ITSELF. /ledger is deliberately absent
 * from entitlement.ts ROUTE_POLICY (the page renders a preview for everyone), so
 * middleware sets no verdict and does NOT redirect a non-POST request the way it
 * does for the /desk/* endpoints. That is why this file also handles GET (any
 * non-POST just goes to the Desk) and wraps the whole POST in a try/catch that
 * falls back to the Desk: an ungated action endpoint must never crash the
 * function (a bare GET, a crawler, or a transient database hiccup would otherwise
 * surface as a raw 500 page instead of the Desk). The userId is the resolved
 * viewer's, never a form field.
 *
 * Mounted under /ledger, not /api, for the same routing reason desk/save.ts is
 * under /desk (see that file's header).
 */
import type { APIContext } from 'astro';
import { paidViewerFrom } from '../../lib/ledger-access';
import { addWatch, removeWatch, setShelf, type Shelf } from '../../lib/ledger-watch-store';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const DESK_PATH = '/desk';
/** ledger_watch.title is CHECK (length BETWEEN 1 AND 200); clamp so a long paste
    is trimmed rather than rejected by the database. */
const TITLE_MAX = 200;

function toDesk(): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(DESK_PATH) } });
}

/** Any non-POST hit (a bare browser GET, a crawler, a prefetch) goes to the Desk
    rather than crashing an ungated function with no method handler. */
export function GET(): Response {
  return toDesk();
}

function shelfFrom(form: FormData): Shelf {
  return form.get('shelf') === 'stretch' ? 'stretch' : 'core';
}

export async function POST(context: APIContext): Promise<Response> {
  try {
    const viewer = await paidViewerFrom(context);
    if (!viewer) {
      return new Response('Not available on your account.', { status: 403 });
    }

    const userId = viewer.userId;
    const form = await context.request.formData();
    const intent = form.get('intent');
    const title = String(form.get('title') ?? '').trim().slice(0, TITLE_MAX);

    if (intent === 'add') {
      if (title) await addWatch(userId, title, shelfFrom(form));
      return toDesk();
    }
    if (intent === 'reshelf') {
      if (title) await setShelf(userId, title, shelfFrom(form));
      return toDesk();
    }
    if (intent === 'remove') {
      if (title) await removeWatch(userId, title);
      return toDesk();
    }
    return new Response('Unrecognised intent.', { status: 400 });
  } catch (error) {
    // A transient database error must not become a raw 500 page: log it and send
    // the reader back to the Desk, which shows its own state.
    console.error('ledger/watch: failed; returning to the Desk.', error);
    return toDesk();
  }
}
