import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EDITION,
  EDITIONS,
  FLAGGED_ROUTES,
  FLAGS,
  edition,
  flagForRoute,
  isOn,
  routeIsLit,
  type FlagName
} from './flags';

// flags.ts is a straight re-export of flags.config.mjs (see that file's own
// header for why the values live there and not here), so these tests exercise
// the re-exported functions directly: they are pinning the contract, not
// duplicating flags.config.mjs's own logic under a different name.
//
// routeIsLit() and flagForRoute() are tested against LOCAL literal maps built
// with `withRegisteredRoutes()` below rather than against the live
// FLAGGED_ROUTES export, because FLAGGED_ROUTES is deliberately empty in this
// task (it grows one entry per phase) and a test asserting behaviour "against
// today's empty map" would silently stop testing anything the day a route is
// registered. Registering and restoring a route directly is the same pattern
// entitlement.test.ts uses to test the undeclared-policy case.

describe('EDITIONS and FLAGS: every flag declares every edition', () => {
  it('every registered flag has an editions entry for every declared edition', () => {
    // Looped rather than asserted per flag, so a new flag added to FLAGS
    // without a complete editions object fails this test immediately instead
    // of shipping half-declared and reading as "off" for the edition nobody
    // wrote a line for.
    for (const [name, entry] of Object.entries(FLAGS)) {
      for (const ed of EDITIONS) {
        expect(entry.editions, `flag '${name}' is missing an entry for edition '${ed}'`).toHaveProperty(ed);
        expect(typeof entry.editions[ed as keyof typeof entry.editions]).toBe('boolean');
      }
    }
  });

  it('every flag carries a non-empty why', () => {
    for (const [name, entry] of Object.entries(FLAGS)) {
      expect(entry.why, `flag '${name}' has no why`).toBeTruthy();
      expect(entry.why.length).toBeGreaterThan(0);
    }
  });
});

describe('edition()', () => {
  it('returns the default when SITE_EDITION is unset', () => {
    const prior = process.env.SITE_EDITION;
    delete process.env.SITE_EDITION;
    try {
      expect(edition()).toBe(DEFAULT_EDITION);
    } finally {
      if (prior === undefined) delete process.env.SITE_EDITION;
      else process.env.SITE_EDITION = prior;
    }
  });

  it('returns the requested edition when it is a legal value', () => {
    const prior = process.env.SITE_EDITION;
    process.env.SITE_EDITION = 'broad';
    try {
      expect(edition()).toBe('broad');
    } finally {
      if (prior === undefined) delete process.env.SITE_EDITION;
      else process.env.SITE_EDITION = prior;
    }
  });

  it('throws, naming the variable and the legal values, on an unknown SITE_EDITION', () => {
    const prior = process.env.SITE_EDITION;
    process.env.SITE_EDITION = 'design-ish';
    try {
      expect(() => edition()).toThrow(/SITE_EDITION/);
      expect(() => edition()).toThrow(/design-ish/);
      expect(() => edition()).toThrow(/design/);
      expect(() => edition()).toThrow(/broad/);
    } finally {
      if (prior === undefined) delete process.env.SITE_EDITION;
      else process.env.SITE_EDITION = prior;
    }
  });
});

describe('isOn()', () => {
  it('throws, naming the flag, on a flag name not in FLAGS', () => {
    // A typo must not read as off: an off flag is invisible, so a mistyped
    // one would look identical to a feature correctly gated dark. It has to
    // throw, not return false.
    expect(() => isOn('dsek' as FlagName, 'design')).toThrow(/dsek/);
  });

  it('returns the registered value for a known flag and edition', () => {
    expect(isOn('desk', 'design')).toBe(true);
    expect(isOn('desk', 'broad')).toBe(true);
    expect(isOn('profiles_public', 'design')).toBe(false);
    expect(isOn('profiles_public', 'broad')).toBe(false);
    expect(isOn('repost_biography', 'design')).toBe(false);
    expect(isOn('repost_biography', 'broad')).toBe(false);
  });

  it('defaults to the current edition() when none is passed', () => {
    const prior = process.env.SITE_EDITION;
    process.env.SITE_EDITION = 'design';
    try {
      expect(isOn('desk')).toBe(isOn('desk', 'design'));
    } finally {
      if (prior === undefined) delete process.env.SITE_EDITION;
      else process.env.SITE_EDITION = prior;
    }
  });
});

/**
 * Registers routes against the real FLAGGED_ROUTES map for the duration of
 * `fn`, then restores it exactly, mirroring how entitlement.test.ts borrows
 * GATED_PREFIXES for its undeclared-policy case. FLAGGED_ROUTES is a plain
 * object (not frozen), and ESM gives every importer the same live object, so
 * mutating the binding imported above is mutating the one flagForRoute() and
 * routeIsLit() read: this exercises the real longest-prefix logic rather than
 * a parallel implementation.
 */
function withRegisteredRoutes<T>(entries: Record<string, FlagName>, fn: () => T): T {
  const target = FLAGGED_ROUTES as Record<string, string>;
  const added = Object.keys(entries);
  for (const key of added) target[key] = entries[key];
  try {
    return fn();
  } finally {
    for (const key of added) delete target[key];
  }
}

describe('flagForRoute() and routeIsLit()', () => {
  it('an unflagged path carries no flag, and is lit', () => {
    expect(flagForRoute('/essays/some-post')).toBeNull();
    expect(routeIsLit('/essays/some-post', 'design')).toBe(true);
  });

  it('a path under a dark flag is not lit; a path under a lit flag is', () => {
    withRegisteredRoutes({ '/profiles': 'profiles_public', '/desk': 'desk' }, () => {
      expect(flagForRoute('/profiles/acme')).toBe('profiles_public');
      expect(routeIsLit('/profiles/acme', 'design')).toBe(false);

      expect(flagForRoute('/desk/tracker')).toBe('desk');
      expect(routeIsLit('/desk/tracker', 'design')).toBe(true);
    });
  });

  it('longest prefix wins when two registered prefixes match the same path', () => {
    withRegisteredRoutes({ '/desk': 'desk', '/desk/tailor': 'tailor' }, () => {
      // /desk is lit, /desk/tailor is not: the shorter prefix must not win
      // and silently open a route the longer, more specific entry locks.
      expect(flagForRoute('/desk/tailor/draft')).toBe('tailor');
      expect(routeIsLit('/desk/tailor/draft', 'design')).toBe(isOn('tailor', 'design'));

      // Sanity: registering the same two flags dark, the longer entry still
      // decides, in the opposite direction.
    });

    withRegisteredRoutes({ '/desk': 'profiles_public', '/desk/tailor': 'repost_biography' }, () => {
      expect(flagForRoute('/desk/summary')).toBe('profiles_public');
      expect(flagForRoute('/desk/tailor/draft')).toBe('repost_biography');
      expect(routeIsLit('/desk/summary', 'design')).toBe(false);
      expect(routeIsLit('/desk/tailor/draft', 'design')).toBe(false);
    });
  });

  it('a trailing slash does not change the answer', () => {
    withRegisteredRoutes({ '/desk': 'profiles_public' }, () => {
      expect(flagForRoute('/desk/')).toBe(flagForRoute('/desk'));
      expect(routeIsLit('/desk/', 'design')).toBe(routeIsLit('/desk', 'design'));
    });
  });
});
