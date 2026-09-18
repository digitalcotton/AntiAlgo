/**
 * POST /ledger/prefs: save the signed-in paid reader's Desk filters (remote only,
 * pay floor). These narrow The Desk's own read of the roles under the reader's
 * titles. Same self-guard and routing reasons as /ledger/watch (see its header):
 * /ledger is not a gated prefix, so this resolves the reader with paidViewerFrom
 * and the userId is the viewer's, never a form field.
 *
 * The selection is REBUILT from the form each save (an unchecked box sends
 * nothing, so it must clear, not persist), merged onto the stored selection so a
 * field this form does not edit (country) is not dropped. ledger-prefs-store
 * persists whatever object it is handed, so the narrowing to real board fields
 * happens here.
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

  const existing = (await getPrefs(userId))?.selection ?? {};
  const next: LedgerSelection = { ...existing };

  // A checkbox that is off sends no field, so the absence must clear it.
  if (form.get('remoteOnly')) next.remoteOnly = true;
  else delete next.remoteOnly;

  const rawFloor = Number(form.get('compFloor'));
  if (Number.isFinite(rawFloor) && rawFloor > 0) {
    next.compFloor = Math.min(Math.floor(rawFloor), COMP_FLOOR_MAX);
  } else {
    delete next.compFloor;
  }

  await savePrefs(userId, next);
  return redirect();
}
