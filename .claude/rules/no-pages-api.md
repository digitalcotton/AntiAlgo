---
paths:
  - "src/pages/**"
  - "api/**"
  - "vercel.json"
---
**Never create anything under `src/pages/api/`.** The repo root has an `api/`
directory (`api/rebuild.ts`, `api/subscribe.ts`), which on Vercel is a Functions
directory that claims every `/api/*` path *before* Astro is consulted. An Astro
route at `src/pages/api/anything` is unreachable in production and works perfectly
in local dev, so the failure only appears once deployed.

This silently killed the waitlist form from 2026-09-13 to 2026-09-20.
`src/pages/waitlist/join.ts` carries the scar in its own header: it "lived at
/api/waitlist until 2026-09-20, where it was never reached".

`scripts/gate-invariants.mjs` asserts the invariant. Do not delete the root `api/`
files as dead code without checking what still calls them.

Also: `vercel.json`'s `"framework": "astro"` is the only thing making the deploy an
Astro build. The Vercel project's own preset is still **Vite**, left over from the
landing page that lived here 228 days ago.
