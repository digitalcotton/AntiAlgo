/**
 * POST /ledger/prefs: save the signed-in paid caller's Ledger chips. The chips
 * are real board fields only (remote, a comp floor, a country), never a
 * re-weighting of the fit score: the fit components are derived from the rubric
 * weights upstream and not yet measured, so re-weighting them would be a number
 * this site cannot stand behind. db/138_ledger_prefs.sql; the store is
 * src/lib/ledger-prefs-store.ts.
 *
 * Same gating and no-JS shape as src/pages/ledger/watch.ts: not under /api,
 * paid viewer resolved in this file, plain form POST redirecting back to
 * /ledger. userId comes from the resolved viewer, never from the body.
 */
import type { APIContext } from 'astro';
import { savePrefs, type LedgerSelection } from '../../lib/ledger-prefs-store';
import { paidViewerFrom } from '../../lib/ledger-access';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const LEDGER_PATH = '/ledger';

function redirect(): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(LEDGER_PATH) } });
}

/** A posted comp floor as a non-negative whole number, or undefined when the
    field is blank or not a number: an absent floor means "no floor", never
    zero, so the chip can be cleared. */
function compFloorOf(value: FormDataEntryValue | null): number | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** A posted country, trimmed and bounded, or undefined for "all". */
function countryOf(value: FormDataEntryValue | null): string | undefined {
  const raw = String(value ?? '').trim();
  return raw.length >= 1 && raw.length <= 100 ? raw : undefined;
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = await paidViewerFrom(context);
  if (!viewer) return new Response('Not available on your account.', { status: 403 });

  const form = await context.request.formData();

  // Only the keys we recognise are persisted; an absent key is a cleared chip,
  // not a preserved one, so the saved selection always reflects the form.
  const selection: LedgerSelection = {};
  if (form.get('remoteOnly') != null) selection.remoteOnly = true;
  const compFloor = compFloorOf(form.get('compFloor'));
  if (compFloor !== undefined) selection.compFloor = compFloor;
  const country = countryOf(form.get('country'));
  if (country !== undefined) selection.country = country;

  await savePrefs(viewer.userId, selection);
  return redirect();
}
