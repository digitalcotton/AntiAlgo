/**
 * POST /ledger/watch: add, remove, or reshelf one watched title for the signed-in
 * paid reader. The watch list this edits is the same one The Desk reads and the
 * one that narrows /board (job-store listBoardFiltered titles), so a change here
 * changes both surfaces on the next render.
 *
 * NOT UNDER A GATED PREFIX. /ledger is deliberately absent from entitlement.ts
 * ROUTE_POLICY (the page renders a preview for everyone), so middleware sets no
 * verdict here. This endpoint resolves the reader itself with paidViewerFrom and
 * refuses a non-paid caller, the same self-guard the Ledger's own surfaces use.
 * The userId is the resolved viewer's, never a form field.
 *
 * Mounted under /ledger, not /api, for the same routing reason desk/save.ts is
 * under /desk (see that file's header): the root api/ directory would claim an
 * /api/* path before Astro's router runs.
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

function redirect(): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(DESK_PATH) } });
}

function shelfFrom(form: FormData): Shelf {
  return form.get('shelf') === 'stretch' ? 'stretch' : 'core';
}

export async function POST(context: APIContext): Promise<Response> {
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
    return redirect();
  }

  if (intent === 'reshelf') {
    if (title) await setShelf(userId, title, shelfFrom(form));
    return redirect();
  }

  if (intent === 'remove') {
    if (title) await removeWatch(userId, title);
    return redirect();
  }

  return new Response('Unrecognised intent.', { status: 400 });
}
