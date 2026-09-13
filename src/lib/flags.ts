/**
 * flags.ts: the typed view onto flags.config.mjs.
 *
 * THE VALUES LIVE IN flags.config.mjs, NOT HERE, for the reason its own header
 * explains: astro.config.mjs, the gates, and the route census all read that
 * file directly and none of them can import TypeScript. This file exists only
 * so the TypeScript half of the codebase gets real types (`Edition`,
 * `FlagName`) instead of `string`. It adds no logic of its own beyond that:
 * two copies of the same rule is exactly the failure this split avoids, so
 * every function below is a straight re-export, not a reimplementation.
 */
import {
  DEFAULT_EDITION,
  EDITIONS,
  FLAGGED_ROUTES,
  FLAGS,
  edition as editionImpl,
  flagForRoute as flagForRouteImpl,
  isOn as isOnImpl,
  routeIsLit as routeIsLitImpl
} from '../../flags.config.mjs';

export { DEFAULT_EDITION, EDITIONS, FLAGGED_ROUTES, FLAGS };

/** One of the two editions this codebase can run as. */
export type Edition = (typeof EDITIONS)[number];

/** Every registered flag name, derived from FLAGS so a new key is typed for free. */
export type FlagName = keyof typeof FLAGS;

export const edition: () => Edition = editionImpl;

export const isOn: (flag: FlagName, ed?: Edition) => boolean = isOnImpl;

export const flagForRoute: (path: string) => FlagName | null = flagForRouteImpl;

export const routeIsLit: (path: string, ed?: Edition) => boolean = routeIsLitImpl;
