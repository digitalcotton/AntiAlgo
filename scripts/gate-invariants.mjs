#!/usr/bin/env node
/**
 * gate-invariants.mjs: five filesystem-and-source facts that must stay true,
 * checked with no browser, no database and no network.
 *
 *   node scripts/gate-invariants.mjs
 *
 * WHY THIS EXISTS. docs/regression-strategy.md names this as Layer 3 of the
 * regression-safety plan: the cheapest layer, meant to run in well under a
 * second, before anything that opens a browser or a connection. Every fact
 * below is something that was already true, went quietly false, and cost
 * real time before anyone noticed:
 *
 *   1. THE ROOT api/ DIRECTORY SHADOWS ASTRO. api/rebuild.ts and
 *      api/subscribe.ts are Vercel Functions at the repository root, and
 *      Vercel resolves a request under /api/* to that directory BEFORE Astro
 *      is ever consulted. src/pages/waitlist/join.ts's own header carries the
 *      scar: it lived at /api/waitlist from launch until 2026-09-20, and the
 *      platform answered every request with a flat 404 the whole time,
 *      because src/pages/api/waitlist.ts (had it existed) would never have
 *      been reached. The fix was moving the route out from under /api, not
 *      fixing the route. Nothing stops a future edit from recreating
 *      src/pages/api/ by habit; this check is that stop.
 *   2. AN UNDECLARED GATED ROUTE DENIES SILENTLY. src/lib/entitlement.ts
 *      already asserts that every prefix in GATED_PREFIXES has a
 *      ROUTE_POLICY entry (assertEveryGatedPrefixHasAPolicy, which runs at
 *      import time and throws if it is not true). That is a check on the
 *      PREFIXES. This extends the same guarantee to every real route FILE
 *      under src/pages, by importing the real module and asking it, for each
 *      file's actual URL, the question a request would ask: decide()/
 *      requiredTierFor(). A file that is gated but resolves to no policy is
 *      not a theoretical gap, it is one 403 or one silent hole in the
 *      registry that a browser test would only catch by accident.
 *   3. /colophon PUBLISHES A VERDICT FOR GATES NOTHING RUNS. It imports GATES
 *      from test/gates.config.mjs and prints a pass/fail line per gate to
 *      every visitor. AntiAlgo has no test/gates/ directory at all, so every
 *      non-retired gate in that registry names a runner file that does not
 *      exist here. This check says so, by id, and refuses to decide for the
 *      owner whether the fix is to build the gates or to stop the page from
 *      claiming they run — regression-strategy.md section 6.5 is explicit
 *      that this is the owner's ruling, not a script's.
 *   4. AN ORPHANED PARTIAL SITS IN src/pages LOOKING LIKE A ROUTE. A filename
 *      that starts with `_` is Astro's own convention for "not a route": the
 *      file exists only to be imported by the page that owns it (this repo's
 *      two examples are kills/_KillStates.astro and kills/_ShareCard.astro).
 *      A partial that nothing imports any more is dead weight sitting inside
 *      the routing tree, indistinguishable from a real route at a glance.
 *      This is the closest thing this script can check to the incident that
 *      motivated it, src/review/states.astro (611 lines, sat completely
 *      unbuilt because astro.config.mjs did not injectRoute it) — see the
 *      HONEST LIMIT below for exactly why this check cannot see that file
 *      itself.
 *   5. A ROUTE NOT IN THE REGISTRY GETS ITS PATH HAND-TYPED SOMEWHERE ELSE.
 *      src/data/nav.ts's own header states the rule: "Never type a path in a
 *      page; call routeFor()." A route pattern in nav.ts with no file behind
 *      it is a dead link waiting to be clicked; a real route file with no
 *      nav.ts entry is a path that gets typed by hand at every call site
 *      instead of once. Both directions are checked, each real file's
 *      exception is named with a reason, and a NEW unexplained gap fails the
 *      gate.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *   - It does not open a browser, so it cannot see whether a route actually
 *     renders, only whether the source describes it consistently.
 *   - It does not read the database, so ROUTE_POLICY's tier names are
 *     checked for internal agreement, never against a real viewer.
 *   - It does not walk into src/review/ (outside src/pages by design — see
 *     astro.config.mjs's own header on why) or into public/ or api/'s own
 *     TypeScript sources beyond confirming their existence for the narrative
 *     in check 1's failure message.
 *   - It does not fix anything it finds wrong. A real defect it surfaces is
 *     the app owner's call, not this script's.
 *
 * EXIT CODES, the same contract test/gates.config.mjs already uses:
 *   0  every check passed
 *   1  a check ran to completion and found a real violation
 *   2  a check could not run at all (an import failed, a file this script
 *      itself depends on is missing) — never treated as a pass, because a
 *      gate that could not run has measured nothing.
 *
 * THE RATCHET, FOR CHECKS 3 AND 5 ONLY. This gate was introduced into a
 * codebase that already had debt, and checks 3 and 5 were red on the very
 * first run: colophon has published ten unrunnable gates since before this
 * script existed, and four route files have been hand-typed around nav.ts
 * for just as long. A gate that is red on its first run gets bypassed — this
 * project has already lost two instruments exactly that way (see
 * test/conform/accepted.json's own $comment) — so those two findings are
 * recorded once, by the owner, in test/conform/accepted.json, and reported
 * through test/conform/accepted.mjs's partition()/report() rather than typed
 * as fatal here. Each is ONE coarse finding per check (one owner decision
 * covering ten gate ids, one covering four route files), never one id per
 * gate or per file — see accepted.json's own entries for why. This script
 * still prints every per-gate and per-route line above; the ratchet only
 * decides whether the check's summary line is fatal, not how much detail it
 * shows. Checks 1, 2 and 4 are not ratcheted at all: they guard the root
 * api/ shadowing incident and ROUTE_POLICY completeness, and a NEW violation
 * there must fail loudly with no allowlist that could swallow it. A ratchet
 * entry whose finding stops reproducing is reported as stale and is ALSO
 * fatal — an accepted line that no longer happens is the ratchet lying, and
 * the gate says so instead of quietly staying green.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT } from '../test/gates.config.mjs';
import { partition, report } from '../test/conform/accepted.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PAGES_DIR = join(REPO, 'src', 'pages');
const started = process.hrtime.bigint();

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Every file under dir, recursively, as absolute paths. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const ROUTE_EXT = /\.(astro|ts|tsx|js|mjs)$/i;

/**
 * An absolute file path under src/pages, converted to the URL path Astro
 * would serve it at. Base-free, matching how src/lib/entitlement.ts and
 * src/data/nav.ts both describe a path (site.config.mjs's BASE_PATH is ''
 * today; if that ever changes, both of those files and this converter need
 * the same treatment, in the same commit).
 *
 * Returns null for a "private" partial (a filename starting with `_`),
 * which Astro's own router excludes from routing.
 */
function pageFileToRoutePath(absPath) {
  const rel = relative(PAGES_DIR, absPath).split(sep).join('/');
  const basename = rel.split('/').pop() ?? '';
  if (basename.startsWith('_')) return null;

  const withoutExt = rel.replace(ROUTE_EXT, '');
  const segments = withoutExt.split('/');
  if (segments[segments.length - 1] === 'index') segments.pop();

  const path = `/${segments.join('/')}`;
  return path === '' || path === '/' ? '/' : path.replace(/\/+/g, '/');
}

/** All files under src/pages, and the same list split into routes vs. private partials. */
function loadPageFiles() {
  const all = walk(PAGES_DIR);
  const routes = [];
  const partials = [];
  for (const abs of all) {
    const routePath = pageFileToRoutePath(abs);
    if (routePath === null) partials.push(abs);
    else routes.push({ abs, rel: relative(REPO, abs), routePath });
  }
  return { all, routes, partials };
}

function fmt(relPath) {
  return relPath.split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Check 1 — the root api/ directory must never be able to shadow a route
// ---------------------------------------------------------------------------

function checkNoApiShadow() {
  const lines = [];
  const violations = [];

  const forbidden = join(PAGES_DIR, 'api');
  const forbiddenExists = existsSync(forbidden);
  if (forbiddenExists) {
    violations.push(
      `src/pages/api exists. The root-level api/ directory (api/rebuild.ts, api/subscribe.ts) is a set of ` +
        `Vercel Functions that claims every /api/* request before Astro's own router is ever consulted — this is ` +
        `exactly what silently 404'd src/pages/waitlist/join.ts from 2026-09-13 to 2026-09-20 when it briefly lived ` +
        `at /api/waitlist (see that file's own header). Delete src/pages/api, or move whatever is in it beside the ` +
        `page it serves, the way waitlist/join.ts, ledger/prefs.ts and jobs-data/summary.ts do today.`
    );
  }

  const { routes } = loadPageFiles();
  const shadowed = routes.filter((r) => r.routePath === '/api' || r.routePath.startsWith('/api/'));
  for (const r of shadowed) {
    violations.push(
      `${fmt(r.rel)} resolves to ${r.routePath}, which the root api/ directory claims first on Vercel. This route ` +
        `will never be reached in production. Move it out from under /api, the same fix waitlist/join.ts needed.`
    );
  }

  const rootApiExists = existsSync(join(REPO, 'api'));
  lines.push(
    `root api/ directory: ${rootApiExists ? 'present (intentional Vercel Functions — rebuild.ts, subscribe.ts)' : 'absent'}`
  );
  lines.push(`src/pages/api: ${forbiddenExists ? 'EXISTS — this must not' : 'absent, as required'}`);
  lines.push(`${routes.length} route files scanned for a /api/* path; ${shadowed.length} collide with the root api/ directory`);

  return {
    id: 1,
    name: 'no src/pages route can be shadowed by the root api/ directory',
    status: violations.length === 0 ? EXIT.PASS : EXIT.FAIL,
    measured: routes.length,
    lines,
    violations
  };
}

// ---------------------------------------------------------------------------
// Check 2 — every route file under a gated prefix resolves to a ROUTE_POLICY
// ---------------------------------------------------------------------------

async function checkEveryGatedFileHasAPolicy() {
  const lines = [];
  const violations = [];

  let entitlement;
  try {
    entitlement = await import(pathToFileURL(join(REPO, 'src/lib/entitlement.ts')).href);
  } catch (error) {
    const message = String(error?.message ?? error);
    // entitlement.ts's own assertEveryGatedPrefixHasAPolicy() throws at import
    // time with a message that starts "entitlement:" — that is a real,
    // precise, actionable finding about the app, not a tooling failure, so it
    // is reported as a failed check rather than "could not run".
    if (message.startsWith('entitlement:')) {
      return {
        id: 2,
        name: 'every route file under a gated prefix resolves to a ROUTE_POLICY entry',
        status: EXIT.FAIL,
        measured: 0,
        lines: ['src/lib/entitlement.ts refused to load — its own self-check failed before this script could ask it anything:'],
        violations: [message]
      };
    }
    return {
      id: 2,
      name: 'every route file under a gated prefix resolves to a ROUTE_POLICY entry',
      status: EXIT.CANNOT_RUN,
      measured: 0,
      lines: [
        'Could not import src/lib/entitlement.ts as TypeScript.',
        'This script relies on Node importing a .ts file directly with type stripping ' +
          '(the default from Node 22.18 / Node 24 on — package.json pins "node": "24.x"). ' +
          'On an older Node this import fails and this check cannot run at all.'
      ],
      violations: [`import failed: ${message}`]
    };
  }

  const { isGated, requiredTierFor } = entitlement;
  const { routes } = loadPageFiles();
  const gated = routes.filter((r) => isGated(r.routePath));

  for (const r of gated) {
    const tier = requiredTierFor(r.routePath);
    if (tier === null) {
      violations.push(
        `${fmt(r.rel)} resolves to ${r.routePath}, which src/lib/entitlement.ts's own isGated() says is gated, but ` +
          `requiredTierFor() returns no tier for it. A request to this path is denied for EVERYONE, including an ` +
          `internal account, with reason "no-policy-declared". Add an entry to ROUTE_POLICY in src/lib/entitlement.ts.`
      );
    }
  }

  lines.push(`${routes.length} route files scanned; ${gated.length} fall under a GATED_PREFIXES prefix`);
  if (gated.length === 0) {
    lines.push('WARNING: zero gated route files were found. That almost certainly means this check is broken, ' +
      'not that the app has no gated routes — src/lib/entitlement.ts lists GATED_PREFIXES including /desk, /profile ' +
      'and /settings, and files exist under all of them.');
  }

  return {
    id: 2,
    name: 'every route file under a gated prefix resolves to a ROUTE_POLICY entry',
    status: violations.length === 0 && gated.length > 0 ? EXIT.PASS : violations.length > 0 ? EXIT.FAIL : EXIT.CANNOT_RUN,
    measured: gated.length,
    lines,
    violations
  };
}

// ---------------------------------------------------------------------------
// Check 3 — every non-retired gate id names a runner file that exists here
// ---------------------------------------------------------------------------

async function checkEveryGateHasARunner() {
  const lines = [];
  const violations = [];

  let GATES;
  try {
    ({ GATES } = await import(pathToFileURL(join(REPO, 'test/gates.config.mjs')).href));
  } catch (error) {
    return {
      id: 3,
      name: 'every non-retired gate id in test/gates.config.mjs has a runner in this repo',
      status: EXIT.CANNOT_RUN,
      measured: 0,
      lines: ['Could not import test/gates.config.mjs.'],
      violations: [String(error?.message ?? error)]
    };
  }

  const retired = GATES.filter((g) => g.retired);
  const active = GATES.filter((g) => !g.retired);
  const missing = [];

  for (const gate of active) {
    const runnerArg = Array.isArray(gate.run) ? gate.run[0] : undefined;
    if (!runnerArg) {
      missing.push({ id: gate.id, reason: 'no run[0] script path is declared for this gate at all' });
      continue;
    }
    const runnerPath = join(REPO, runnerArg);
    if (!existsSync(runnerPath)) {
      missing.push({ id: gate.id, reason: `${runnerArg} does not exist` });
    }
  }

  if (missing.length > 0) {
    violations.push(
      `src/pages/colophon.astro reads GATES from test/gates.config.mjs and publishes a PASS/FAIL verdict per gate ` +
        `to every visitor of /colophon. This repository has no test/gates/ directory at all, so ${missing.length} of ` +
        `${active.length} non-retired gates name a runner that does not exist and cannot have produced any verdict ` +
        `colophon is showing. This script does not decide whether the fix is to build these gates or to have ` +
        `colophon stop publishing a claim for gates nothing runs — regression-strategy.md section 6.5 names that ` +
        `as the owner's ruling. The full list, so the ruling can be made with real information:`
    );
    for (const m of missing) violations.push(`  gate "${m.id}": ${m.reason}`);
  }

  lines.push(`${GATES.length} gates registered (${active.length} active, ${retired.length} retired)`);
  lines.push(`${missing.length} of ${active.length} active gates have no runner file in this repo`);

  return {
    id: 3,
    name: 'every non-retired gate id in test/gates.config.mjs has a runner in this repo',
    status: violations.length === 0 ? EXIT.PASS : EXIT.FAIL,
    measured: active.length,
    lines,
    violations
  };
}

// ---------------------------------------------------------------------------
// Check 4 — orphan routes: a "private" partial under src/pages nothing uses
// ---------------------------------------------------------------------------

function checkNoOrphanPartials() {
  const lines = [];
  const violations = [];

  const { partials } = loadPageFiles();

  // The reachable set this check can actually see: every text file under src/,
  // excluding node_modules, so a partial imported from anywhere in the app
  // (a page, a component, a layout, another partial) counts as used.
  const SRC_DIR = join(REPO, 'src');
  const searchable = walk(SRC_DIR).filter((f) => /\.(astro|ts|tsx|js|mjs)$/i.test(f));
  const contentsByFile = new Map();
  for (const f of searchable) {
    try {
      contentsByFile.set(f, readFileSync(f, 'utf8'));
    } catch {
      // Unreadable file (permissions, race with an editor save): skip it
      // rather than fail the whole gate over one file it cannot open.
    }
  }

  for (const partialAbs of partials) {
    const basenameNoExt = relative(PAGES_DIR, partialAbs).split(sep).pop().replace(ROUTE_EXT, '');
    let referencedElsewhere = false;
    for (const [file, contents] of contentsByFile) {
      if (file === partialAbs) continue;
      if (contents.includes(basenameNoExt)) {
        referencedElsewhere = true;
        break;
      }
    }
    if (!referencedElsewhere) {
      violations.push(
        `${fmt(relative(REPO, partialAbs))} starts with "_", Astro's own convention for "not a route" — it exists ` +
          `only to be imported by the page that owns it. Nothing under src/ imports it any more. Either delete it or ` +
          `import it from the page it belongs to.`
      );
    }
  }

  lines.push(`${partials.length} "_"-prefixed partials found under src/pages`);
  if (partials.length === 0) {
    lines.push('No "_"-prefixed files exist under src/pages right now, so this check has nothing of this shape to ' +
      'measure. That is a true zero, not a broken check — see this run\'s HONEST LIMIT below for what this check ' +
      'still cannot see.');
  }

  return {
    id: 4,
    name: 'no orphaned "_"-prefixed partial sits under src/pages unused',
    status: violations.length === 0 ? EXIT.PASS : EXIT.FAIL,
    measured: partials.length,
    lines,
    violations
  };
}

// ---------------------------------------------------------------------------
// Check 5 — src/data/nav.ts and the real route files agree, in both directions
// ---------------------------------------------------------------------------

/**
 * Real route files with no src/data/nav.ts entry, verified legitimate and
 * recorded here with the reason, one line each, per the task brief. A route
 * added here without one of these two properties (nobody in this codebase
 * ever needs to build its URL by hand, OR it is a framework-reserved path)
 * should be registered in nav.ts instead of allowlisted.
 *
 * The four real gaps this research found are deliberately NOT here — see
 * this check's violations when they are not in nav.ts either:
 *   /billing/checkout                    hand-typed via withBase('/billing/checkout')
 *                                         in DoorFree.astro and the-account.astro
 *   /desk/job-draft/[slug]/restore       hand-typed via a template string in
 *                                         DraftRoomV2.astro (`${jobDraftPath(slug)}/restore`)
 *   /jobs-data/summary                   hand-typed via withBase(...) in jobs-data.astro
 *                                         AND a literal string in public/scripts/ledger-v4-app.js
 *   /upgrade                             hand-typed via withBase('/upgrade') in
 *                                         billing/checkout.ts's Stripe cancel_url
 * Each of those is exactly the failure mode nav.ts's own header warns about
 * ("Never type a path in a page; call routeFor()"), and each already has a
 * sibling route (settings-*, desk-job-draft-*) that IS registered — so this is
 * reported as a real gap, not allowlisted.
 */
const LEGITIMATELY_UNLISTED_ROUTE_FILES = [
  { path: '/404', reason: "Astro's own reserved not-found page; nothing ever constructs this path, a reader lands on it." },
  { path: '/auth/[...all]', reason: "better-auth's catch-all mount point; every /auth/* request is handed to the library, never built by hand." },
  { path: '/billing/webhook', reason: 'Stripe calls this directly with a URL configured on the Stripe dashboard; nothing in this repo ever constructs it.' },
  { path: '/board/kills.json', reason: "A published data feed for an off-site consumer (the Anti Algo marketing site's evidence page); read, never built with routeFor here." },
  { path: '/board/stats.json', reason: 'A published data feed read over HTTP by test/gates/truth.mjs\'s --url mode and by INDEX_STATS_URL; never built with routeFor here.' },
  { path: '/login', reason: "The page's own header states it is registered in no nav/flag/entitlement map and linked from nowhere, on purpose (an owner-only manual URL)." },
  { path: '/tasks/nudge', reason: 'A scheduled endpoint triggered by a cron, not by any link; never constructed by hand anywhere in this codebase.' }
];

/**
 * nav.ts patterns with no matching source file under src/pages, verified
 * legitimate. /accessibility-report.txt is written directly into dist/ by
 * gate 1 (see its note in src/data/nav.ts) — it has no Astro route behind it
 * by design.
 */
const LEGITIMATELY_FILELESS_NAV_PATTERNS = [
  { pattern: '/accessibility-report.txt', reason: 'Written directly into dist/ by test/gates/a11y.mjs (gate 1); it has no Astro source file by design.' }
];

async function checkNavAgreesWithRealFiles() {
  const lines = [];
  const violations = [];

  let ROUTES;
  try {
    ({ ROUTES } = await import(pathToFileURL(join(REPO, 'src/data/nav.ts')).href));
  } catch (error) {
    const message = String(error?.message ?? error);
    return {
      id: 5,
      name: 'every src/data/nav.ts pattern resolves to a real file, and every real file is in nav.ts or allowlisted',
      status: EXIT.CANNOT_RUN,
      measured: 0,
      lines: [
        'Could not import src/data/nav.ts as TypeScript.',
        'This script relies on Node importing a .ts file directly with type stripping ' +
          '(the default from Node 22.18 / Node 24 on — package.json pins "node": "24.x"). ' +
          'On an older Node this import fails and this check cannot run at all.'
      ],
      violations: [`import failed: ${message}`]
    };
  }

  const { routes } = loadPageFiles();
  const realPaths = new Set(routes.map((r) => r.routePath));
  const navPatterns = new Set(ROUTES.map((r) => r.pattern));
  const filelessAllowlist = new Set(LEGITIMATELY_FILELESS_NAV_PATTERNS.map((e) => e.pattern));
  const unlistedAllowlist = new Set(LEGITIMATELY_UNLISTED_ROUTE_FILES.map((e) => e.path));

  // Direction A: every nav.ts pattern must resolve to a real file, or be on
  // the fileless allowlist above.
  let filelessCount = 0;
  for (const key of ROUTES) {
    if (realPaths.has(key.pattern)) continue;
    if (filelessAllowlist.has(key.pattern)) {
      filelessCount += 1;
      continue;
    }
    violations.push(
      `src/data/nav.ts key "${key.key}" declares pattern ${key.pattern}, and no file under src/pages resolves to ` +
        `that path. Either the file was renamed or removed and nav.ts was not updated, or this pattern needs a ` +
        `one-line reason added to LEGITIMATELY_FILELESS_NAV_PATTERNS in this script.`
    );
  }

  // Direction B: every real route file must be in nav.ts, or on the
  // legitimately-unlisted allowlist above.
  let unlistedCount = 0;
  const newGaps = [];
  for (const r of routes) {
    if (navPatterns.has(r.routePath)) continue;
    if (unlistedAllowlist.has(r.routePath)) {
      unlistedCount += 1;
      continue;
    }
    newGaps.push(r);
  }

  for (const r of newGaps) {
    violations.push(
      `${fmt(r.rel)} resolves to ${r.routePath}, which is in neither src/data/nav.ts nor this script's ` +
        `LEGITIMATELY_UNLISTED_ROUTE_FILES allowlist. If nothing in this codebase ever needs to build this URL by ` +
        `hand, add it to nav.ts's ROUTES and reference it with routeFor()/a dedicated path builder wherever it is ` +
        `linked or posted to. If it is a framework-reserved or server-to-server path nothing ever constructs, add ` +
        `a one-line reason to LEGITIMATELY_UNLISTED_ROUTE_FILES in this script instead.`
    );
  }

  lines.push(`${ROUTES.length} nav.ts route keys checked against ${routes.length} real route files`);
  lines.push(`${filelessCount} nav.ts pattern(s) allowlisted as fileless (by design, e.g. a gate-written artifact)`);
  lines.push(`${unlistedCount} of ${unlistedAllowlist.size} allowlisted real files confirmed still absent from nav.ts, as expected`);
  lines.push(`${newGaps.length} route file(s) are in neither nav.ts nor the allowlist`);

  return {
    id: 5,
    name: 'every src/data/nav.ts pattern resolves to a real file, and every real file is in nav.ts or allowlisted',
    status: violations.length === 0 ? EXIT.PASS : EXIT.FAIL,
    measured: ROUTES.length + routes.length,
    lines,
    violations
  };
}

// ---------------------------------------------------------------------------
// Run every check, print the summary block, decide the exit code
// ---------------------------------------------------------------------------

const STATUS_LABEL = { [EXIT.PASS]: 'PASS', [EXIT.FAIL]: 'FAIL', [EXIT.CANNOT_RUN]: 'COULD NOT RUN' };

// The ratchet applies to these two checks only, one coarse finding id each —
// see the RATCHET header comment above and accepted.json's own entries for
// why they are this coarse. Every other check is typed as fatal directly by
// its own `status`, with no id and no allowlist that could swallow a new
// violation.
const GATE_NAME = 'gate-invariants';
const RATCHET_FINDING_ID = {
  3: 'invariants:check-3:gates-without-runners',
  5: 'invariants:check-5:paths-not-in-nav'
};

async function main() {
  const results = [
    checkNoApiShadow(),
    await checkEveryGatedFileHasAPolicy(),
    await checkEveryGateHasARunner(),
    checkNoOrphanPartials(),
    await checkNavAgreesWithRealFiles()
  ];

  console.log('gate-invariants: filesystem and source checks, no browser, no database, no network.\n');

  for (const result of results) {
    console.log(`--- check ${result.id}: ${result.name} ---`);
    for (const line of result.lines) console.log(`  ${line}`);
    if (result.violations.length > 0) {
      console.log(`  ${result.violations.length} problem(s) found:`);
      for (const v of result.violations) console.log(`  - ${v}`);
    }
    console.log('');
  }

  // One finding per failing ratcheted check (never one per gate id or per
  // route file — that granularity is accepted.json's call, not this
  // script's), fed to the same partition() every other gate uses. A check
  // that is not in RATCHET_FINDING_ID, or that is not currently FAILing
  // (including CANNOT_RUN, which the ratchet never covers), contributes no
  // finding here at all.
  const coarseFindings = [];
  for (const result of results) {
    const findingId = RATCHET_FINDING_ID[result.id];
    if (findingId && result.status === EXIT.FAIL) coarseFindings.push({ id: findingId });
  }
  const { fresh, accepted, stale } = partition(GATE_NAME, coarseFindings);
  const freshIds = new Set(fresh.map((f) => f.id));

  report({ accepted, stale }, { log: console.log });

  console.log('\n=== summary ===');
  for (const result of results) {
    const findingId = RATCHET_FINDING_ID[result.id];
    // A ratcheted check that is FAILing but whose one finding is accepted is
    // shown as failing-but-accepted, never as PASS — relabeling it PASS is
    // the exact lie this ratchet exists to stop. Anything not ratcheted, or
    // whose finding is fresh, or that CANNOT_RUN, prints its real status.
    const acceptedNotFresh = findingId && result.status === EXIT.FAIL && !freshIds.has(findingId);
    const label = (acceptedNotFresh ? 'FAIL (accepted)' : STATUS_LABEL[result.status]).padEnd(14);
    console.log(`check ${result.id}  ${label}  measured ${result.measured}  — ${result.name}`);
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`\n${elapsedMs.toFixed(1)}ms`);

  // Fatality: every non-ratcheted check keeps deciding it by its own status,
  // exactly as before. A ratcheted check's FAIL is fatal unless its one
  // finding is accepted and not fresh. A stale entry is fatal on its own —
  // it means the ratchet is recording a decision about something that no
  // longer happens, and the only honest response is to make the gate red
  // until the owner deletes that line.
  let worst = EXIT.PASS;
  for (const result of results) {
    const findingId = RATCHET_FINDING_ID[result.id];
    if (findingId && result.status === EXIT.FAIL && !freshIds.has(findingId)) continue;
    worst = Math.max(worst, result.status);
  }
  if (stale.length > 0) worst = Math.max(worst, EXIT.FAIL);

  if (worst === EXIT.CANNOT_RUN) {
    console.error('\nAt least one check could not run at all. That counts as a failure, not a pass: a gate that ' +
      'could not run has measured nothing.');
  } else if (worst === EXIT.FAIL) {
    console.error('\nAt least one check found a real problem, or an accepted finding in test/conform/accepted.json ' +
      'no longer reproduces. See the list above for the file, what is wrong, and what to do about it.');
  }
  process.exit(worst);
}

main();
