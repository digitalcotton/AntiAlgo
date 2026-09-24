#!/usr/bin/env node
/**
 * route-census.mjs: the manifest a browser sweep reads, and the proof that
 * the manifest itself is not lying about what it covers.
 *
 * THE INCIDENT THIS GUARDS AGAINST. tokenstoagent/site-index's own route
 * census (test/route-census.mjs) records, in its own header, that a review
 * route was injected only under `astro dev` or `SPECIMEN=1`, so a
 * conformance run that read the wrong tree "measured one route and reported
 * six passes" — a fully green summary about a fraction of the site. A
 * hand-kept route list has the same failure shape: a route the sweep never
 * gets told about is a route that has never once thrown an error in front of
 * anybody watching, and nothing in a green run says so. So this is a census,
 * not a gate. It does not decide whether a route is correct. It enumerates
 * every route this app can serve, so Layer 1 (docs/regression-strategy.md
 * §5) has something honest to walk, and it asserts the enumeration itself
 * did not silently shrink.
 *
 * WHAT IT READS, AND WHY EACH READ IS LIVE RATHER THAN COPIED.
 *   - src/pages/**            the file router. One file, one route. A route
 *                              this script does not see is a route nobody
 *                              told the sweep about, which is exactly the
 *                              hole above.
 *   - `export const prerender = false`, grepped per file, never assumed.
 *     astro.config.mjs's own header says the site is "static by default...
 *     a route becomes dynamic only by saying so in its own file," so the
 *     directive IS the fact.
 *   - src/lib/entitlement.ts, IMPORTED AND EXECUTED, not re-typed. Its
 *     GATED_PREFIXES, ROUTE_POLICY and decide() are read by running the real
 *     module (via `node --experimental-strip-types`, spawned once below),
 *     because a second copy of a tier ladder is a second copy that goes
 *     stale the day someone edits the first one and not the second. This is
 *     the census's own rule turned on itself: "derived, never typed."
 *   - src/middleware.ts, for SESSION_AWARE — read as text (regex-extracted),
 *     because the file imports `astro:middleware`, a virtual module that
 *     only resolves inside Astro's own runtime, so it cannot be executed
 *     here the way entitlement.ts can. Extracting the one array literal this
 *     script needs is honest about that limit rather than pretending to run
 *     code it cannot run.
 *   - flags.config.mjs and tiers.config.mjs, imported directly (plain ESM,
 *     no Astro-only globals), for the flag-darkness that decides a route's
 *     status before entitlement ever sees the request.
 *   - src/data/jobs.json, for one concrete slug per job-shaped dynamic
 *     route, so the sweep has something real to click instead of a made-up
 *     id that 404s before the page under test even runs.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *   - It does not simulate getStaticPaths(). A dynamic route counts as ONE
 *     manifest entry with one example path, not one entry per job/kill/
 *     handle the data happens to hold today. Counting built pages is the
 *     conformance run's job (and it reads the actual dist/ tree, where the
 *     count can be trusted); this script's job is enumerating source files.
 *   - It does not model a page's own in-page redirect logic (a signed-in
 *     visitor bounced off /sign-in, a tier-branched /start). "Expected
 *     status per audience" here is the middleware/entitlement layer only:
 *     the flag-dark 404 and the tier gate. A page's own business logic on
 *     top of an allowed request is a behavioural test's job, not a census's.
 *   - It does not verify a machine-token or draft-run-token secret. Those
 *     routes are marked `gate: "machine-token"` and excluded from the
 *     audience matrix's tier arithmetic, but entitlement.ts's decide() has
 *     no opinion on them (they are not in GATED_PREFIXES at all), so if you
 *     read decide() in isolation it reports them "allowed" for a
 *     signed-out visitor. That is correct about entitlement.ts and wrong
 *     about the real HTTP response, which is 401/503 without the secret.
 *     The matrix printed below states this in the open rather than quietly
 *     folding machine routes into "public."
 *   - It does not treat `/board/[slug]` as fully gated. Nearly every slug on
 *     that route is public sweep content; only the `added-<id>` shape is
 *     owner-or-404 (src/lib/added-posting.ts, src/middleware.ts's
 *     isAddedDetailPath). The manifest says so in a note rather than forcing
 *     one tag onto a route that genuinely has two behaviours.
 *   - It never edits .gitignore. It only reports whether `.sweep/` needs a
 *     line there.
 *
 * RUN IT
 *   node scripts/route-census.mjs
 *
 * Exit 0: the manifest was written and every assertion held.
 * Exit 1: an assertion failed — the manifest is wrong or the route policy
 *         drifted in a way this script can detect. The message names the
 *         file, the rule, and what to do.
 * Exit 2: COULD NOT RUN — usually Node here lacks
 *         `--experimental-strip-types` (this repo targets Node 24; it is
 *         available from Node 22.6). Never reported as a pass: a census that
 *         could not read the real entitlement policy has measured nothing
 *         about who may load what, which is most of the point of this file.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'route census';
const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PAGES_DIR = join(REPO, 'src', 'pages');
const OUT_DIR = join(REPO, '.sweep');
const OUT_FILE = join(OUT_DIR, 'routes.json');
const EDITION = 'design'; // the only edition that deploys (flags.config.mjs's own header)

function abort(message, hint) {
  console.error(`\n${NAME}: COULD NOT RUN.\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(2);
}

const failures = [];
function fail(file, line, what, fix) {
  failures.push({ file, line, what, fix });
}

/* ------------------------------------------------------------- enumerate */

/**
 * One file, one route. Astro's own rule: a filename starting with `_` is not
 * a route (src/pages/kills/_KillStates.astro, _ShareCard.astro — shared
 * partials the kill pages import directly).
 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

function listRouteFiles() {
  if (!existsSync(PAGES_DIR)) {
    abort(`no src/pages directory at ${relative(REPO, PAGES_DIR)}`, 'Run this from the repo the census is written for.');
  }
  return walk(PAGES_DIR)
    .filter((f) => !basename(f).startsWith('_'))
    .sort();
}

/**
 * The file router's own mapping. Mirrors Astro: strip one trailing .astro or
 * .ts (leaving compound suffixes like .json, .svg, .md, .xml in the route,
 * because Astro does — board/kills.json.ts serves /board/kills.json, not
 * /board/kills), then drop a bare `index` segment.
 */
function fileToRoute(relFromPages) {
  const parts = relFromPages.split('/');
  let filename = parts.pop();
  if (filename.endsWith('.astro')) filename = filename.slice(0, -'.astro'.length);
  else if (filename.endsWith('.ts')) filename = filename.slice(0, -'.ts'.length);
  if (filename !== 'index') parts.push(filename);
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

const routeFiles = listRouteFiles();

/* ------------------------------------------------------------ prerender */

/**
 * Anchored to the start of a line, same guard the Index's census uses,
 * so a sentence like this file's own header ("carries `export const
 * prerender = false`") in a comment can never be mistaken for the directive.
 */
const PRERENDER_FALSE = /^\s*export\s+const\s+prerender\s*=\s*false\s*;?\s*$/m;

function isPrerenderFalse(source) {
  return PRERENDER_FALSE.test(source);
}

/* -------------------------------------------------------------- output kind
 *
 * The task names five kinds (HTML page / JSON / SVG / markdown / redirect).
 * Two more turned out to be real once every file was read: `xml` for
 * sitemap.xml.ts (there is exactly one, and calling an XML sitemap "JSON"
 * would be a worse lie than adding a kind), and `file` for the one route
 * that streams a generated DOCX/PDF and is neither markup nor JSON
 * (desk/job-draft/[slug]/[doc].ts). Both are named here rather than folded
 * into the nearest category, because the point of this column is telling a
 * sweep how to check the response, and a byte-stream assertion is not a
 * JSON-shape assertion.
 *
 * For a plain API .ts file (no .json/.svg/.md/.xml suffix), the kind is a
 * TEXT HEURISTIC over the file's own Response calls: a file whose 30x
 * responses outnumber its JSON-shaped ones is called `redirect`, and vice
 * versa. This is stated as a heuristic, not a fact, because a handler can
 * legitimately answer one way to a form POST and another to a fetch() call
 * (several settings/* and profile/* endpoints do exactly this). The
 * manifest's `outputKindNote` says so per file so nobody mistakes a guess
 * for a grep of a type.
 */
function astroBodyIsEmpty(source) {
  const m = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return false; // no frontmatter fence found; has a body by default
  return m[1].trim().length === 0;
}

function outputKindFor(absPath, routeFile) {
  const source = readFileSync(absPath, 'utf8');
  if (routeFile.endsWith('.astro')) {
    if (astroBodyIsEmpty(source) && /Astro\.redirect\(/.test(source)) {
      return { kind: 'redirect', note: 'frontmatter-only file whose only statement is Astro.redirect(); no markup ever renders.' };
    }
    return { kind: 'html', note: null };
  }
  // .ts endpoint. Strip .ts, then check compound suffixes on the bare filename.
  const base = basename(routeFile).slice(0, -'.ts'.length);
  if (base.endsWith('.json')) return { kind: 'json', note: null };
  if (base.endsWith('.svg')) return { kind: 'svg', note: null };
  if (base.endsWith('.md')) return { kind: 'markdown', note: null };
  if (base.endsWith('.xml')) return { kind: 'xml', note: null };
  if (/application\/pdf|officedocument|DOCX_CONTENT_TYPE/.test(source)) {
    return { kind: 'file', note: 'streams a generated DOCX or PDF, not markup or JSON.' };
  }
  if (routeFile === 'auth/[...all].ts') {
    return { kind: 'json', note: "delegates its entire response to Better Auth's own handler; the library decides status and shape per Better Auth endpoint, not this file." };
  }
  const redirectSignals = (source.match(/status:\s*30[1-8]\b/g) || []).length;
  const jsonSignals = (source.match(/application\/json/g) || []).length + (source.match(/JSON\.stringify\(/g) || []).length;
  if (redirectSignals === 0 && jsonSignals === 0) {
    return { kind: 'json', note: 'no explicit 30x or application/json found; defaulted to json — read the file if this route matters to a specific test.' };
  }
  if (redirectSignals > jsonSignals) {
    return { kind: 'redirect', note: `heuristic: ${redirectSignals} redirect-shaped response(s) outnumber ${jsonSignals} JSON-shaped one(s) in this file.` };
  }
  return { kind: 'json', note: `heuristic: ${jsonSignals} JSON-shaped response(s) outnumber ${redirectSignals} redirect-shaped one(s) in this file.` };
}

/* ------------------------------------------------------- dynamic segments */

function dynamicSegments(route) {
  return [...route.matchAll(/\[(\.\.\.)?([^\]]+)\]/g)].map((m) => (m[1] ? `...${m[2]}` : m[2]));
}

/**
 * One concrete example per job-shaped dynamic route, read from
 * src/data/jobs.json — the one dataset this script can borrow from safely,
 * because /role/[slug] and its two twins build a page for EVERY job in that
 * file (src/pages/role/[slug].astro: "Every record gets a page, closed
 * included"), so any slug in the file is guaranteed to resolve. A slug whose
 * job is still live (status !== 'closed') is preferred, so the example is
 * the ordinary case, not the closed-record layout, unless every job on file
 * is closed.
 *
 * Every OTHER dynamic route in this app is backed by Postgres, not this
 * file (board/[slug] reads job-store.ts, desk/draft/[id] and
 * desk/job-draft/[slug] read a signed-in member's own rows, u/[handle]
 * reads a claimed handle, kills/[slug]/card is 0 paths while kill_list is
 * off) — inventing an id for any of those would 404 the moment the sweep
 * visited it, which is exactly what item 2 of this script's brief forbids.
 * They are marked `needsParam: true` with no example and a note instead.
 */
function loadJobsSlugs() {
  const path = join(REPO, 'src', 'data', 'jobs.json');
  if (!existsSync(path)) return { slugs: [], liveSlug: null, count: 0 };
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { slugs: [], liveSlug: null, count: 0 };
  }
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const slugs = jobs.map((j) => j.slug).filter(Boolean);
  const live = jobs.find((j) => j.status !== 'closed');
  return { slugs, liveSlug: live ? live.slug : slugs[0] ?? null, count: jobs.length };
}

const JOBS = loadJobsSlugs();

const JOB_BACKED_ROUTES = new Set(['role/[slug]', 'role/[slug].md', 'role/[slug].og.svg']);

function exampleFor(routeKeyNoExt, route) {
  if (JOB_BACKED_ROUTES.has(routeKeyNoExt)) {
    if (!JOBS.liveSlug) {
      return { example: null, note: 'src/data/jobs.json has no jobs to borrow a slug from — cannot safely invent one.' };
    }
    return {
      example: route.replace(/\[slug\]/, JOBS.liveSlug),
      note: `slug read from src/data/jobs.json (${JOBS.count} jobs on file); this one's status is not "closed".`
    };
  }
  if (routeKeyNoExt.startsWith('kills/[slug]/card')) {
    return {
      example: null,
      note: 'kill_list is off in the design edition (flags.config.mjs), so getStaticPaths() builds zero cards; any slug here would 404. Re-check once the flag lights up.'
    };
  }
  if (routeKeyNoExt === 'board/[slug]') {
    return {
      example: null,
      note: "reads job-store.ts (Postgres, the nightly-crawled board), not jobs.json — a slug from jobs.json is not guaranteed to be a tracked row. Needs a live DATABASE_URL to pick a real one; not invented here."
    };
  }
  if (routeKeyNoExt === 'u/[handle]') {
    return { example: null, note: 'reads a claimed handle from Postgres; no handle is guaranteed to exist on a fresh database.' };
  }
  if (routeKeyNoExt === 'drafts/[slug]') {
    return { example: null, note: "a signed-in member's own outbound draft, from Postgres; not resolvable without a seeded account." };
  }
  if (routeKeyNoExt.startsWith('desk/draft/[id]') || routeKeyNoExt.startsWith('desk/job-draft/[slug]')) {
    return { example: null, note: "a signed-in member's own drafting row, from Postgres; not resolvable without a seeded account." };
  }
  return { example: null, note: 'dynamic segment with no cheap, safe source for a real value; see this route in the manifest for the specific reason.' };
}

/* ------------------------------------------------------------- flag darkness
 *
 * flags.config.mjs is plain ESM with no Astro-only imports, so it is
 * imported directly — the real registry, not a copy of it.
 */
const { flagForRoute, isOn, FLAGS } = await import(join(REPO, 'flags.config.mjs'));

function darknessOf(route) {
  const flag = flagForRoute(route);
  if (flag === null) return null;
  const lit = isOn(flag, EDITION);
  if (lit) return null;
  return { flag, edition: EDITION, why: FLAGS[flag]?.why ?? null };
}

/* --------------------------------------------------- session-aware routes
 *
 * Read as text from src/middleware.ts rather than imported: the file's
 * first line of code is `import { defineMiddleware } from 'astro:middleware'`,
 * a virtual module that only resolves inside Astro's own build, so this
 * script cannot execute it the way it executes entitlement.ts below.
 */
function readSessionAware() {
  const src = readFileSync(join(REPO, 'src', 'middleware.ts'), 'utf8');
  const m = src.match(/const SESSION_AWARE\s*=\s*\[([^\]]*)\]/);
  if (!m) {
    abort(
      'src/middleware.ts no longer declares a SESSION_AWARE array in the shape this script expects.',
      'Either middleware.ts changed its own convention (update the regex in scripts/route-census.mjs) or something is badly wrong with the checkout.'
    );
  }
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

const SESSION_AWARE = readSessionAware();

function isSessionAware(route) {
  return SESSION_AWARE.some((p) => route === p || route.startsWith(`${p}/`));
}

/**
 * Read, not imported. src/lib/draft-run-token.ts is plain TypeScript (no
 * Astro-only globals), but it imports './keychain' with no extension — a
 * pattern Astro's own bundler resolves and plain Node's ESM loader does not,
 * even with --experimental-strip-types. Rather than teach this script a
 * resolver, the one regex it actually needs (isDraftRunPath's predicate) is
 * extracted from the source text, the same way SESSION_AWARE is above.
 */
function readDraftRunPathRegex() {
  const src = readFileSync(join(REPO, 'src', 'lib', 'draft-run-token.ts'), 'utf8');
  // Greedy: the regex literal itself contains unescaped '/' inside its own
  // character class ([^/]), so this deliberately matches up to the LAST
  // '/' before '.test(pathname)' on the line, not the first one after it.
  const m = src.match(/export function isDraftRunPath\([^)]*\)[^{]*\{\s*return\s+\/(.*)\/\.test\(pathname\)/);
  if (!m) {
    abort(
      'src/lib/draft-run-token.ts no longer declares isDraftRunPath() in the shape this script expects.',
      'Update readDraftRunPathRegex() in scripts/route-census.mjs, or the machine-token gate for the draft-run leaf will be silently wrong.'
    );
  }
  return `/${m[1]}/`;
}

const DRAFT_RUN_PATH_REGEX = readDraftRunPathRegex();

/* --------------------------------------------------------- entitlement.ts
 *
 * IMPORTED AND EXECUTED — not re-typed — via a child Node process started
 * with --experimental-strip-types, because entitlement.ts is real
 * TypeScript (interfaces, `as` casts) and this script runs as plain .mjs.
 * If this fails, the census cannot know who may load what, which is most of
 * its job, so it exits 2 rather than guessing.
 */
function runEntitlement(routes) {
  const script = `
    import { decide, GATED_PREFIXES, ROUTE_POLICY, isGated } from ${JSON.stringify('./src/lib/entitlement.ts')};
    const isDraftRunPath = (pathname) => ${DRAFT_RUN_PATH_REGEX}.test(pathname);
    const routes = ${JSON.stringify(routes)};
    const viewers = {
      'signed-out': null,
      waitlisted: { userId: 'x', tier: 'waitlisted', emailVerified: true },
      member: { userId: 'x', tier: 'member', emailVerified: true },
      paid: { userId: 'x', tier: 'paid', emailVerified: true },
      internal: { userId: 'x', tier: 'internal', emailVerified: true }
    };
    const perRoute = {};
    for (const route of routes) {
      perRoute[route] = {
        gated: isGated(route),
        draftRunToken: isDraftRunPath(route),
        decisions: Object.fromEntries(
          Object.entries(viewers).map(([name, v]) => [name, decide(route, v)])
        )
      };
    }
    console.log(JSON.stringify({ GATED_PREFIXES, ROUTE_POLICY, perRoute }));
  `;
  let raw;
  try {
    raw = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-'], {
      cwd: REPO,
      input: script,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    abort(
      'could not import src/lib/entitlement.ts to read the real access policy.',
      `This needs Node's --experimental-strip-types (Node >=22.6; this repo targets Node 24). ` +
        `Node reported: ${(error.stderr || error.message || '').toString().trim().split('\n').slice(0, 4).join(' / ')}`
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    abort('entitlement.ts ran but did not print the JSON this script expected.', 'Run the same command by hand to see what it actually printed.');
  }
}

/* ---------------------------------------------------------- nightly sweep
 *
 * HAND-VERIFIED, not import-sniffed: each route below was checked by
 * reading its own import list against src/data/*.json's own headers ("101
 * records: 80 verified live... written by export-site-data.py on the
 * machine" / "Sweep totals for 2026-09-22T07:30:03Z, written by
 * export-site-data.py") and against job-store.ts's header ("the mini's
 * tracker is the only writer in production"). The task's own list named six
 * of these as "at least"; reading every page's imports found thirteen more
 * that are exactly the same shape — a route whose main content is rewritten
 * on a schedule this repo does not control, which is Rule 1 of
 * docs/regression-strategy.md §3.1: never photograph content you do not
 * author.
 *
 * WHY A CURATED LIST RATHER THAN AN AUTOMATED IMPORT SCAN. lib/data.ts and
 * lib/stats.ts each export BOTH sweep-derived reads (loadJobs, loadStats)
 * AND plain formatting helpers (formatDate, dayStamp) from the same module,
 * so a module-level "imports lib/data → nightly" rule over-fires (it would
 * tag /the-account, which imports only dayStamp for a date on the price
 * page) and a full named-export allowlist across every mixed-purpose module
 * is more machinery than this file's job justifies. So: read once, listed
 * once, and checked below by a lightweight drift DETECTOR (not a second
 * source of truth) that warns, but does not fail the build, when a route
 * outside this list imports one of the unambiguous sweep-only modules —
 * because a new route added to job-store.ts or jobs-data-page.ts tomorrow
 * should be noticed, even though this script cannot prove it belongs here
 * without a human reading it the way this list was read.
 */
const NIGHTLY_SWEEP_ROUTES = new Set([
  '/', // home embeds a live board teaser + age histogram (job-store.ts) and swept stats (lib/stats.ts)
  '/board',
  '/board/[slug]',
  '/board/kills.json',
  '/board/stats.json',
  '/jobs-data',
  '/jobs-data/summary',
  '/desk', // desk-home.ts is built on job-store.ts
  '/opportunities', // reads loadJobs()/killArchive() from lib/data.ts
  '/kills',
  '/kills/[slug]/card',
  '/kills/[slug]/card.og.svg',
  '/role/[slug]',
  '/role/[slug].md',
  '/role/[slug].og.svg',
  '/prelist',
  '/drop',
  '/data',
  '/evidence'
]);

// Modules that are UNAMBIGUOUSLY sweep-only end to end (every export in them
// reads or transforms the nightly data, nothing generic lives beside it).
// lib/data.ts and lib/stats.ts are deliberately excluded from this list —
// see the header above.
const SWEEP_ONLY_MODULE_HINTS = [
  "from '../lib/job-store'",
  "from '../../lib/job-store'",
  "from '../lib/jobs-data-page'",
  "from '../../lib/jobs-data-page'",
  "from '../lib/jobs-data-cache'",
  "from '../../lib/jobs-data-cache'",
  "from '../lib/desk-home'",
  "from '../../lib/desk-home'",
  "from '../lib/prospect-board'",
  "from '../../lib/prospect-board'",
  "from '../components/drop/window'",
  "from './window'"
];

function sweepDriftWarning(route, source) {
  const flagged = NIGHTLY_SWEEP_ROUTES.has(route);
  const looksSwept = SWEEP_ONLY_MODULE_HINTS.some((hint) => source.includes(hint));
  if (looksSwept && !flagged) {
    return `imports a sweep-only module but is not in NIGHTLY_SWEEP_ROUTES — read it and add it if its main content is nightly data, not this script's own judgement.`;
  }
  return null;
}

/* ---------------------------------------------------------------- gate
 *
 * public / session / tier / internal / machine-token, in that priority:
 * a machine-token route answers a bearer secret before any session exists,
 * so it outranks everything; a flag-dark route is noted separately (it 404s
 * for every audience regardless of gate, decided even before the machine
 * check in middleware's real order — see src/middleware.ts's own top-to-
 * bottom comments) rather than folded into one of these five, because "dark"
 * is not an audience distinction, it is an availability one.
 */
function gateFor(route, entitlementInfo) {
  if (route.startsWith('/machine/')) {
    return { gate: 'machine-token', requiredTier: null, note: 'Bearer MACHINE_FETCH_SECRET, checked in the handler itself (src/lib/machine-secret.ts). Not in entitlement.ts at all.' };
  }
  if (entitlementInfo.draftRunToken) {
    return {
      gate: 'machine-token',
      requiredTier: null,
      note: 'HMAC-signed one-minute token (src/lib/draft-run-token.ts, DRAFT_RUN_SECRET), verified in the handler. Exempted from the session/entitlement gate in src/middleware.ts before ROUTE_POLICY is ever consulted.'
    };
  }
  if (route.startsWith('/auth/')) {
    return { gate: 'public', requiredTier: null, note: "src/middleware.ts returns next() for every /auth/* request before any viewer is resolved — Better Auth answers its own routes." };
  }
  if (entitlementInfo.gated) {
    const internalDecision = entitlementInfo.decisions.internal;
    const required = internalDecision.required;
    if (required === 'internal') return { gate: 'internal', requiredTier: 'internal', note: null };
    return { gate: 'tier', requiredTier: required, note: null };
  }
  if (route === '/board/[slug]') {
    return {
      gate: 'public',
      requiredTier: null,
      note: 'Public for every crawled slug. The one exception is the shape "added-<applicationId>" (src/lib/added-posting.ts), which src/middleware.ts resolves a viewer for and answers owner-or-404 — a signed-out reader, a signed-in stranger, and a slug nobody owns all get the identical 404, so entitlement.ts is never consulted for that shape.'
    };
  }
  if (isSessionAware(route)) {
    return { gate: 'session', requiredTier: null, note: 'src/middleware.ts resolves a viewer for this exact path (SESSION_AWARE) even though it is not gated; the page decides what to show.' };
  }
  return { gate: 'public', requiredTier: null, note: null };
}

/* ------------------------------------------------------------- assemble */

const routeEntries = routeFiles.map((abs) => {
  const relFile = relative(REPO, abs).split('\\').join('/');
  const relFromPages = relative(PAGES_DIR, abs).split('\\').join('/');
  const route = fileToRoute(relFromPages);
  const source = readFileSync(abs, 'utf8');
  return {
    file: relFile,
    route,
    source, // dropped before writing; used only to build the fields below
    prerender: !isPrerenderFalse(source),
    dynamicSegments: dynamicSegments(route)
  };
});

const routePatterns = routeEntries.map((e) => e.route);
const entitlement = runEntitlement(routePatterns);

const manifestRoutes = routeEntries.map((entry) => {
  const { kind, note: outputKindNote } = outputKindFor(join(REPO, entry.file), entry.file.slice('src/pages/'.length));
  const dark = darknessOf(entry.route);
  const routeKeyNoExt = entry.file.slice('src/pages/'.length).replace(/\.(astro|ts)$/, '');
  const { example, note: exampleNote } = entry.dynamicSegments.length > 0 ? exampleFor(routeKeyNoExt, entry.route) : { example: null, note: null };
  const info = entitlement.perRoute[entry.route];
  const { gate, requiredTier, note: gateNote } = gateFor(entry.route, info);
  const nightlySweep = NIGHTLY_SWEEP_ROUTES.has(entry.route);
  const sweepWarning = sweepDriftWarning(entry.route, entry.source);

  return {
    file: entry.file,
    route: entry.route,
    prerender: entry.prerender,
    outputKind: kind,
    outputKindNote,
    dynamic: entry.dynamicSegments.length > 0,
    dynamicSegments: entry.dynamicSegments,
    exampleParamPath: example,
    exampleParamNote: exampleNote,
    dark: dark ? { flag: dark.flag, edition: dark.edition, why: dark.why } : null,
    gate,
    requiredTier,
    gateNote,
    nightlySweep,
    sweepDriftWarning: sweepWarning,
    // Full per-audience allow/deny is useful to the sweep for choosing what
    // status to expect; kept even for machine-token/dark routes with a note
    // that entitlement.ts's opinion is not the real answer for them.
    audienceDecisions: info.decisions
  };
});

/* --------------------------------------------------------------- matrix */

const darkRoutes = manifestRoutes.filter((r) => r.dark);
const litRoutes = manifestRoutes.filter((r) => !r.dark);

const AUDIENCES = ['signed-out', 'waitlisted', 'member', 'paid', 'internal'];
const audienceMatrix = {};
for (const audience of AUDIENCES) {
  let allow = 0;
  let deny = 0;
  for (const r of litRoutes) {
    if (r.audienceDecisions[audience].allow) allow++;
    else deny++;
  }
  audienceMatrix[audience] = { allow, deny, of: litRoutes.length };
}

/* ---------------------------------------------------------------- write */

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const manifest = {
  generatedAt: new Date().toISOString(),
  generatedBy: 'scripts/route-census.mjs',
  edition: EDITION,
  // The real values this run read out of src/lib/entitlement.ts, so a reader
  // of the manifest can cross-check a route's `gate`/`requiredTier` against
  // the policy that produced it without opening the TypeScript source.
  gatedPrefixes: entitlement.GATED_PREFIXES,
  routePolicy: entitlement.ROUTE_POLICY,
  totals: {
    routeFiles: manifestRoutes.length,
    prerendered: manifestRoutes.filter((r) => r.prerender).length,
    ssr: manifestRoutes.filter((r) => !r.prerender).length,
    dynamic: manifestRoutes.filter((r) => r.dynamic).length,
    dark: darkRoutes.length,
    lit: litRoutes.length,
    nightlySweep: manifestRoutes.filter((r) => r.nightlySweep).length
  },
  audienceMatrixNote:
    'Computed over the ' +
    litRoutes.length +
    ' lit (non-dark) routes only, via the real src/lib/entitlement.ts decide(). Dark routes are excluded because ' +
    'their flag decides a flat 404 before entitlement.ts ever runs (src/middleware.ts), for every audience, so they are not a ' +
    "tier question. Machine-token routes (2 under /machine, 1 draft-run leaf) ARE counted here as entitlement.ts sees them — " +
    '"allowed", because they carry no ROUTE_POLICY entry — which is true of entitlement.ts and false of the real HTTP response: ' +
    'without the bearer secret or HMAC token they answer 401/503/expired, regardless of session. See each such route\'s own `gate` field.',
  audienceMatrix,
  darkRoutes: darkRoutes.map((r) => ({ route: r.route, flag: r.dark.flag })),
  nightlySweepRoutes: manifestRoutes.filter((r) => r.nightlySweep).map((r) => r.route),
  routes: manifestRoutes
};

writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + '\n');

/* ------------------------------------------------------------ assertions
 *
 * Each one is independent and each one names the file, the rule and the fix,
 * because the person reading a failure here is a product designer, not
 * somebody who wants a stack trace.
 */

// 1. Non-empty.
if (manifestRoutes.length === 0) {
  fail(relative(REPO, OUT_FILE), null, 'the manifest has zero routes.', 'src/pages/ was walked and found nothing — check PAGES_DIR in this script and that the repo checkout is not empty.');
}

// 2. Every entry resolves to a file that exists.
for (const r of manifestRoutes) {
  if (!existsSync(join(REPO, r.file)) || !statSync(join(REPO, r.file)).isFile()) {
    fail(r.file, null, `manifest entry for ${r.route} points at a file that does not exist.`, 'This is an internal bug in route-census.mjs\'s own path handling, not an app problem — the file list and the manifest disagreed.');
  }
}

// 3. No two entries claim the same path.
{
  const seen = new Map();
  for (const r of manifestRoutes) {
    if (seen.has(r.route)) {
      fail(r.file, null, `route ${r.route} is also claimed by ${seen.get(r.route)}.`, 'Two files cannot serve the same URL. Rename or remove one of the two source files.');
    } else {
      seen.set(r.route, r.file);
    }
  }
}

// 4. Every prerender=false route is genuinely reachable through the adapter:
//    the Vercel adapter has to be configured, and nothing may force static
//    output globally, which would make Astro ignore every per-page
//    `prerender = false` and silently serve a build-time snapshot instead.
{
  const ssrCount = manifestRoutes.filter((r) => !r.prerender).length;
  if (ssrCount > 0) {
    const configPath = join(REPO, 'astro.config.mjs');
    if (!existsSync(configPath)) {
      fail('astro.config.mjs', null, 'no astro.config.mjs found, but this app declares SSR routes.', 'Restore astro.config.mjs, or this script is being run against the wrong directory.');
    } else {
      const config = readFileSync(configPath, 'utf8');
      if (!/adapter:\s*vercel\s*\(/.test(config)) {
        fail(
          'astro.config.mjs',
          null,
          `${ssrCount} route(s) declare \`export const prerender = false\`, but astro.config.mjs does not configure the Vercel adapter.`,
          'Add `adapter: vercel(...)` back to defineConfig(), or every SSR route in this manifest silently 404s (or fails the build) in production.'
        );
      }
      if (/output\s*:\s*['"]static['"]/.test(config)) {
        fail(
          'astro.config.mjs',
          null,
          `\`output: 'static'\` is set, which makes Astro ignore every file's own \`prerender = false\` and build the whole site static.`,
          `Remove the explicit \`output\` setting. ${ssrCount} routes in this manifest depend on per-page prerender working.`
        );
      }
    }
  }
}

// 5. The count is within a sane band of the file count — recomputed FRESH,
//    independent of the code path above, so a bug in this script's own
//    bookkeeping cannot pass by agreeing with itself.
{
  const freshCount = listRouteFiles().length;
  if (manifestRoutes.length !== freshCount) {
    fail(
      relative(REPO, OUT_FILE),
      null,
      `the manifest has ${manifestRoutes.length} routes but a fresh walk of src/pages/ just now found ${freshCount}.`,
      'This script dropped or duplicated a file between listing and writing. Re-run with a clean checkout; if it recurs, the bug is in scripts/route-census.mjs, not the app.'
    );
  }
  const KNOWN_GOOD = 91; // measured 2026-09-23, at commit cfd7277's descendant on safety-net
  const drift = Math.abs(freshCount - KNOWN_GOOD) / KNOWN_GOOD;
  if (drift > 0.25) {
    console.log(
      `\n${NAME}: NOTE — src/pages/ now has ${freshCount} route files, last measured at ${KNOWN_GOOD}. ` +
        `That is a ${Math.round(drift * 100)}% swing. Not a failure (the app is meant to grow), but worth a glance: ` +
        `a manifest that silently SHRANK is the exact failure mode this script exists to catch.\n`
    );
  }
}

// 6. Print the sweep-drift warnings (informational — see the note above
//    NIGHTLY_SWEEP_ROUTES for why this is a warning, not an assertion).
{
  const warnings = manifestRoutes.filter((r) => r.sweepDriftWarning);
  if (warnings.length > 0) {
    console.log(`\n${NAME}: NOTE — ${warnings.length} route(s) look sweep-fed but are not in NIGHTLY_SWEEP_ROUTES:`);
    for (const r of warnings) console.log(`  ${r.route.padEnd(28)} ${r.sweepDriftWarning}`);
    console.log('');
  }
}

/* ------------------------------------------------------------- .gitignore
 *
 * Reported, never edited — the task this script was written for is explicit
 * that .gitignore is not this script's file to change.
 */
{
  const gitignorePath = join(REPO, '.gitignore');
  const already = existsSync(gitignorePath) && /(^|\n)\.sweep\/?(\n|$)/.test(readFileSync(gitignorePath, 'utf8'));
  console.log(
    already
      ? `${NAME}: .gitignore already ignores .sweep/ — nothing to add.`
      : `${NAME}: .gitignore does NOT ignore .sweep/ yet. Add a \`.sweep/\` line yourself; this script will not edit it.`
  );
}

/* ----------------------------------------------------------------- report */

console.log(`\n${NAME}`);
console.log(`  manifest      ${relative(REPO, OUT_FILE)}`);
console.log(`  route files   ${manifest.totals.routeFiles} (${manifest.totals.ssr} SSR, ${manifest.totals.prerendered} prerendered)`);
console.log(`  dynamic       ${manifest.totals.dynamic}`);
console.log(`  dark (design) ${manifest.totals.dark}: ${darkRoutes.map((r) => r.route).join(', ')}`);
console.log(`  nightly sweep ${manifest.totals.nightlySweep}: ${manifest.nightlySweepRoutes.join(', ')}`);
console.log(`  audience matrix, over ${litRoutes.length} lit routes:`);
for (const audience of AUDIENCES) {
  const { allow, deny } = audienceMatrix[audience];
  console.log(`    ${audience.padEnd(12)} allow ${allow}  deny ${deny}`);
}

if (failures.length > 0) {
  console.error(`\n${NAME}: FAILED — ${failures.length} assertion(s) did not hold.\n`);
  for (const f of failures) {
    console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}`);
    console.error(`    wrong:  ${f.what}`);
    console.error(`    fix:    ${f.fix}\n`);
  }
  process.exit(1);
}

console.log(`\n${NAME}: PASSED.\n`);
process.exit(0);
