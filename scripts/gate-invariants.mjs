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
 * there must fail loudly with no allowlist that could swallow it. Check 7 is
 * not ratcheted either, and it carries its own exceptions instead
 * (DISCLOSURE_EXCEPTIONS, down in that check) for a reason specific to it: an
 * accepted.json entry is a coarse "the owner has seen this", whereas each of
 * those four entries names a marker in the file that this script re-verifies on
 * every run, so the exception fails by itself the moment its reason stops being
 * true. That distinction matters for this check more than for the others,
 * because what it guards is a page telling a reader something false about how
 * fresh it is. A ratchet
 * entry whose finding stops reproducing is reported as stale and is ALSO
 * fatal — an accepted line that no longer happens is the ratchet lying, and
 * the gate says so instead of quietly staying green.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
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
// Check 6 — no test file lives under src/pages, because Astro would build it
// ---------------------------------------------------------------------------

/**
 * Astro's file router builds EVERY file under src/pages as a route. A *.test.ts
 * there becomes a real, servable page, and `astro build` — the exact command
 * Vercel runs — then crashes trying to prerender it:
 *
 *   Vitest mocker was not initialized in this environment.
 *   vi.queueMock() is forbidden.
 *
 * THE BUILD. NOT A TEST. NOT A WARNING. The deploy.
 *
 * This repo has met it twice. Commit 7ae30de is titled "Move the prelist render
 * test out of src/pages so Astro stops building it as a route", and
 * test/desk-job-draft-post.test.ts carries the same warning in its own header —
 * which is to say the knowledge existed, in prose, in two places, and was
 * rediscovered anyway on 2026-09-24 when three new endpoint tests were written
 * beside the endpoints they test. That is exactly what a comment cannot do and a
 * check can.
 *
 * The underscore convention does not save you: Astro excludes a leading `_`, so
 * `_tier.test.ts` would not be routed, but nobody writing a test thinks to do
 * that, and the fix is to put the file in test/ where its neighbours already are.
 */
function checkNoTestFilesUnderPages() {
  const lines = [];
  const violations = [];

  const PAGES_DIR = join(REPO, 'src', 'pages');
  const all = walk(PAGES_DIR);
  const tests = all.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/i.test(basename(f)));

  for (const f of tests) {
    const rel = relative(REPO, f);
    // A leading underscore genuinely is excluded by Astro's router, so it is not
    // a build break — but it is still the wrong home for a test, so say so
    // without failing.
    if (basename(f).startsWith('_')) {
      lines.push(`${rel} is underscore-prefixed so Astro will not route it, but a test still belongs in test/.`);
      continue;
    }
    violations.push(
      `${rel} sits under src/pages, so Astro's file router will build it as a route and ` +
        `\`npm run build\` will crash prerendering it ("Vitest mocker was not initialized in this ` +
        `environment"). Move it to test/ — its neighbours are already there, and both ` +
        `test/desk-job-draft-post.test.ts's header and commit 7ae30de record why.`
    );
  }

  if (violations.length === 0) {
    lines.push(`${all.length} files under src/pages, none of them a test file.`);
  }

  return {
    id: 6,
    name: 'no test file sits under src/pages, where Astro would build it as a route',
    status: violations.length === 0 ? EXIT.PASS : EXIT.FAIL,
    measured: all.length,
    lines,
    violations
  };
}

// ---------------------------------------------------------------------------
// Check 7 — every route that renders a dated figure says how old it is
// ---------------------------------------------------------------------------

/**
 * AGE DISCLOSURE: COVERAGE, NOT A HEADCOUNT.
 *
 * This check used to do two things. It held every data-swept stamp to one
 * expression, which was right and is kept below, and then it asserted
 * `stamps.length >= 2`, which was the mistake. Two was the number of stamps
 * that existed the day it was written — / and /board — so the floor was met by
 * the status quo and could never be anything but met. It passed on the day
 * /prelist shipped rendering scored rows with no stamp of any kind. It passed
 * every day /jobs-data labelled tens of thousands of crawled rows "Verified
 * live tonight" over no instant at all. It would have passed on a job detail
 * page whose entire freshness promise was a hardcoded string, which is what
 * that page was, with the Apply button on it.
 *
 * A count cannot see an absence. It can only see a shortage, and only below a
 * number someone guessed. So this check enumerates the ROUTES and asks each one
 * the question, which means a route that does not exist yet is already covered
 * by it.
 *
 * It is three parts:
 *
 *   A. THE SHELL STILL CARRIES THE DEFAULT. src/layouts/BaseLayout.astro
 *      renders the band every route inherits. If that goes, every route on the
 *      site loses its disclosure at once and no page-level check would notice,
 *      because each page would still be doing exactly what it always did.
 *
 *   B. EVERY STAMP NAMES THE RIGHT CLOCK. The original rule, unchanged in
 *      substance: the site has two real instants, both parse, both look right
 *      in review, and printing the sweep's over the crawl's rows overstates
 *      their freshness. On 2026-09-30 it did, by two days. So a stamp may only
 *      be one of a named set of locals, each bound to the helper that has to
 *      produce it.
 *
 *   C. A ROUTE THAT READS A DATED POPULATION DISCLOSES IT. Inheriting the
 *      shell's default is enough for a route whose figures come from the sweep,
 *      because the default IS the sweep's instant. A route reading the crawl has
 *      to override it, because the crawl finishes hours later and the shell
 *      cannot know. Every crawl-reading route therefore has to do one of: carry
 *      its own crawl stamp, hand the crawl instant to the shell, render a
 *      component that stamps the row itself, or appear below with a reason that
 *      this check VERIFIES rather than takes on trust.
 *
 * WHY THE EXCEPTIONS ARE CHECKED AND NOT LISTED. The audit that produced this
 * work found two root patterns, and the second was a guard built correctly,
 * never wired to anything, and then written down in a comment as done. A bare
 * allowlist is that pattern with extra steps: four paths that mean "trust me".
 * So each entry below names a marker in the file that must still be there for
 * the reason to hold, and the entry fails when the marker goes. An exception
 * whose reason has stopped being true is this check lying, and it says so
 * instead of staying green — the same stance the ratchet at the top of this file
 * takes on an accepted finding that no longer reproduces.
 *
 * HONEST LIMIT. "Reads the crawl" is computed from imports: the route's own
 * source, plus one hop through each src/ module it imports. One hop is what
 * /jobs-data needs (it reaches job-store through src/lib/jobs-data-page.ts) and
 * it is where this stops. A route that reaches the crawl through two
 * intermediate modules is invisible to this check, and the honest reason to
 * stop there rather than walk the whole graph is that a full transitive walk
 * classifies nearly every route as a crawl reader — src/lib is well connected —
 * and a check that flags /privacy for reading job rows is a check that gets
 * switched off. It also cannot see whether a figure is actually rendered,
 * only whether the data was read; the four entries below are where that gap
 * lives, and each one is pinned by a marker.
 */

/** Where stamps are allowed to live, and therefore where they are checked. */
const STAMP_ROOTS = [
  ['src', 'pages'],
  ['src', 'layouts'],
  ['src', 'components']
];

const LAYOUT_REL = 'src/layouts/BaseLayout.astro';

/**
 * The only expressions a data-swept attribute may hold, each with the helper
 * that must appear in the same file to have produced it. The point is not that
 * the identifier looks plausible — the 2026-09-30 defect was a plausible
 * identifier holding the wrong true instant — it is that the name and the
 * helper agree, in one place, per file.
 */
const STAMP_CONTRACT = {
  boardRowsAt: {
    population: 'crawl',
    requires: /boardRowsLoadedAt\(/,
    requiresLabel: 'boardRowsLoadedAt()',
    note:
      "the crawl's own load instant, normalised. board_stats.swept_at comes back as a Date from the pg " +
      'driver and as a string from JSON, and the raw Date stringifies to "Mon Sep 28 2026 13:43:00 GMT+0000 ' +
      '(Coordinated Universal Time)" in an attribute, which is why the helper exists rather than a .swept_at ' +
      'read at each call site.'
  },
  sweptIso: {
    population: 'sweep',
    requires: /sweptAt\(|loadStats\(\)/,
    requiresLabel: 'sweptAt() or loadStats()',
    note:
      "the nightly sweep's instant, for a surface whose rows came out of the committed export rather than " +
      'out of Postgres.'
  },
  ageAt: {
    population: 'either',
    onlyIn: LAYOUT_REL,
    requires: /dataAt \?\? sweptAt\(\)/,
    requiresLabel: 'dataAt ?? sweptAt()',
    note: "the shell's own band: the route's instant when it passed one, the sweep's when it did not."
  },
  verifiedAt: {
    population: 'row',
    onlyIn: 'src/components/job-detail-v2/JobDetailV2.astro',
    requires: /job\.last_verified/,
    requiresLabel: 'job.last_verified',
    note:
      'one posting\'s own last-verified instant. A reader on a detail page is asking about THAT row, and the ' +
      'row carries its own answer, so this is neither of the two site-wide instants.'
  }
};

/**
 * Routes that read a dated population and disclose it some other way, or do not
 * render it at all. Each entry states the reason and the marker that has to
 * still be in the file for the reason to hold. `requires` must all be present;
 * `forbids` must all be absent.
 */
const DATED_RENDER_MARKERS = ['formatDate(', 'daysBetween(', 'sweptStamp(', 'dayStamp(', 'sweepDate('];

const DISCLOSURE_EXCEPTIONS = {
  'src/pages/desk.astro': {
    why:
      'prints its own swept stamp in the daily header ("swept Sep 30, 2026") rather than carrying the band. ' +
      'That is disclosure, in the place a member actually reads, and reshaping it into a data-swept stamp ' +
      'would be a design change this check has no business forcing.',
    requires: ['dh-swept', 'home.sweep.sweptAt']
  },
  'src/pages/opportunities.astro': {
    why:
      'discloses per ROW instead of per page: every tracked posting carries its own asOf instant and a stale ' +
      'flag off the sweep, which is finer than a page band, not coarser. A single stamp over rows observed on ' +
      'different nights would be less true than what it already does.',
    requires: ['staleSweep', 'asOf']
  },
  'src/pages/internal/index.astro': {
    why:
      'reaches job-store through src/lib/health.ts, which is a health read rather than a figure: this page ' +
      'renders no sweep- or crawl-derived date. Its one date is dayStamp(a.created), an account\'s own signup ' +
      'day off the accounts table, which is a fact about a person and does not go stale when the machine ' +
      'sleeps. Verified as a NEGATIVE — a date helper used anywhere else on this page fails this entry rather ' +
      'than being quietly covered by it.',
    forbids: DATED_RENDER_MARKERS,
    allows: ['dayStamp(a.created)']
  },
  'src/pages/desk/job-draft/[slug].astro': {
    why:
      'reaches job-store through src/lib/draft-job.ts to find the posting it is drafting against, and renders ' +
      'none of its dates: it is the draft hand-off, not a surface that shows a figure. Verified as a negative, ' +
      'the same way, for the same reason.',
    forbids: DATED_RENDER_MARKERS
  }
};

const MODULE_EXT = ['.ts', '.tsx', '.mjs', '.js', '.astro'];

/** A relative import specifier, resolved to a real file under the repo. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = join(fromFile, '..', spec);
  for (const ext of ['', ...MODULE_EXT]) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const ext of MODULE_EXT) {
    const candidate = join(base, `index${ext}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importSpecs(src) {
  return [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
}

function checkAgeDisclosure() {
  const lines = [];
  const violations = [];

  const JOB_STORE = join(REPO, 'src', 'lib', 'job-store.ts');

  // --- part A: the shell's default band -----------------------------------
  const layoutAbs = join(REPO, LAYOUT_REL.split('/').join(sep));
  const layoutSrc = existsSync(layoutAbs) ? readFileSync(layoutAbs, 'utf8') : null;
  if (layoutSrc === null) {
    violations.push(`${LAYOUT_REL} is missing, so no route can inherit an age band.`);
  } else {
    const hasBand = /data-age-disclosure/.test(layoutSrc) && /data-swept=\{ageAt\}/.test(layoutSrc);
    const hasWindow = /data-fresh-hours=\{FRESH_WINDOW_HOURS\}/.test(layoutSrc);
    const hasDefault = /dataAt \?\? sweptAt\(\)/.test(layoutSrc);
    if (!hasBand) {
      violations.push(
        `${LAYOUT_REL} no longer renders the age band (an element with data-age-disclosure and ` +
          `data-swept={ageAt}). That band is what makes age disclosure structural: every route renders inside ` +
          `this shell, so removing it takes the disclosure off all of them at once, and no per-page check ` +
          `would report anything, because every page would still be doing exactly what it always did. ` +
          `/prelist shipped with no stamp for precisely this reason — there was nowhere the obligation lived.`
      );
    }
    if (hasBand && !hasWindow) {
      violations.push(
        `${LAYOUT_REL} renders the age band without data-fresh-hours={FRESH_WINDOW_HOURS}. The band's script ` +
          `reads the window off the markup so there is one copy of the threshold; without it the script falls ` +
          `back to a literal and the band and src/lib/data-contract.ts can drift apart silently.`
      );
    }
    if (hasBand && !hasDefault) {
      violations.push(
        `${LAYOUT_REL} no longer defaults the band's instant to \`dataAt ?? sweptAt()\`. The default is what a ` +
          `route that passes nothing inherits; without it a new route renders a band with no instant in it.`
      );
    }
    if (hasBand && hasWindow && hasDefault) {
      lines.push(`${LAYOUT_REL} carries the default age band (data-swept={ageAt}, dataAt ?? sweptAt()).`);
    }
  }

  // --- part B: every stamp names the right clock ---------------------------
  const stampFiles = [];
  for (const root of STAMP_ROOTS) {
    const dir = join(REPO, ...root);
    if (existsSync(dir)) stampFiles.push(...walk(dir).filter((f) => f.endsWith('.astro')));
  }

  const stamps = [];
  for (const abs of stampFiles) {
    const src = readFileSync(abs, 'utf8');
    const rel = fmt(relative(REPO, abs));
    for (const m of src.matchAll(/data-swept=\{([^}]*)\}/g)) {
      const expr = m[1].trim();
      const line = src.slice(0, m.index).split('\n').length;
      stamps.push({ rel, line, expr });

      const contract = STAMP_CONTRACT[expr];
      if (!contract) {
        violations.push(
          `${rel}:${line} stamps data-swept={${expr}}, which is not one of the named instants ` +
            `(${Object.keys(STAMP_CONTRACT).join(', ')}). This site has two real site-wide instants and they are ` +
            `hours apart: the nightly sweep of 45 curated boards, and the crawl of ~1,666 boards that finishes ` +
            `later. Both parse. Neither looks wrong in review. On 2026-09-30 the board's stamp carried the ` +
            `sweep's instant over the crawl's rows and the page claimed they were verified four minutes ago ` +
            `when they had been loaded two days earlier. Add the expression to STAMP_CONTRACT in this file ` +
            `with the helper that produces it, or use one that is already there.`
        );
        continue;
      }
      if (contract.onlyIn && contract.onlyIn !== rel) {
        violations.push(
          `${rel}:${line} stamps data-swept={${expr}}, which is reserved for ${contract.onlyIn} ` +
            `(${contract.note}). Using the name elsewhere makes two different instants share one identifier, ` +
            `which is how the wrong one gets printed by a reader of this code rather than by a bug.`
        );
      }
      if (!contract.requires.test(src)) {
        violations.push(
          `${rel}:${line} stamps data-swept={${expr}} but the file never calls ${contract.requiresLabel}, so ` +
            `that local is being built some other way. The point of binding the name to the helper is that the ` +
            `normalisation lives in one place: ${contract.note}`
        );
      }
    }
  }

  // --- part C: every crawl-reading route discloses the crawl's instant -----
  const { routes } = loadPageFiles();
  const pageRoutes = routes.filter((r) => r.abs.endsWith('.astro'));

  /** Does this route reach job-store, directly or one hop through src/? */
  function crawlReach(abs, src) {
    for (const spec of importSpecs(src)) {
      const direct = resolveImport(abs, spec);
      if (!direct) continue;
      if (direct === JOB_STORE) return `imports job-store directly ('${spec}')`;
      if (!direct.startsWith(join(REPO, 'src'))) continue;
      let hopSrc;
      try {
        hopSrc = readFileSync(direct, 'utf8');
      } catch {
        continue;
      }
      for (const hopSpec of importSpecs(hopSrc)) {
        if (resolveImport(direct, hopSpec) === JOB_STORE) {
          return `reaches job-store through ${fmt(relative(REPO, direct))}`;
        }
      }
    }
    return null;
  }

  const crawlRoutes = [];
  const usedExceptions = new Set();

  for (const route of pageRoutes) {
    const src = readFileSync(route.abs, 'utf8');
    const rel = fmt(route.rel);
    const why = crawlReach(route.abs, src);
    if (!why) continue;
    crawlRoutes.push({ rel, routePath: route.routePath, why });

    /* THE STAMPS ON A CRAWL ROUTE MUST CARRY A CRAWL INSTANT. This is the
     * original check's rule, restored after being generalised away.
     *
     * Part B asks whether an expression is A legal instant. That is not enough
     * on its own, and the first version of this check proved it: with
     * /jobs-data's visible stamp switched from boardRowsAt to sweptIso — the
     * sweep's instant, printed over ~57,000 crawled rows, which is the
     * 2026-09-30 defect exactly — the gate stayed green, because sweptIso is a
     * real instant correctly derived from a real helper and the route was
     * separately handing the crawl instant to the shell. A reader does not read
     * the shell's footnote; they read the line over the figure.
     *
     * So the population has to agree with the route, not merely exist. A sweep
     * stamp on a page whose numbers came out of Postgres overstates their
     * freshness however honestly that instant was obtained. */
    for (const stamp of stamps.filter((s) => s.rel === rel)) {
      const population = STAMP_CONTRACT[stamp.expr]?.population;
      if (population === 'sweep') {
        violations.push(
          `${rel}:${stamp.line} stamps data-swept={${stamp.expr}}, the SWEEP's instant, on a route that ` +
            `${why}. Both of this site's instants are real and both parse, which is why this is a gate and not ` +
            `a comment: the sweep reads 45 curated boards and finishes hours BEFORE the crawl loads ~1,666 of ` +
            `them into Postgres, so the sweep's instant printed over the crawl's figures says they are fresher ` +
            `than they are. On 2026-09-30 it did exactly that and the board claimed rows were verified four ` +
            `minutes earlier than they had in fact been loaded. Use boardRowsAt, from boardRowsLoadedAt().`
        );
      }
    }

    // Its own crawl stamp.
    if (/data-swept=\{boardRowsAt\}/.test(src)) {
      lines.push(`  ${route.routePath.padEnd(26)} ${rel} — own crawl stamp`);
      continue;
    }
    // Hands the crawl instant to the shell.
    if (/dataAt=\{boardRowsAt\}/.test(src) && /dataPopulation=\{[^}]*crawl|dataPopulation="crawl"/.test(src)) {
      lines.push(`  ${route.routePath.padEnd(26)} ${rel} — crawl instant passed to the shell`);
      continue;
    }
    /* A component it renders stamps the row itself.
     *
     * THE SHELL DOES NOT COUNT HERE, and leaving it out is the whole difference
     * between this check working and this check being decorative. Every route
     * imports BaseLayout and BaseLayout carries a stamp, so "does a component it
     * renders carry a stamp?" is true for all 44 routes and part C collapses
     * into a tautology — written one way it reported all eight crawl routes
     * covered, including the three that were the reason this work exists. What
     * earns coverage is a stamp of the right POPULATION: the crawl's instant, or
     * one posting's own. The shell's band is the sweep's by default, which is
     * the instant a crawl route must override, so it can never be the thing
     * that satisfies a crawl route. */
    let viaComponent = null;
    for (const spec of importSpecs(src)) {
      const target = resolveImport(route.abs, spec);
      if (!target || !target.endsWith('.astro')) continue;
      const compRel = fmt(relative(REPO, target));
      if (compRel === LAYOUT_REL) continue;
      const dated = stamps.find(
        (s) => s.rel === compRel && ['crawl', 'row'].includes(STAMP_CONTRACT[s.expr]?.population)
      );
      if (dated) {
        viaComponent = `${compRel} (${STAMP_CONTRACT[dated.expr].population})`;
        break;
      }
    }
    if (viaComponent) {
      lines.push(`  ${route.routePath.padEnd(26)} ${rel} — stamped by ${viaComponent}`);
      continue;
    }
    // A reason, verified.
    const exception = DISCLOSURE_EXCEPTIONS[rel];
    if (exception) {
      usedExceptions.add(rel);
      const missing = (exception.requires ?? []).filter((marker) => !src.includes(marker));
      /* A forbidden marker is checked against the source with the entry's named
       * exceptions removed first, so the negative stays EXACT instead of blunt.
       * /internal is why: it renders one date, an account's signup day, which is
       * not a sweep figure at all — and a bare `dayStamp(` ban called that a
       * violation. Blunting the marker list instead would have been the wrong
       * trade: `formatDate(` would then be legal on a page rendering a posting's
       * published date, which is exactly a crawl-derived figure. Naming the one
       * permitted call site keeps both true, and a SECOND use of the same helper
       * still fails, because only the named occurrence is removed. */
      const scrubbed = (exception.allows ?? []).reduce(
        (acc, allowed) => acc.split(allowed).join(''),
        src
      );
      const present = (exception.forbids ?? []).filter((marker) => scrubbed.includes(marker));
      if (missing.length > 0) {
        violations.push(
          `${rel} is listed here as disclosing by its own mechanism — ${exception.why} — but ${missing
            .map((m) => JSON.stringify(m))
            .join(', ')} is no longer in the file, so that reason has stopped being true. Either the mechanism ` +
            `moved, in which case update the marker, or it is gone, in which case this route now renders dated ` +
            `figures with nothing saying how old they are.`
        );
      } else if (present.length > 0) {
        violations.push(
          `${rel} is listed here as rendering no dated figure — ${exception.why} — but it now contains ${present
            .map((m) => JSON.stringify(m))
            .join(', ')}. It prints a date or an age, so it needs a real stamp: pass dataAt/dataPopulation to ` +
            `BaseLayout, or carry data-swept={boardRowsAt}. This is the exception catching its own expiry, ` +
            `which is what it is for.`
        );
      } else {
        lines.push(`  ${route.routePath.padEnd(26)} ${rel} — ${exception.forbids ? 'renders no dated figure' : 'discloses by its own mechanism'}`);
      }
      continue;
    }

    violations.push(
      `${rel} (${route.routePath}) ${why}, and nothing on it says how old that data is. It has no ` +
        `data-swept={boardRowsAt} of its own, it does not pass dataAt/dataPopulation to BaseLayout, and no ` +
        `component it renders stamps the row. It therefore inherits the shell's default band, which carries the ` +
        `SWEEP's instant — and this route's figures are the crawl's, which finishes hours later, so the page ` +
        `would report itself fresher than it is. Give it the crawl instant: ` +
        `\`const boardRowsAt = boardRowsLoadedAt(stats) ?? sweptAt();\` and pass ` +
        `\`dataAt={boardRowsAt} dataPopulation="crawl"\` to BaseLayout, the way src/pages/jobs-data.astro does. ` +
        `If it genuinely renders no dated figure, add it to DISCLOSURE_EXCEPTIONS in this file with a marker ` +
        `that proves it.`
    );
  }

  // A declared exception for a route that is no longer a crawl reader is this
  // check carrying a decision about something that has stopped happening. Same
  // stance the ratchet takes on an accepted finding that no longer reproduces:
  // say so, rather than stay green on a line nobody will revisit.
  for (const rel of Object.keys(DISCLOSURE_EXCEPTIONS)) {
    if (usedExceptions.has(rel)) continue;
    const exists = existsSync(join(REPO, rel.split('/').join(sep)));
    violations.push(
      exists
        ? `${rel} is listed in DISCLOSURE_EXCEPTIONS but no longer reads a dated population at all, so the ` +
            `entry is dead weight describing a problem this route does not have. Delete it.`
        : `${rel} is listed in DISCLOSURE_EXCEPTIONS and does not exist. Delete the entry.`
    );
  }

  if (violations.length === 0) {
    lines.push(
      `${stamps.length} data-swept stamp(s), every one a named instant bound to its helper:`
    );
    for (const s of stamps) lines.push(`  ${s.rel}:${s.line} = ${s.expr} (${STAMP_CONTRACT[s.expr].population})`);
    lines.push(
      `${crawlRoutes.length} of ${pageRoutes.length} page route(s) read the crawl; the other ` +
        `${pageRoutes.length - crawlRoutes.length} inherit the shell's sweep band, which is their own instant.`
    );
  }

  return {
    id: 7,
    name: 'every route that renders a dated figure discloses how old it is',
    status: violations.length === 0 ? EXIT.PASS : EXIT.FAIL,
    measured: pageRoutes.length,
    lines,
    violations
  };
}

function checkSweepMarker() {
  const lines = [];
  const violations = [];

  // The mini proves a deploy by fetching the public URL and looking for the
  // sweep instant verbatim (nightly.sh, "publish check"). That marker has to
  // live somewhere deliberate. It used to be borrowed from the board's
  // data-swept attribute, and on 2026-09-30 that attribute correctly changed
  // meaning -- it labels the crawl's rows now -- which silently removed the
  // only machine-readable copy of the sweep instant from every page. The
  // deploy was healthy; its proof had moved. This check exists so that cannot
  // happen quietly again.
  const LAYOUT = join(REPO, 'src', 'layouts', 'BaseLayout.astro');
  const rel = relative(REPO, LAYOUT);

  if (!existsSync(LAYOUT)) {
    violations.push(`${rel} is missing, so no page can carry the sweep marker.`);
  } else {
    const src = readFileSync(LAYOUT, 'utf8');
    const hasMeta = /<meta\s+name="sweep-instant"\s+content=\{sweptAt\(\)\}\s*\/>/.test(src);
    const imports = /import\s*\{[^}]*\bsweptAt\b[^}]*\}\s*from\s*'\.\.\/lib\/data'/.test(src);
    if (!hasMeta) {
      violations.push(
        `${rel} no longer emits <meta name="sweep-instant" content={sweptAt()} />. ` +
          `That tag is how the mini's nightly publish check proves the site is serving ` +
          `tonight's sweep: it fetches the public URL and greps the body for the instant ` +
          `out of stats.json. Without it the check finds nothing, alarms, and reports a ` +
          `broken deploy on a night when the deploy was fine -- the most expensive kind ` +
          `of false alarm, because it is the one that teaches you to ignore the real one.`
      );
    }
    if (hasMeta && !imports) {
      violations.push(`${rel} emits the sweep marker but no longer imports sweptAt from ../lib/data.`);
    }
    if (hasMeta && imports) lines.push(`${rel} emits <meta name="sweep-instant"> from sweptAt().`);
  }

  return {
    id: 8,
    name: "every page carries the sweep instant the machine greps for",
    status: violations.length === 0 ? EXIT.PASS : EXIT.FAIL,
    measured: 1,
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
    await checkNavAgreesWithRealFiles(),
    checkNoTestFilesUnderPages(),
    checkAgeDisclosure(),
    checkSweepMarker()
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
