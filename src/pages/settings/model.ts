/**
 * POST /settings/model: records which model a person wants their drafting done
 * with, for one provider they hold a key for. The other half of the picker in
 * src/pages/settings.astro's "Drafting" panel, read back by
 * src/lib/generation-preference-store.ts's writingModelFor() every time a
 * resume or a cover letter is drafted.
 *
 * ONLY THE WRITING WORK IS A CHOICE. The resume read is transcription against
 * a verifier that discards anything not already in the source, so it is pinned
 * to each provider's cheapest tier in PROVIDER_REGISTRY and no request can
 * move it. There is no endpoint here, or anywhere, for choosing that one.
 *
 * D7 SURVIVES THIS INTACT, and the distinction is the whole reason this route
 * is allowed to exist. MASTER-SPEC D7 forbids a user-supplied ENDPOINT (a
 * custom "compatible endpoint" is a resume-harvesting proxy and an SSRF
 * vector) and says the verification layer runs "regardless of which model
 * produced it". A model id is not an address: it is a value SELECTED from a
 * list this codebase owns, checked against that list here and again in
 * setWritingModel() before it can be stored, and sent to the same four
 * hardcoded endpoints as before. A request that names a model we do not offer
 * is refused rather than stored.
 *
 * MOUNTED UNDER /settings, NOT /api, for the same forced reason
 * settings/generation.ts is: this repo's root api/ directory claims every
 * /api/* path before Astro's router runs. '/settings' is already a gated
 * prefix, so no second ROUTE_POLICY entry is needed.
 *
 * WHO THIS CAN ACT ON. No id anywhere but Astro.locals.viewer, resolved
 * server-side from the session before this file runs.
 */
import type { APIContext } from 'astro';
import { isKnownWritingModel } from '../../lib/generation-providers';
import { PROVIDERS, type Provider } from '../../lib/keychain';
import { setWritingModel } from '../../lib/keychain-store';
import { isOn } from '../../lib/flags';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const SETTINGS_PATH = '/settings';

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: `${withBase(path)}#keys` } });
}

/** The same shape settings/keys/save.ts checks a posted provider with. */
function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;

  if (!viewer || verdict?.allow !== true) {
    return new Response('Not signed in.', { status: 401 });
  }

  // The same server-side kill switch the key endpoint checks, not just a
  // hidden panel: with byok off there is no drafting to choose a model for.
  if (!isOn('byok')) {
    return new Response('Bring-your-own-key generation is off on this deployment.', { status: 403 });
  }

  const form = await context.request.formData();
  const providerField = form.get('provider');
  const modelField = form.get('model');

  if (!isProvider(providerField)) {
    return new Response('Unrecognised provider.', { status: 400 });
  }

  // The list is ours; this refuses anything not on it. setWritingModel()
  // checks the same thing again before it writes, which is not redundancy for
  // its own sake: this endpoint is one caller, and the store is the floor
  // under every caller there will ever be.
  if (typeof modelField !== 'string' || !isKnownWritingModel(providerField, modelField)) {
    return new Response('Unrecognised model.', { status: 400 });
  }

  const updated = await setWritingModel(viewer.userId, providerField, modelField);
  if (!updated) {
    // No key row for that provider: the picker only renders providers with a
    // key on file, so this is a stale form or a direct post. Nothing was
    // stored, and the page says so rather than claiming a save.
    return redirect(`${SETTINGS_PATH}?model-error=no-key`);
  }

  return redirect(`${SETTINGS_PATH}?model-updated=1`);
}
