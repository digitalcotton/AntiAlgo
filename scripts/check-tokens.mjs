#!/usr/bin/env node
/**
 * check-tokens.mjs: the design-token resolution gate.
 *
 *   node scripts/check-tokens.mjs
 *
 * WHY THIS EXISTS. docs/regression-strategy.md section 1.2 names CSS ownership,
 * not duplication, as the number-one mechanism behind "I change one page and
 * something else breaks, or changes back." Three concrete failure modes sit
 * inside that one sentence, and this script is the machine check for each:
 *
 *   1. A var(--x) that resolves nowhere renders as nothing, silently. No error,
 *      no red page, just a layout that is quietly wrong. An adversarial pass
 *      already found four of these: --space-150 in three files and --space-050
 *      in a fourth, against a ramp (--space-100..--space-1000) that has never
 *      had a 050 or a 150 step. They read as a typo for the two neighbouring
 *      real steps, and nothing in the toolchain (astro check, the build, the
 *      browser) says so. This script does.
 *   2. Five marketing pages each carry a private alias vocabulary (--fs-h1,
 *      --sp-1..--sp-8, --ink, --muted, --line, --signal, and more) instead of
 *      reading tokens.css directly. That is "a second, undeclared token
 *      system," in the strategy doc's words, and a second system drifts from
 *      the first the moment someone edits only one of its five copies: --fs-h1
 *      is already clamp(38px, 4.8vw, 58px) in four of the five pages and
 *      clamp(34px, 4.4vw, 50px) in the fifth. Nobody decided that on purpose;
 *      it just drifted, silently, the same way the .cta specificity bug in the
 *      same section did. This is a WARN, not a FAIL: a page-local variable is
 *      sometimes the right call (see check 3's own note on themes.css and the
 *      print overrides this script finds), and only the person who owns the
 *      canvas can say which of these are deliberate and which are drift.
 *   3. src/styles/tokens.css and src/styles/themes.css are BUILD OUTPUT, not
 *      source. `npm run dev` and `npm run build` both run `npm run tokens`
 *      first, which is `style-dictionary build`, and it overwrites both files
 *      from tokens/*.json every time. Section 1.2's exact line: "If you have
 *      ever fixed a colour and watched it come back, this is why." A hand-edit
 *      to either file is not wrong today and wrong forever after the next dev
 *      server restart, which is a worse bug than a hand-edit that stays wrong,
 *      because it teaches whoever finds it that the fix "didn't take" for no
 *      visible reason.
 *
 * HOW CHECK 3 DETECTS A HAND-EDIT, HONESTLY. Neither file carries a content
 * hash or a diff-able marker beyond the "Do not edit directly" comment already
 * in their header (and a hand-edit could leave that comment in place and edit
 * the rules below it anyway, so the comment alone proves nothing). What this
 * script does instead is the only honest test available without a new
 * dependency: it rebuilds both files with the same style-dictionary config
 * this repo already runs (tokens/*.json through style-dictionary.config.js),
 * writes the rebuild to a throwaway temp directory, and compares it byte for
 * byte against what is committed at src/styles/tokens.css and themes.css. A
 * mismatch means the committed file is not what the pipeline would produce
 * today, from whatever source: a hand-edit, a stale build after a token JSON
 * change, or a merge that touched the compiled file directly. This never
 * writes to src/styles/*.css itself; the rebuild lands in os.tmpdir() and is
 * deleted before this script exits.
 *
 * WHAT ELSE THIS SCRIPT REPORTS, WITHOUT FAILING ON IT. Hardcoded hex colours
 * and px lengths outside the token system are a real backlog, not a gate: a px
 * value is legitimate in a media query (a custom property cannot be read
 * there), a raster spec, or an off-screen offset, the same three exceptions
 * ingest-on-build.mjs's sibling script in the Index names for the same reason.
 * Sorting every literal into "mechanism" and "should be a token" needs a human
 * looking at each one, so this script only counts and points at the worst
 * files, the same way `git log --stat` points at a diff without reviewing it.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO.
 *   - It does not fix anything it finds. Every failure and warning below names
 *     a file and a line and leaves the edit to the person who owns the page.
 *   - It does not parse CSS with a real parser. Like the Index's
 *     check-token-usage.mjs, it is regex-based: a var(--x) or a --x: value;
 *     declaration is found as text, not as a node in a CSS AST. This can be
 *     fooled by pathological input (a var(--x) sitting inside a JS string
 *     literal that is not a style attribute, for instance), and it strips
 *     /* ... *\/ comments before scanning specifically so that a token name
 *     mentioned in prose, like this one, is never mistaken for a use of it.
 *   - It does not check the specimen. The Index's version of this script has a
 *     third mode, --specimen, that reads a built /_specimen page and asserts
 *     every compiled token is documented on it. This repo's src/review/
 *     surfaces are not wired into the build yet (regression-strategy.md
 *     section 5, "Layer 5"), so there is no specimen tree to read. Wiring that
 *     up is its own step; this script does not invent a specimen check against
 *     a page that cannot be built.
 *   - It does not touch anything under src/. It only ever opens files there
 *     for reading, and check 3's rebuild is written to a temp directory that
 *     is deleted before exit.
 *
 * RATCHETED AGAINST test/conform/accepted.json. Check 1's four known findings
 * (the ones named above, --space-150 x3 and --space-050 x1) are real defects,
 * already shown to the owner, already deferred with an owner_question about
 * which fix changes which layout. Failing the gate on them a second time
 * teaches nobody anything and is exactly how a gate goes red on day one and
 * gets bypassed — see accepted.json's own $comment for the two instruments
 * this project already lost that way. So this script partitions check 1's
 * findings through accepted.mjs: an accepted finding is printed, not fatal; a
 * FIFTH unresolved var() that is not in accepted.json still fails the gate,
 * same as before; and an accepted finding that stops reproducing (fixed, or
 * the file changed enough to move it) fails the gate too, loudly, because
 * accepted.json is still claiming something that is no longer true.
 *
 * Exit codes follow this repo's contract (see test/gates.config.mjs): 0 clean,
 * 1 a real finding (an unresolved var() not covered by the ratchet, a stale
 * ratchet entry, or tokens.css/themes.css out of sync with what
 * style-dictionary would produce), 2 the check could not run at all (a
 * required file is missing, or the rebuild itself throws). A check that could
 * not run has measured nothing, and must never claim a pass.
 */

import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { partition, report } from '../test/conform/accepted.mjs';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const rel = (p) => relative(REPO, p);

const TOKENS_CSS = join(REPO, 'src', 'styles', 'tokens.css');
const THEMES_CSS = join(REPO, 'src', 'styles', 'themes.css');
const GLOBAL_CSS = join(REPO, 'src', 'styles', 'global.css');
const LEDGER_CSS = join(REPO, 'public', 'scripts', 'ledger-v4.css');
const SD_CONFIG = join(REPO, 'style-dictionary.config.js');

console.log('\ncheck-tokens: design-token resolution gate\n');

let cannotRun = false;
function fatal(message) {
  console.error(`check-tokens: ${message}`);
  cannotRun = true;
}

/* ---------------------------------------------------------------------------
   Small helpers shared by every check below.
   --------------------------------------------------------------------------- */

/** Files directly inside `dir` (no recursion) whose name ends in one of `exts`. */
function filesIn(dir, exts) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => exts.includes(extname(name)))
    .map((name) => join(dir, name))
    .filter((full) => statSync(full).isFile());
}

/** Every file under `dir`, any depth, whose name ends in one of `exts`. */
function filesUnder(dir, exts, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) filesUnder(full, exts, out);
    else if (exts.includes(extname(name))) out.push(full);
  }
  return out;
}

/** Blank out /* ... *\/ comments (keeping line breaks) so prose never counts as code. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Every `--name: value;` declaration's bare name, found as text, not parsed as CSS. */
function declaredNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/--([a-z0-9-]+)\s*:\s*[^;]+;/gi)) names.add(m[1]);
  return names;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function readSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
   Check 1 (FAIL): every var(--x) resolves somewhere, or carries a fallback.

   "Resolves" means the name is declared in one of the four shared style files
   the task names, or declared locally in the very file doing the var(--x),
   or the var() call itself supplies a fallback value (a comma inside the
   parens) — CSS's own way of saying "and if that name is unset, use this."
   --------------------------------------------------------------------------- */

const tokensCssText = readSafe(TOKENS_CSS);
const themesCssText = readSafe(THEMES_CSS);
const globalCssText = readSafe(GLOBAL_CSS);
const ledgerCssText = readSafe(LEDGER_CSS);

for (const [label, text] of [
  ['src/styles/tokens.css', tokensCssText],
  ['src/styles/themes.css', themesCssText],
  ['src/styles/global.css', globalCssText],
  ['public/scripts/ledger-v4.css', ledgerCssText],
]) {
  if (text === null) fatal(`${label} is not there. This check reads it as one of the declared sources of truth for design tokens.`);
}

const sharedDeclared = new Set([
  ...declaredNames(stripComments(tokensCssText || '')),
  ...declaredNames(stripComments(themesCssText || '')),
  ...declaredNames(stripComments(globalCssText || '')),
  ...declaredNames(stripComments(ledgerCssText || '')),
]);

const scanTargets = [
  ...filesUnder(join(REPO, 'src'), ['.astro']),
  ...filesIn(join(REPO, 'src', 'styles'), ['.css']),
  ...filesIn(join(REPO, 'public', 'scripts'), ['.css']),
];

const unresolved = [];
for (const file of scanTargets) {
  const raw = readFileSync(file, 'utf8');
  const text = stripComments(raw);
  const localDeclared = declaredNames(text);
  for (const m of text.matchAll(/var\(\s*--([a-z0-9-]+)\s*(,[^)]*)?\)/gi)) {
    const name = m[1];
    const hasFallback = Boolean(m[2]);
    if (hasFallback) continue;
    if (sharedDeclared.has(name) || localDeclared.has(name)) continue;
    const relFile = rel(file);
    const line = lineOf(text, m.index);
    unresolved.push({
      file: relFile,
      line,
      name,
      // Stable id: token:<repo-relative file>:<line>:<custom property name>.
      // This DOES carry a line number, on purpose, unlike accepted.mjs's own
      // preference for line-free ids. A file can reference the same missing
      // token at more than one spot — ProspectCard.astro does, at :176 and
      // :215 — and those are two separate findings, not one, so the line has
      // to be part of the id or they would collide. The trade-off is real: an
      // edit above one of these lines shifts it, and an accepted finding
      // reappears as fresh until the owner moves the line number in
      // accepted.json. That is a deliberate choice, not an oversight.
      id: `token:${relFile}:${line}:--${name}`,
    });
  }
}
unresolved.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

const { fresh: freshUnresolved, accepted: acceptedUnresolved, stale: staleUnresolved } =
  partition('check-tokens', unresolved);

/* ---------------------------------------------------------------------------
   Check 2 (WARN): page-local tokens that shadow or duplicate the shared layer.

   Two different things are worth a person's attention here, and they are not
   the same defect:

   (a) EXACT-NAME SHADOWING. A file other than tokens.css/themes.css declares
       a custom property whose name already exists in one of those two files.
       Inside that file's own scope, the local declaration wins over the
       shared one by ordinary CSS cascade rules — this is the same mechanism
       section 1.2 describes for the .cta button. Sometimes this is
       deliberate and documented (global.css and report.astro both re-declare
       the light-theme color-* names inside a `@media print` block, on
       purpose, so a dark-mode reader still gets ink-on-paper on paper). This
       script cannot tell deliberate from accidental, so it warns and names
       the file, never fails.

   (b) A PRIVATE, REPEATED VOCABULARY. A name that does NOT collide with
       tokens.css/themes.css, but is declared with a literal (not a var())
       value in more than one file — the --fs-h1 / --sp-* / --ink family. That
       is a second token system living beside the real one. When every file
       declaring a given name uses the same value, it is at least consistent
       today; when they differ, it has already drifted, and drift here is
       exactly the kind of thing that renders correctly on the page someone
       is looking at and wrong on the four they are not.
   --------------------------------------------------------------------------- */

const shadowExcluded = new Set([TOKENS_CSS, THEMES_CSS]);
const shadows = [];
for (const file of scanTargets) {
  if (shadowExcluded.has(file)) continue;
  const text = stripComments(readFileSync(file, 'utf8'));
  for (const m of text.matchAll(/--([a-z0-9-]+)\s*:\s*[^;]+;/gi)) {
    const name = m[1];
    const declaredInTokensOrThemes =
      declaredNames(stripComments(tokensCssText || '')).has(name) ||
      declaredNames(stripComments(themesCssText || '')).has(name);
    if (declaredInTokensOrThemes) {
      shadows.push({ file: rel(file), line: lineOf(text, m.index), name });
    }
  }
}
shadows.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

// Private vocabulary: names declared with a literal value, exactly once per
// file, in two or more files that are not tokens.css/themes.css/global.css.
// "Exactly once per file" is what tells apart a truly repeated private token
// from a single component setting one custom property to different values
// for different states (default vs :hover) inside itself, which is normal
// CSS and not drift.
const privateExcluded = new Set([TOKENS_CSS, THEMES_CSS, GLOBAL_CSS]);
const byName = new Map(); // name -> Map(file -> [{line, value}])
for (const file of scanTargets) {
  if (privateExcluded.has(file)) continue;
  const text = stripComments(readFileSync(file, 'utf8'));
  for (const m of text.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const name = m[1];
    const value = m[2].trim();
    if (!byName.has(name)) byName.set(name, new Map());
    const perFile = byName.get(name);
    const f = rel(file);
    if (!perFile.has(f)) perFile.set(f, []);
    perFile.get(f).push({ line: lineOf(text, m.index), value });
  }
}

const privateVocab = []; // { name, occurrences: [{file, line, value}] }
const drifted = []; // same shape, only where values disagree
for (const [name, perFile] of byName) {
  if (perFile.size < 2) continue;
  const comparable = [...perFile.values()].every((occ) => occ.length === 1);
  if (!comparable) continue; // per-state variation inside one file, not drift
  const occurrences = [...perFile.entries()].map(([file, occ]) => ({ file, line: occ[0].line, value: occ[0].value }));
  privateVocab.push({ name, occurrences });
  const values = new Set(occurrences.map((o) => o.value));
  if (values.size > 1) drifted.push({ name, occurrences });
}
privateVocab.sort((a, b) => a.name.localeCompare(b.name));
drifted.sort((a, b) => a.name.localeCompare(b.name));

/* ---------------------------------------------------------------------------
   Check 3 (FAIL): tokens.css and themes.css match what style-dictionary would
   produce right now from tokens/*.json. See the header for why this is the
   only honest way to catch a hand-edit without a new dependency: rebuild to a
   temp directory, then compare byte for byte.
   --------------------------------------------------------------------------- */

let generatedMismatch = null; // null = matches or could not check; array of {file} = mismatch

async function checkGeneratedFilesMatchBuild() {
  if (tokensCssText === null || themesCssText === null) return; // already fatal above
  let baseConfig;
  try {
    ({ default: baseConfig } = await import(pathToFileURL(SD_CONFIG).href));
  } catch (err) {
    fatal(`could not load style-dictionary.config.js to rebuild the tokens for comparison (${err.message}).`);
    return;
  }

  let StyleDictionary;
  try {
    ({ default: StyleDictionary } = await import('style-dictionary'));
  } catch (err) {
    fatal(`could not load the style-dictionary package (${err.message}). It is already a devDependency; run npm install.`);
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), 'check-tokens-'));
  try {
    const rebuildConfig = {
      ...baseConfig,
      log: { verbosity: 'silent', warnings: 'disabled' },
      platforms: {
        ...baseConfig.platforms,
        css: {
          ...baseConfig.platforms.css,
          log: { verbosity: 'silent', warnings: 'disabled' },
          buildPath: `${tmp}/`,
        },
      },
    };

    let sd;
    try {
      sd = new StyleDictionary(rebuildConfig, { verbosity: 'silent' });
      await sd.buildAllPlatforms();
    } catch (err) {
      fatal(`style-dictionary threw while rebuilding tokens.css/themes.css for comparison (${err.message}). That likely means tokens/*.json itself is broken, not that this script found a hand-edit.`);
      return;
    }

    const rebuiltTokens = readSafe(join(tmp, 'tokens.css'));
    const rebuiltThemes = readSafe(join(tmp, 'themes.css'));
    if (rebuiltTokens === null || rebuiltThemes === null) {
      fatal('the style-dictionary rebuild did not produce tokens.css and themes.css where style-dictionary.config.js says it would.');
      return;
    }

    const mismatches = [];
    if (rebuiltTokens !== tokensCssText) mismatches.push('src/styles/tokens.css');
    if (rebuiltThemes !== themesCssText) mismatches.push('src/styles/themes.css');
    generatedMismatch = mismatches;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

await checkGeneratedFilesMatchBuild();

/* ---------------------------------------------------------------------------
   Backlog (report only, never fails): hardcoded hex colours and px lengths
   outside the token system. See the header for why this is a count and a
   pointer, not a gate.
   --------------------------------------------------------------------------- */

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const PX_RE = /(?<![\w-])-?\d+(?:\.\d+)?px\b/g;

const backlogTargets = filesUnder(join(REPO, 'src'), ['.astro', '.css']);
const backlogPerFile = [];
let hexTotal = 0;
let pxTotal = 0;
for (const file of backlogTargets) {
  const text = stripComments(readFileSync(file, 'utf8'));
  const hex = [...text.matchAll(HEX_RE)].length;
  const px = [...text.matchAll(PX_RE)].length;
  if (hex + px > 0) backlogPerFile.push({ file: rel(file), hex, px, total: hex + px });
  hexTotal += hex;
  pxTotal += px;
}
backlogPerFile.sort((a, b) => b.total - a.total);

/* ---------------------------------------------------------------------------
   Report. Every line names a file, a line number, what is wrong, and what to
   do about it — no stack traces as the primary output.
   --------------------------------------------------------------------------- */

if (cannotRun) {
  console.error('check-tokens: COULD NOT RUN. See the lines above: something this check needs was missing or threw. Nothing below was measured.\n');
  process.exit(2);
}

// Check 1 — only findings NOT already in test/conform/accepted.json are fatal.
// See accepted.mjs for what fresh/accepted/stale mean; a stale entry (accepted
// here once, not reproducing now) fails the gate too, just below.
if (freshUnresolved.length === 0) {
  console.log(`check 1  PASS  every var(--x) in src/**/*.astro, src/styles/*.css and public/scripts/*.css resolves (${scanTargets.length} files scanned).`);
} else {
  console.log(`check 1  FAIL  ${freshUnresolved.length} var() reference${freshUnresolved.length === 1 ? '' : 's'} that resolve nowhere. Each renders as nothing, silently — no error, just a layout that is quietly wrong.\n`);
  for (const f of freshUnresolved) {
    console.error(`  ${f.file}:${f.line}  var(--${f.name}) — no --${f.name} in tokens.css, themes.css, global.css, ledger-v4.css, or this same file, and no fallback value.`);
    console.error(`      Fix: use a step that exists on the ramp (this repo's space ramp is --space-100 through --space-1000, with no 050 or 150 step), or add a fallback: var(--${f.name}, <value>).`);
  }
  console.log('');
}
report({ accepted: acceptedUnresolved, stale: staleUnresolved });
console.log('');

// Check 2
console.log(`check 2  WARN  ${shadows.length} local declaration${shadows.length === 1 ? '' : 's'} that shadow a name already in tokens.css/themes.css (same-scope override, may be deliberate — see file).`);
if (shadows.length > 0) {
  const byFile = new Map();
  for (const s of shadows) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }
  for (const [file, list] of byFile) {
    console.log(`    ${file}: ${list.length} — ${[...new Set(list.map((s) => `--${s.name}`))].join(', ')}`);
  }
}
console.log(`check 2  WARN  ${privateVocab.length} name${privateVocab.length === 1 ? '' : 's'} declared as a private local token in 2+ files instead of read from tokens.css (a second, undeclared token system — regression-strategy.md section 1.2).`);
if (drifted.length > 0) {
  console.log(`         ${drifted.length} of those have ALREADY DRIFTED — the same name holds a different literal value in different files today:\n`);
  for (const d of drifted) {
    console.log(`    --${d.name}`);
    for (const o of d.occurrences) console.log(`      ${o.file}:${o.line}  ${o.value}`);
  }
  console.log('      Fix (owner\'s call, not this script\'s): pick one value and either move it into tokens/*.json as a real token, or make every page read the same literal.');
} else if (privateVocab.length > 0) {
  console.log('         None of them disagree today, but a value repeated by hand in multiple files is one edit away from the same drift.');
}
console.log('');

// Check 3
if (generatedMismatch === null || generatedMismatch.length === 0) {
  console.log('check 3  PASS  src/styles/tokens.css and src/styles/themes.css match a fresh style-dictionary rebuild from tokens/*.json — neither was hand-edited.');
} else {
  console.log(`check 3  FAIL  ${generatedMismatch.join(' and ')} do not match what style-dictionary produces from tokens/*.json right now.\n`);
  for (const file of generatedMismatch) {
    console.error(`  ${file}  is build output. It was either hand-edited, or tokens/*.json changed and \`npm run tokens\` was never re-run.`);
    console.error(`      Fix: run \`npm run tokens\` and commit the result. If you meant to change a value, change it in tokens/*.json, not in this file — this file is silently overwritten the next time anyone runs \`npm run dev\`.`);
  }
}
console.log('');

// Backlog
console.log(`backlog  (not a gate, not blocking) ${hexTotal} hardcoded hex colour${hexTotal === 1 ? '' : 's'} and ${pxTotal} hardcoded px length${pxTotal === 1 ? '' : 's'} in src/**/*.astro and src/styles/*.css — ${hexTotal + pxTotal} literals bypassing the token system.`);
console.log('  Ten worst files:');
for (const f of backlogPerFile.slice(0, 10)) {
  console.log(`    ${f.file}  ${f.total} (${f.hex} hex, ${f.px} px)`);
}
console.log('  This count is not filtered for legitimate literals (breakpoints in media queries, which cannot read a custom property; raster specs; off-screen offsets), so it overstates the real backlog. Treat it as a place to start looking, not a target of zero.\n');

// A fresh check-1 finding fails the gate, same as before the ratchet. A stale
// accepted entry ALSO fails it, on purpose: accepted.json claiming a finding
// that no longer reproduces is the ratchet lying, and the fix is a one-line
// deletion from that file, not a code change here. See accepted.mjs's header.
const failed =
  freshUnresolved.length > 0 ||
  staleUnresolved.length > 0 ||
  (generatedMismatch !== null && generatedMismatch.length > 0);
if (failed) {
  console.error('check-tokens: FAIL. See check 1 and/or check 3 above.\n');
  process.exit(1);
}
console.log('check-tokens: PASS (with warnings above, if any — warnings do not fail this gate).\n');
process.exit(0);
