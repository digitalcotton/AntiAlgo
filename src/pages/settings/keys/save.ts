/**
 * POST /settings/keys/save: add or replace one provider key for the
 * signed-in caller. MASTER-SPEC decision D7. Add and replace are the same
 * request: keychain-store.ts's putKey() upserts on (userId, provider), so
 * a second submission for a provider that already has a key on file is a
 * rotation, not a duplicate, and this file does not need to know which of
 * the two it is doing.
 *
 * MOUNTED UNDER /settings, NOT /api, FOR THE SAME FORCED REASON export.ts,
 * delete.ts, and record/entry.ts ARE. See any of those files' own header
 * for the preview-deploy evidence: this repo's root api/ directory claims
 * every /api/* path before Astro's router runs. Do not move this back
 * under /api.
 *
 * WHO THIS CAN ACT ON. No id anywhere but in the POSTed body, and the body
 * is never trusted for whose account this is: userId comes only from
 * Astro.locals.viewer, resolved server-side from the session before this
 * file runs ('/settings' is a gated prefix, and '/settings/keys/save'
 * matches it by prefix, so no second ROUTE_POLICY entry is needed).
 *
 * THE TWO-MOMENTS RULE, RESTATED FOR THIS ENDPOINT. keychain.ts's header
 * says a plaintext key exists in exactly two moments: the POST body that
 * delivered it, and the decrypt at the moment of generation. This handler
 * is the first of those two moments: `plaintext` below lives only in this
 * function's own scope, is handed straight to putKey() (which encrypts it
 * before its first await), and is never assigned to a variable that
 * outlives this request, logged, or included in the redirect this function
 * returns. See settings.astro's own header for how the relay cookie this
 * function sets on failure is built to the same rule: provider and a
 * message, never the value that was typed.
 *
 * TWO FAILURE SHAPES, TWO DIFFERENT RELAY MESSAGES.
 *   - InvalidKeyShapeError: putKey() refused the plaintext before ever
 *     touching the encryption secret (validateKeyShape() runs first inside
 *     putKey()). Its `message` already carries validateKeyShape()'s own
 *     `reason`, which by keychain.ts's own contract never echoes the input
 *     back, so it is safe to relay as-is.
 *   - Anything else: almost certainly keychain.ts's requiredMasterSecret()
 *     throwing because KEY_ENCRYPTION_SECRET is unset or malformed, the
 *     same condition settings.astro's keyStorageIsConfigured() check catches
 *     before ever showing this form. Reaching this branch means that check
 *     was bypassed (a stale cached page, a direct POST), so the relay says
 *     the same honest thing the page itself would have said, and nothing
 *     about the underlying error (which could in principle carry more
 *     detail than intended) is forwarded.
 *
 * THE `byok` FLAG IS CHECKED HERE TOO, NOT ONLY ON THE PAGE. flags.config
 * .mjs calls `byok` "the kill switch over bring-your-own-key generation,
 * and the only thing that can turn the whole feature off without a
 * deploy." A kill switch that only hides settings.astro's key form but
 * still accepts a direct POST is not a kill switch, it is a UI change, so
 * this handler refuses the same way the page explains itself instead of a
 * form when the flag is off.
 */
import type { APIContext } from 'astro';
import { isOn } from '../../../lib/flags';
import { PROVIDERS, validateKeyShape, type Provider } from '../../../lib/keychain';
import { InvalidKeyShapeError, putKey, setDesignatedProvider } from '../../../lib/keychain-store';
import { verifyKey } from '../../../lib/generation-providers';
import { returnTo } from '../../../lib/return-to';
import { withBase } from '../../../../site.config.mjs';
import { isPaidViewer } from '../../../lib/ledger-access';

export const prerender = false;

const KEYS_PATH = '/settings';
const RELAY_COOKIE = 'keys_form_relay';

interface RelayPayload {
  provider: Provider;
  message: string;
}

function redirect(to = `${KEYS_PATH}#keys`): Response {
  // Back to the key section, not the top of the settings page. The #keys
  // fragment matches the id on settings.astro's .keys-block, which carries a
  // scroll-margin that clears the sticky header. A stored key may instead go
  // back to an allowed `return` (Come ready, /start); a refused one always
  // lands here, where the relay cookie below is readable.
  return new Response(null, { status: 303, headers: { Location: withBase(to) } });
}

/**
 * Where a REFUSED key sends the reader back to, and the cookie path that
 * follows from it.
 *
 * A refusal used to land on Settings whatever page had asked, which threw a
 * reader in the middle of Come ready out of the flow for the crime of
 * pasting the wrong string. It returns to the form that submitted it, and
 * the relay cookie is scoped to that page so the reason arrives with it.
 * The saved marker is dropped on the way: nothing was saved.
 */
function refusalTarget(form: FormData): { to: string; cookiePath: string } {
  const back = returnTo(form, `${KEYS_PATH}#keys`).replace('&saved=1', '');
  const cookiePath = back.startsWith('/start') ? '/start' : KEYS_PATH;
  return { to: back, cookiePath };
}

function setRelayCookie(context: APIContext, payload: RelayPayload, cookiePath: string): void {
  context.cookies.set(RELAY_COOKIE, JSON.stringify(payload), {
    path: withBase(cookiePath),
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    maxAge: 120
  });
}

/** Refuses this save: the reason goes back to the page that asked, and so
    does the console that was picked, so a refusal costs the reader the key
    they typed and nothing else. `provider` is one of the four, checked
    before this is called, never a value straight off the form. */
function refuse(context: APIContext, form: FormData, provider: Provider, message: string): Response {
  const { to, cookiePath } = refusalTarget(form);
  const withProvider = to.startsWith('/start')
    ? `${to}${to.includes('?') ? '&' : '?'}provider=${provider}`
    : to;
  setRelayCookie(context, { provider, message }, cookiePath);
  return redirect(withProvider);
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

  // Bring-your-own-key is paid, and /settings only asks for member, so the
  // tier is checked here as well as on the page. Hiding the panel without this
  // would leave a member able to attach a key by hand.
  if (!isPaidViewer(viewer)) {
    return new Response('Not available on your account.', { status: 403 });
  }

  if (!isOn('byok')) {
    return new Response('Bring-your-own-key generation is off on this deployment.', { status: 403 });
  }

  const form = await context.request.formData();
  const providerField = form.get('provider');
  const keyField = form.get('key');

  if (!isProvider(providerField)) {
    return new Response('Unrecognised provider.', { status: 400 });
  }
  const provider = providerField;

  // Not trusted as anything but the raw submission: putKey() is the one
  // place this becomes a decision (valid shape, or not). A missing or
  // non-string field is refused the same way an empty string is, by the
  // same validateKeyShape() message, rather than a separate code path here.
  const plaintext = typeof keyField === 'string' ? keyField : '';


  // SHAPE, THEN THE PROVIDER, THEN STORE. The shape check is free and
  // catches the whole class of paste mistakes, so it runs first and no
  // request leaves this server for a key that was never going to work.
  // putKey() runs it again as it stores; that repeat is the backstop for any
  // other caller, not a cost worth avoiding here.
  const shape = validateKeyShape(provider, plaintext);
  if (!shape.ok) {
    return refuse(context, form, provider, `That key was not stored: ${shape.reason}.`);
  }

  // Asked once, here, because "connected" should mean somebody checked. A
  // provider that refuses the key stops the save; a provider that cannot be
  // reached does not, since that says nothing about the key.
  const check = await verifyKey(provider, plaintext);
  if (check.status === 'refused') {
    return refuse(context, form, provider, `That key was not stored: ${check.reason}.`);
  }
  if (check.status === 'unreachable') {
    console.warn(`settings/keys/save: storing a ${provider} key unchecked for user ${viewer.userId}: ${check.reason}.`);
  }

  try {
    await putKey(viewer.userId, provider, plaintext);
    // The key just saved is the one to draft with. Saying so here is what
    // replaced the pipeline's old guess-by-list-order: a person who connects
    // a second key meant to use it, and if they did not, Settings is where
    // they say otherwise. A failure to record it leaves the key stored and
    // the account undesignated, which draftingProvider() reads as "ask",
    // never as "pick one for them".
    try {
      await setDesignatedProvider(viewer.userId, provider);
    } catch (error) {
      console.error(`settings/keys/save: stored the key but could not designate ${provider}.`, error);
    }
    return redirect(returnTo(form, `${KEYS_PATH}#keys`));
  } catch (err) {
    if (err instanceof InvalidKeyShapeError) {
      // err.message is 'keychain-store: refused to store key: <reason>';
      // strip the prefix so the relay reads as one plain sentence instead
      // of exposing this file's own error-class naming to a reader.
      const reason = err.message.replace(/^keychain-store: refused to store key: /, '');
      return refuse(context, form, provider, `That key was not stored: ${reason}.`);
    }

    // Any other failure is treated as the encryption secret being unset or
    // malformed (see this file's own header): the same honest message
    // keys.astro's keyStorageIsConfigured() check would have shown instead of this
    // form, never the underlying error's own text.
    return refuse(
      context,
      form,
      provider,
      'Key storage is not configured on this deployment right now. Nothing was stored.'
    );
  }
}
