#!/usr/bin/env node
/**
 * PostToolUse hook: after Claude edits a file, tell it which routes that file
 * reaches. Reads the hook JSON on stdin, prints hookSpecificOutput JSON.
 * Silent (exit 0, no output) when the edit touches nothing under src/.
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';

const ROOT = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());

/**
 * Files whose blast radius an import graph cannot see, because nothing imports
 * them in the JavaScript sense. Each one reaches further than any module here.
 *
 * tokens/*.json          style-dictionary compiles these into src/styles/tokens.css
 *                        and themes.css. Every page's colour, spacing and type
 *                        ramp comes from them, and hand-editing the OUTPUT is
 *                        silently reverted by the next `npm run dev`.
 * public/scripts/*.js    1,741 lines of browser code outside the build and
 *                        outside astro check. Coupled to src/pages/jobs-data.astro
 *                        by selector strings only.
 * vercel.json            headers, the CSP, and the `framework` key. The Vercel
 *                        project's own preset is still "Vite" from the old
 *                        landing page, so this file is the only thing making the
 *                        deploy an Astro build.
 * astro.config.mjs       the adapter, prerendering, and the review-route
 *                        injection the pixel gate depends on.
 * src/middleware.ts      the session gate and the origin gate, on every request.
 * flags.config.mjs       which routes exist at all.
 * tiers.config.mjs       who may reach them.
 * db/*.sql               the schema every read asserts rather than checks.
 */
const WIDE = [
  ['tokens/', 'every compiled token, so every page. Hand-edits to src/styles/tokens.css or themes.css are BUILD OUTPUT and are reverted by the next `npm run dev` — change the JSON here instead.'],
  ['public/scripts/', 'browser code outside the build and outside astro check, coupled to the markup of src/pages/jobs-data.astro by selector strings alone. Nothing type-checks this.'],
  ['vercel.json', 'the security headers, the CSP, and the `framework` key. The Vercel project preset is still "Vite"; this file is the only thing making the deploy an Astro build.'],
  ['astro.config.mjs', 'the adapter, prerendering, and the /_specimen and /_states injection the pixel gate reads.'],
  ['src/middleware.ts', 'the session gate and the origin gate — every request on the site.'],
  ['flags.config.mjs', 'which routes exist at all.'],
  ['tiers.config.mjs', 'who may reach which route.'],
  ['db/', 'the schema. 81 database reads in src/lib assert their row shape rather than checking it, so a column change here surfaces as a runtime error in a page, not as a type error.']
];
const SRC = join(ROOT, 'src');
const PAGES = join(SRC, 'pages') + '/';
const EXTS = ['.ts', '.tsx', '.mjs', '.js', '.astro', '.json'];
const CODE = ['.astro', '.ts', '.tsx', '.mjs', '.js'];

let input = '';
try { input = readFileSync(0, 'utf8'); } catch { process.exit(0); }
let hook; try { hook = JSON.parse(input); } catch { process.exit(0); }

const touched = [];
const ti = hook.tool_input || {};
for (const p of [ti.file_path, ...(Array.isArray(ti.edits) ? ti.edits.map(e => e.file_path) : [])]) {
  if (typeof p === 'string' && p) touched.push(resolve(p));
}

// --from-git: the same report for a file this hook was not told about.
//
// A PostToolUse matcher on Edit|Write only fires for those tools. A `sed -i`, a
// heredoc, a `git checkout -- file`, a script run from Bash — all change the tree
// and none of them carry a file_path this hook can read. Those are exactly the
// edits most likely to be careless, so the settings entry registers this hook a
// second time with no matcher and this flag, and it discovers the change from the
// working tree instead of from the tool call.
if (process.argv.includes('--from-git')) {
  // The matched Edit|Write entry already reported this edit. Saying it twice is
  // noise, and noise in a hook that fires after every tool call is how the hook
  // stops being read.
  if (touched.length > 0) process.exit(0);

  const { execFileSync } = await import('node:child_process');
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--no-renames'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5000
    });
    for (const line of out.split('\n')) {
      // Porcelain v1: two status characters, a space, then the path.
      const path = line.slice(3).trim();
      if (!path) continue;
      const abs = resolve(ROOT, path);
      if (existsSync(abs) && statSync(abs).isFile()) touched.push(abs);
    }
  } catch {
    // Not a git repository, or git is unavailable. Nothing to report; never a
    // reason to interrupt the edit.
    process.exit(0);
  }
  // A dirty tree is the normal state mid-task, so cap the noise: report only when
  // the change set is small enough to be about one thing.
  if (touched.length === 0 || touched.length > 12) process.exit(0);
}
/** The marker the Stop gate reads: "src/ was edited at this time". Written for
 *  any touched file the gate should care about, before the graph walk, so an
 *  edit still counts even if this hook finds nothing to say about it. */
function markEdited() {
  try {
    mkdirSync(join(ROOT, '.claude'), { recursive: true });
    writeFileSync(join(ROOT, '.claude', '.last-edit'), String(Date.now()));
  } catch {
    /* A hook that cannot write its marker must not block the edit. The Stop gate
       treats a missing marker as "nothing was edited", which fails open — noted
       here because that is a deliberate choice, not an oversight. */
  }
}

const relTouched = touched.map(p => relative(ROOT, p));

// The files no import graph can account for. Reported first, because they are
// the ones where "I only changed one thing" is least likely to be true.
const wideHits = WIDE.flatMap(([prefix, why]) =>
  relTouched.filter(p => p === prefix || p.startsWith(prefix)).map(p => `${p} — ${why}`)
);

const inSrc = touched.filter(p => p.startsWith(SRC + '/') && CODE.includes(extname(p)));

if (inSrc.length === 0 && wideHits.length === 0) process.exit(0);
markEdited();

if (inSrc.length === 0) {
  // Outside src/, so there is no module graph to walk — but there is something
  // worth saying.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: ['This edit reaches further than an import graph shows:', ...wideHits].join('\n')
    }
  }) + '\n');
  process.exit(0);
}
if (!existsSync(SRC)) process.exit(0);

function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (CODE.includes(extname(p))) out.push(p);
  }
  return out;
}
function resolveSpec(from, spec) {
  if (!spec.startsWith('.')) return null;
  const b = resolve(dirname(from), spec);
  if (existsSync(b) && statSync(b).isFile()) return b;
  for (const e of EXTS) if (existsSync(b + e)) return b + e;
  for (const e of EXTS) { const i = join(b, 'index' + e); if (existsSync(i)) return i; }
  return null;
}
const RE = /(?:from|import)\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const reverse = new Map();
for (const f of walk(SRC)) {
  let s; try { s = readFileSync(f, 'utf8'); } catch { continue; }
  let m; RE.lastIndex = 0;
  while ((m = RE.exec(s))) {
    const dep = resolveSpec(f, m[1] || m[2]);
    if (!dep) continue;
    if (!reverse.has(dep)) reverse.set(dep, new Set());
    reverse.get(dep).add(f);
  }
}
const seen = new Set(), pages = new Set(), tests = new Set();
const q = [...inSrc];
while (q.length) {
  const f = q.shift();
  if (seen.has(f)) continue;
  seen.add(f);
  if (f.startsWith(PAGES)) pages.add(f);
  if (/\.test\.(ts|mjs)$/.test(f)) tests.add(f);
  for (const imp of reverse.get(f) || []) if (!seen.has(imp)) q.push(imp);
}
const rel = s => [...s].map(f => relative(ROOT, f)).sort();
const changed = rel(new Set(inSrc));
const routes = rel(pages), specs = rel(tests);
if (routes.length === 0 && specs.length === 0) process.exit(0);

/** Whether a green sweep has run since the last edit.
 *
 *  This lives HERE, in a PostToolUse hook, and not only in the Stop gate, because
 *  of a documented limitation: a Stop hook's block reason does NOT reach the model
 *  as something it will act on — it prevents the turn ending and nothing more. A
 *  PostToolUse hook's additionalContext does reach the model. So the Stop gate is
 *  the backstop and this line is the actual reminder. */
function sweepState() {
  const receipt = join(ROOT, '.claude', '.sweep-receipt.json');
  if (!existsSync(receipt)) return 'No sweep has run in this working tree yet. `npm run conform` before calling this done.';
  try {
    const r = JSON.parse(readFileSync(receipt, 'utf8'));
    if (r.green !== true) return 'The last `npm run conform` finished RED. Fix that before adding to it.';
    if (r.at <= Date.now() - 1) return 'The last `npm run conform` predates this edit. Re-run it before calling this done.';
    return null;
  } catch {
    return 'The sweep receipt at .claude/.sweep-receipt.json is unreadable. Run `npm run conform`.';
  }
}

const sweep = sweepState();

const lines = [
  `Blast radius of ${changed.join(', ')}:`,
  routes.length
    ? `Routes that import it (${routes.length}): ${routes.join(', ')}`
    : 'No route under src/pages imports it.',
  specs.length
    ? `Existing tests covering that subtree (${specs.length}): ${specs.join(', ')}`
    : 'No existing test covers this subtree. A change here is currently unobserved.',
  ...wideHits.length ? ['It also reaches further than the import graph shows:', ...wideHits] : [],
  ...sweep ? [sweep] : []
];
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: lines.join('\n')
  }
}) + '\n');
