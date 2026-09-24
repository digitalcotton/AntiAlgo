import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The route manifest, as the specs read it.
 *
 * GENERATED, NEVER HAND-KEPT. scripts/route-census.mjs writes .sweep/routes.json
 * from the filesystem, src/lib/entitlement.ts and src/middleware.ts on every
 * `npm run conform`. The Index's own census header records what the alternative
 * costs: a hand-kept list meant a conformance run "measured one route and reported
 * six passes".
 *
 * MISSING IS FATAL, NOT SKIPPED. A spec that finds no manifest must fail, loudly.
 * The tempting alternative — fall back to a short hardcoded list — is how a sweep
 * ends up reporting green over three routes while claiming to cover ninety-one.
 */

export type Role = 'signed-out' | 'waitlisted' | 'member' | 'paid' | 'internal';

export interface RouteEntry {
  file: string;
  route: string;
  prerender: boolean;
  outputKind: 'html' | 'json' | 'redirect' | 'svg' | 'markdown' | 'xml' | 'file';
  dynamic: boolean;
  exampleParamPath: string | null;
  dark: { flag: string; why: string } | null;
  gate: 'public' | 'session' | 'tier' | 'internal' | 'machine-token';
  requiredTier: string | null;
  nightlySweep: boolean;
  audienceDecisions: Record<Role, { allow: boolean; required: string | null; reason: string }>;
}

const PATH = join(process.cwd(), '.sweep', 'routes.json');

function load(): { routes: RouteEntry[] } {
  let raw: string;
  try {
    raw = readFileSync(PATH, 'utf8');
  } catch {
    throw new Error(
      `No route manifest at ${PATH}. The sweep refuses to guess which routes exist — ` +
        'run `npm run routes:census` (or `npm run conform`, which does it first). ' +
        'A hardcoded fallback list here would let this suite report green over a ' +
        'handful of routes while claiming to cover the site.'
    );
  }
  const parsed = JSON.parse(raw) as { routes: RouteEntry[] };
  if (!Array.isArray(parsed.routes) || parsed.routes.length < 50) {
    throw new Error(
      `The route manifest holds ${parsed.routes?.length ?? 0} routes, which is fewer than this app has. ` +
        'A manifest that silently shrank is the failure the Index\'s census was written to catch. ' +
        'Re-run `npm run routes:census` and read what it says.'
    );
  }
  return parsed;
}

export const MANIFEST = load();

/**
 * The routes worth loading in a browser as `role`, and what to expect.
 *
 * Excluded, each for a stated reason rather than by omission:
 *   dark          the flag is off, so the route is a flat 404 by design. Asserting
 *                 a 404 here would only re-test flags.config.mjs, which its own
 *                 tests already cover.
 *   machine-token needs a bearer secret, not a session. Belongs to a different
 *                 gate; a browser cannot speak for it.
 *   dynamic with no example path — the census could not supply a real parameter,
 *                 and inventing one produces a 404 that means nothing.
 *   redirect      asserting the destination is the redirect's own test; the sweep
 *                 would just be measuring a 302 it already knows about.
 */
export function browsableRoutes(role: Role): Array<{ entry: RouteEntry; path: string; allowed: boolean }> {
  return MANIFEST.routes
    .filter((entry) => !entry.dark)
    .filter((entry) => entry.gate !== 'machine-token')
    .filter((entry) => entry.outputKind !== 'redirect' && entry.outputKind !== 'file')
    .map((entry) => ({
      entry,
      path: entry.dynamic ? (entry.exampleParamPath ?? '') : entry.route,
      allowed: entry.audienceDecisions[role]?.allow ?? false
    }))
    .filter((candidate) => candidate.path !== '');
}

/** Only the ones that render a full page, for the assertions that need a document
 *  (a visible main landmark, an ARIA tree). JSON and SVG endpoints get status and
 *  content-type checks instead. */
export function pageRoutes(role: Role) {
  return browsableRoutes(role).filter((candidate) => candidate.entry.outputKind === 'html');
}
