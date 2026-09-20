/**
 * /ledger/prefs: save one of the signed-in paid reader's Desk filters. The
 * editor's "where" and "pay floor" controls each submit ONE field, so a click on
 * a pay-floor button must not clear the where choice and vice versa: this merges
 * the one field named in `field` onto the stored selection.
 *
 * NOT UNDER A GATED PREFIX, SO IT GUARDS ITSELF (see /ledger/watch's header for
 * the full reasoning): it handles GET by going to the Desk and wraps POST in a
 * try/catch that falls back to the Desk, so an ungated action endpoint never
 * crashes the function into a raw 500 page. userId is the viewer's, never a form
 * field.
 */
import type { APIContext } from 'astro';
import { paidViewerFrom } from '../../lib/ledger-access';
import { getPrefs, savePrefs, type LedgerSelection } from '../../lib/ledger-prefs-store';
import { returnTo } from '../../lib/return-to';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const DESK_PATH = '/desk';
/** A sane ceiling so a fat-fingered pay floor cannot wall off the whole board. */
const COMP_FLOOR_MAX = 1_000_000;

function toDesk(): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(DESK_PATH) } });
}

/** Any non-POST hit goes to the Desk rather than crashing an ungated function. */
export function GET(): Response {
  return toDesk();
}

export async function POST(context: APIContext): Promise<Response> {
  try {
    const viewer = await paidViewerFrom(context);
    if (!viewer) {
      return new Response('Not available on your account.', { status: 403 });
    }

    const userId = viewer.userId;
    const form = await context.request.formData();
    const field = String(form.get('field') ?? '');
    const value = String(form.get('value') ?? '');

    const next: LedgerSelection = { ...((await getPrefs(userId))?.selection ?? {}) };

    if (field === 'remote') {
      // "remote only" sets it; "anywhere" clears it.
      if (value === '1') next.remoteOnly = true;
      else delete next.remoteOnly;
    } else if (field === 'floor') {
      const floor = Number(value);
      if (Number.isFinite(floor) && floor > 0) next.compFloor = Math.min(Math.floor(floor), COMP_FLOOR_MAX);
      else delete next.compFloor;
    } else {
      return new Response('Unrecognised field.', { status: 400 });
    }

    await savePrefs(userId, next);
    // Back to the page that posted: the Desk unless the form carried an
    // allowed `return` (Come ready, /start, sets the same controls).
    return new Response(null, { status: 303, headers: { Location: withBase(returnTo(form, DESK_PATH)) } });
  } catch (error) {
    console.error('ledger/prefs: failed; returning to the Desk.', error);
    return toDesk();
  }
}
