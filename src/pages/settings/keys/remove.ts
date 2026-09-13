/**
 * POST /settings/keys/remove: permanently delete one provider key for the
 * signed-in caller. MASTER-SPEC decision D7.
 *
 * WHY THIS IS ITS OWN FILE, NOT A THIRD INTENT ON save.ts. save.ts's job is
 * "take a plaintext key and decide whether it is fit to store"; this file's
 * job is "destroy a row and never ask for a plaintext key at all". Folding
 * them into one handler would mean the destructive path shares a function
 * with the one path in this feature that ever touches a plaintext key,
 * which is exactly the kind of accidental proximity keychain.ts's own
 * header warns against for the encrypt/decrypt split. Two small files, each
 * doing one thing, is safer here than one file doing two.
 *
 * NO SECOND CONFIRMATION FIELD ON THIS REQUEST, AND THAT IS DELIBERATE.
 * settings.astro's per-key <details>/<summary> disclosure is the
 * confirmation: the first click reveals exactly what is about to be lost,
 * and the button inside that reveal is the second, deliberate click that
 * actually submits this POST. That is the same two-step shape the same
 * page's own account-deletion disclosure and record.astro's own entry
 * deletion already use, and record/entry.ts's intent=delete branch does not
 * ask for an extra confirm field either, for the same reason: the UI's two
 * clicks are the confirmation, not a third form field this endpoint would
 * have to trust anyway.
 *
 * WHO THIS CAN ACT ON. No id anywhere but in the POSTed body, and the body
 * is never trusted for whose account this is: userId comes only from
 * Astro.locals.viewer, resolved server-side from the session before this
 * file runs ('/settings' is a gated prefix, and '/settings/keys/remove'
 * matches it by prefix, so no second ROUTE_POLICY entry is needed).
 * deleteKey() scopes its DELETE to that userId, so a provider value alone
 * can never reach or remove a stranger's key.
 *
 * deleteKey()'s return (whether a row actually existed) is not branched on:
 * removing a key that is already gone and removing a key that existed both
 * redirect the same way, the same "gone either way" shape record/entry.ts's
 * own intent=delete uses for the same reason.
 *
 * NO `byok` FLAG CHECK HERE, UNLIKE save.ts, AND THAT IS DELIBERATE. save.ts
 * refuses to write while the flag is off, because `byok` is the kill switch
 * over bring-your-own-key generation and use. Removal is neither: it is a
 * person taking their own credential out of this database, and settings.astro's
 * own disclosure promises "removing a key here removes it for good" with no
 * caveat for a feature switch. Blocking that promise behind the same flag
 * that stops new keys from being stored would strand an existing key here
 * against its owner's wishes for as long as the flag stayed off, which is
 * the opposite of what a kill switch over a custody feature should do.
 */
import type { APIContext } from 'astro';
import { PROVIDERS, type Provider } from '../../../lib/keychain';
import { deleteKey } from '../../../lib/keychain-store';
import { withBase } from '../../../../site.config.mjs';

export const prerender = false;

const KEYS_PATH = '/settings';

function redirect(): Response {
  // Back to the key section, not the top of the settings page. The #keys
  // fragment matches the id on settings.astro's .keys-block, which carries a
  // scroll-margin that clears the sticky header.
  return new Response(null, { status: 303, headers: { Location: `${withBase(KEYS_PATH)}#keys` } });
}

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;

  if (!viewer || verdict?.allow !== true) {
    return new Response('Not signed in.', { status: 401 });
  }

  const form = await context.request.formData();
  const providerField = form.get('provider');

  if (!isProvider(providerField)) {
    return new Response('Unrecognised provider.', { status: 400 });
  }

  await deleteKey(viewer.userId, providerField);
  return redirect();
}
