import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which origin this site believes it is served from, per environment.
 *
 * WHY THIS TEST EXISTS. Vercel injects VERCEL_PROJECT_PRODUCTION_URL on EVERY
 * environment, previews included. site.config.mjs preferred it, so a preview deploy
 * resolved SITE_ORIGIN to www.antialgo.ai while serving from a branch URL, and three
 * things broke at once without a single log line:
 *
 *   - src/lib/auth.ts's baseURL() is this value, so Better Auth signed session
 *     cookies for an origin the browser was not on. Sign-in did not work on any
 *     preview deploy.
 *   - every canonical URL, OG image and sitemap entry on a preview pointed at
 *     production, so none of them could be checked before shipping.
 *   - src/lib/stats.ts and src/lib/kills.ts fetch this origin while rendering, so a
 *     preview read PRODUCTION's numbers and displayed them as its own. That makes a
 *     preview worthless as a test of a data change, which is most of what a preview
 *     is for.
 *
 * The production case is asserted first and most carefully: this is a change to how
 * the live site names itself, and the only acceptable outcome there is "exactly what
 * it was before".
 */

/** The variables that decide the answer. Cleared before each case so no test
 *  inherits another's environment, and restored after so the suite's own env is not
 *  left mutated for whatever runs next in this worker. */
const KEYS = ['SITE_ORIGIN', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL'] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  // site.config.mjs imports load-local-env.mjs, which fills any key NOT already
  // present from .env.local — and .env.local here sets SITE_ORIGIN to localhost,
  // which would win every case and make this whole file a tautology. An empty
  // string is "present" to that check and falsy to site.config's own, which is
  // exactly the seam needed. (Discovered the hard way: the first version of this
  // probe reported localhost for all four environments.)
  process.env.SITE_ORIGIN = '';
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A fresh read of site.config.mjs. ESM caches a module's evaluated body, and
 *  SITE_ORIGIN is computed once at import, so every case needs the registry reset. */
async function originWith(env: Partial<Record<(typeof KEYS)[number], string>>): Promise<string> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  vi.resetModules();
  const config = await import('../../site.config.mjs');
  return config.SITE_ORIGIN;
}

describe('SITE_ORIGIN', () => {
  it('is the production host on a production deploy, exactly as before', async () => {
    expect(
      await originWith({
        VERCEL_ENV: 'production',
        VERCEL_PROJECT_PRODUCTION_URL: 'www.antialgo.ai',
        VERCEL_BRANCH_URL: 'anti-algo-git-main.vercel.app',
        VERCEL_URL: 'anti-algo-abc123.vercel.app'
      })
    ).toBe('https://www.antialgo.ai');
  });

  it('is the BRANCH host on a preview, not the production host', async () => {
    // The bug, and the reason for the whole file. Before the fix this answered
    // https://www.antialgo.ai.
    expect(
      await originWith({
        VERCEL_ENV: 'preview',
        VERCEL_PROJECT_PRODUCTION_URL: 'www.antialgo.ai',
        VERCEL_BRANCH_URL: 'anti-algo-git-safety-net.vercel.app',
        VERCEL_URL: 'anti-algo-abc123.vercel.app'
      })
    ).toBe('https://anti-algo-git-safety-net.vercel.app');
  });

  it('falls back to the deployment host on a preview with no branch URL', async () => {
    expect(
      await originWith({
        VERCEL_ENV: 'preview',
        VERCEL_PROJECT_PRODUCTION_URL: 'www.antialgo.ai',
        VERCEL_URL: 'anti-algo-abc123.vercel.app'
      })
    ).toBe('https://anti-algo-abc123.vercel.app');
  });

  it('prefers the branch host over the deployment host, because an auth callback needs a stable URL', async () => {
    expect(
      await originWith({
        VERCEL_ENV: 'preview',
        VERCEL_BRANCH_URL: 'stable.vercel.app',
        VERCEL_URL: 'changes-every-deploy.vercel.app'
      })
    ).toBe('https://stable.vercel.app');
  });

  it('is localhost with no platform variables at all', async () => {
    expect(await originWith({})).toBe('http://localhost:4321');
  });

  it('and an explicit SITE_ORIGIN still wins everywhere, trailing slash trimmed', async () => {
    // The owner's override, which the file's header calls "the one edit" for the day
    // the domain exists. It must outrank every platform variable.
    expect(
      await originWith({
        SITE_ORIGIN: 'https://www.antialgo.ai/',
        VERCEL_ENV: 'preview',
        VERCEL_BRANCH_URL: 'branch.vercel.app'
      })
    ).toBe('https://www.antialgo.ai');
  });
});
