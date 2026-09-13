/**
 * flags.ts: the typed face of flags.config.mjs. Re-exports only; no logic.
 */
import {
  DEFAULT_EDITION,
  EDITIONS,
  FLAGS,
  edition as rawEdition,
  isOn as rawIsOn,
  routeIsLit as rawRouteIsLit
} from '../../flags.config.mjs';

export type Edition = 'design' | 'broad';
export type FlagName = keyof typeof FLAGS;

export { DEFAULT_EDITION, EDITIONS, FLAGS };
export const edition = rawEdition as () => Edition;
export const isOn = rawIsOn as (flag: FlagName, ed?: Edition) => boolean;
export const routeIsLit = rawRouteIsLit as (path: string, ed?: Edition) => boolean;
