/**
 * The flag registry, the same shape as the index's flags.config.mjs so the
 * two can be merged the day the index moves onto this origin.
 *
 * A plain .mjs at the root for the reason site.config.mjs gives: every
 * consumer can read it without a build step.
 */

export const EDITIONS = ['design', 'broad'];
export const DEFAULT_EDITION = 'design';

export function edition() {
  const raw = process.env.SITE_EDITION;
  if (raw === undefined) return DEFAULT_EDITION;
  if (!EDITIONS.includes(raw)) {
    throw new Error(
      `flags: SITE_EDITION is set to '${raw}', which is not a legal edition. ` +
        `Legal values are ${EDITIONS.join(', ')}. An unrecognised edition must never silently fall back.`
    );
  }
  return raw;
}

/**
 * THE FLAG REGISTRY. `why` is the citation a later reader needs to change the
 * value without guessing at the reasoning that set it.
 */
export const FLAGS = {
  waitlist: {
    why:
      'While on, a new account is created at the waitlisted tier instead of DEFAULT_TIER ' +
      '(tiers.config.mjs), and a waitlisted account hitting a member route is sent to the one ' +
      'waitlist page. While off, sign-up behaves exactly as the index does today: a new account ' +
      'is a member. Existing accounts are untouched either way; the flag is read once, at ' +
      'account creation, and never again. Turning it off is the whole migration.',
    editions: { design: true, broad: true }
  }
};

export function isOn(flag, ed = edition()) {
  const entry = FLAGS[flag];
  if (!entry) {
    throw new Error(
      `flags: '${flag}' is not a registered flag. Legal names are ${Object.keys(FLAGS).join(', ')}. ` +
        `A typo here must not read as off.`
    );
  }
  return entry.editions[ed];
}

/** Route prefixes behind a flag. None yet; the shape is kept for the merge. */
/** @type {Record<string, any>} */
export const FLAGGED_ROUTES = {};

function normaliseRoute(pathname) {
  if (!pathname.startsWith('/')) return '/';
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return trimmed || '/';
}

export function flagForRoute(path) {
  const normalised = normaliseRoute(path);
  let best = null;
  for (const [prefix, flag] of Object.entries(FLAGGED_ROUTES)) {
    if (normalised === prefix || normalised.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, flag };
    }
  }
  return best ? best.flag : null;
}

export function routeIsLit(path, ed = edition()) {
  const flag = flagForRoute(path);
  if (flag === null) return true;
  return isOn(flag, ed);
}
