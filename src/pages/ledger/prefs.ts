/**
 * POST /ledger/prefs: save one of the signed-in paid reader's Desk filters. The
 * editor's "where" and "pay floor" controls each submit ONE field, so a click on
 * a pay-floor button must not clear the where choice and vice versa: this merges
 * the one field named in `field` onto the stored selection rather than rebuilding
 * the whole thing from the form. Same self-guard and routing reasons as
 * /ledger/watch (see its header): /ledger is not a gated prefix, so this resolves
 * the reader with paidViewerFrom and takes the userId from the viewer, never the
 * form.
 */
import type { APIContext } from 'astro';
import { paidViewerFrom } from '../../lib/ledger-access';
import { getPrefs, savePrefs, type LedgerSelection } from '../../lib/ledger-prefs-store';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const DESK_PATH = '/desk';
/** A sane ceiling so a fat-fingered pay floor cannot wall off the whole board. */
const COMP_FLOOR_MAX = 1_000_000;

function redirect(): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(DESK_PATH) } });
}

export async function POST(context: APIContext): Promise<Response> {
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
  return redirect();
}
