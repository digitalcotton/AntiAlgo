/**
 * dev-keyless-draft.ts: let the draft button draft without a provider key, on a
 * developer's own machine and nowhere else.
 *
 * WHY THIS EXISTS. Drafting is BYOK: a reader with no stored key gets the draft
 * button routed to /settings#keys instead (DraftRail's `needsKey`,
 * JobDetailV2's `signedIn && hasKey`). That is correct for a real account and
 * useless for working on the draft room, where a local test account has no key
 * and never will, so the button bounces to Settings and the screen under
 * development is unreachable through its own front door.
 *
 * WHAT IT DOES AND DOES NOT CHANGE. It suppresses the DIVERSION only. The draft
 * that then runs is the deterministic built-in writer, exactly as
 * generation-preference-store.ts's fallback path already produces for a keyless
 * account — no provider is contacted, no key is invented, and nothing pretends
 * a key exists. `hasKey` stays honestly false everywhere it is read; this is
 * asked separately, right where the routing decision is made.
 *
 * TWO LOCKS, BOTH REQUIRED, AND THE FIRST CANNOT BE PICKED IN PRODUCTION.
 *
 *   1. `import.meta.env.DEV` is true only under `astro dev`. Vite replaces it
 *      with a literal `false` at build time, so in any built artifact the
 *      function below collapses to `return false` and the environment variable
 *      is never even read. A production deploy cannot turn this on: there is no
 *      switch left in the bundle to turn.
 *   2. DEV_KEYLESS_DRAFT=1 must be set as well, so running `astro dev` does not
 *      silently weaken the gate for every developer who did not ask for it. It
 *      belongs in .env.local, which is not committed.
 *
 * If you are reading this because drafting is keyless somewhere it should not
 * be, this file is not the cause — check keyStorageIsConfigured() and the
 * 'byok' flag, which are what actually decide whether keys work at all.
 */
export function keylessDraftAllowed(): boolean {
  if (!import.meta.env.DEV) return false;
  return process.env.DEV_KEYLESS_DRAFT === '1';
}
