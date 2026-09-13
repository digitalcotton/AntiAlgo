/**
 * auth.test.ts: trustedOrigins() from auth.ts.
 *
 * WHY THIS IS THE ONLY THING IN THIS FILE. Everything else this task touched
 * is a value handed straight to betterAuth(): revokeSessionsOnPasswordReset,
 * verification.storeIdentifier, rateLimit.storage. A test that builds the
 * options object and asserts the key is present would only prove this file
 * typed what it typed; it says nothing about whether Better Auth reads that
 * key the way node_modules was read to say it does, and that reading is
 * recorded in auth.ts's own comments instead. trustedOrigins() is different:
 * it is a small pure function of environment variables, exactly the shape
 * baseURL() already has, and it is honestly testable without a database or a
 * running server.
 */
import { describe, expect, it } from 'vitest';
import { trustedOrigins } from './auth';

/** Runs fn with the given env vars set, then restores whatever was there before. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prior[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(prior)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

describe('trustedOrigins()', () => {
  it('always includes the public origin, even with no Vercel env vars set', () => {
    withEnv({ VERCEL_URL: undefined, VERCEL_BRANCH_URL: undefined }, () => {
      expect(trustedOrigins()).toEqual(['https://tokenstoagents.ai']);
    });
  });

  it('adds the deployment host from VERCEL_URL, prefixed with https', () => {
    withEnv({ VERCEL_URL: 'site-index-abc123.vercel.app', VERCEL_BRANCH_URL: undefined }, () => {
      expect(trustedOrigins()).toEqual([
        'https://tokenstoagents.ai',
        'https://site-index-abc123.vercel.app'
      ]);
    });
  });

  it('adds the branch host from VERCEL_BRANCH_URL alongside VERCEL_URL, not instead of it', () => {
    // A preview deployment is reachable at both its own unique host and its
    // stable branch host. baseURL() only builds links from one of them; this
    // list has to trust both, because a browser can be standing at either.
    withEnv(
      { VERCEL_URL: 'site-index-abc123.vercel.app', VERCEL_BRANCH_URL: 'site-index-git-run-desk-v1.vercel.app' },
      () => {
        expect(trustedOrigins()).toEqual([
          'https://tokenstoagents.ai',
          'https://site-index-abc123.vercel.app',
          'https://site-index-git-run-desk-v1.vercel.app'
        ]);
      }
    );
  });

  it('never lists the same origin twice, if VERCEL_URL and VERCEL_BRANCH_URL happen to match', () => {
    withEnv({ VERCEL_URL: 'same.vercel.app', VERCEL_BRANCH_URL: 'same.vercel.app' }, () => {
      expect(trustedOrigins()).toEqual(['https://tokenstoagents.ai', 'https://same.vercel.app']);
    });
  });
});
