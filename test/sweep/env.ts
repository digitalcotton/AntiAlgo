/**
 * env.ts: the typed view onto env.mjs.
 *
 * THE VALUES LIVE IN env.mjs, NOT HERE, for the reason its own header explains:
 * scripts/capture-screens.mjs starts a dev server on the sweep's database and
 * drives a minted session against it, and that script is plain Node with no
 * TypeScript runner behind it. This is the same split flags.config.mjs /
 * flags.ts already uses in this repository, for the same reason, and it adds no
 * logic of its own: every export below is a straight re-export, because two
 * copies of one secret is precisely the failure env.mjs's header is about.
 */
import {
  SWEEP_AUTH_SECRET as SWEEP_AUTH_SECRET_IMPL,
  SWEEP_DATABASE_URL as SWEEP_DATABASE_URL_IMPL,
  SWEEP_ENV as SWEEP_ENV_IMPL,
  SWEEP_KEY_ENCRYPTION_SECRET as SWEEP_KEY_ENCRYPTION_SECRET_IMPL,
  SWEEP_ORIGIN as SWEEP_ORIGIN_IMPL,
  sweepEnv as sweepEnvImpl
} from './env.mjs';

/** Signs the sweep's session cookies. Both the minting process and the dev server
 *  must use this exact value or every signed-in assertion is meaningless. */
export const SWEEP_AUTH_SECRET: string = SWEEP_AUTH_SECRET_IMPL;

/** Encrypts stored provider keys (src/lib/keychain.ts). */
export const SWEEP_KEY_ENCRYPTION_SECRET: string = SWEEP_KEY_ENCRYPTION_SECRET_IMPL;

/** The one database the sweep is allowed to speak to. */
export const SWEEP_DATABASE_URL: string = SWEEP_DATABASE_URL_IMPL;

/** Where the dev server the sweep drives will be. */
export const SWEEP_ORIGIN: string = SWEEP_ORIGIN_IMPL;

/** Everything the app needs in its environment to serve the sweep, on a given origin. */
export const sweepEnv: (origin?: string) => Record<string, string> = sweepEnvImpl;

/** Everything the app needs in its environment to serve the sweep, as one object
 *  both playwright.config.ts and auth.setup.ts spread. */
export const SWEEP_ENV: Record<string, string> = SWEEP_ENV_IMPL;
