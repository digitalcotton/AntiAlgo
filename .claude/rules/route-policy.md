---
paths:
  - "src/pages/**"
  - "src/middleware.ts"
  - "src/lib/entitlement.ts"
  - "flags.config.mjs"
  - "tiers.config.mjs"
---
A new route behind sign-in needs an entry in `ROUTE_POLICY`
(`src/lib/entitlement.ts`) or it is refused with reason `no-policy-declared`.
`assertEveryGatedPrefixHasAPolicy` runs at import, so a missing entry fails the
build rather than leaking. Do not weaken that assertion to get a build green.

Two gate layers with different failure modes. **Middleware** cannot be forgotten —
it runs on every request. An **in-page** check can be: `/jobs-data`,
`/jobs-data/summary`, `/ledger/watch`, `/ledger/prefs` and `/board` are not in
`GATED_PREFIXES` and guard themselves in their own frontmatter. Remove one of those
in-page checks and paid content leaks with nothing failing — except for
`/jobs-data/summary`, which `src/lib/jobs-data-access.test.ts` covers directly.

`security.checkOrigin` is off in `astro.config.mjs` deliberately. On Vercel it
compares the browser `Origin` to the internal deploy host rather than the public
`www.antialgo.ai`, so it 403'd every legitimate form POST — proven in production on
2026-09-18. `isAllowedOrigin` in the middleware replaces it. Do not re-enable it.
