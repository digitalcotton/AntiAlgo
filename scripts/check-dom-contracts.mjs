#!/usr/bin/env node
/**
 * check-dom-contracts.mjs: assert that every static DOM selector, id and
 * data-* attribute a client script queries is actually rendered by some file
 * in this repo, and print the pair when the querying file and the rendering
 * file are not the same file.
 *
 * WHY THIS EXISTS. Server-rendered markup and client JavaScript agree on a
 * vocabulary of ids, classes and data-* names, but nothing in Astro, in
 * TypeScript, or in `astro check` enforces that agreement: it is two files
 * that happen to spell the same string the same way. Rename or delete one
 * side and the page still builds, still type-checks and still renders --
 * the failure is a `null` where an element used to be, or an early return
 * that just does nothing. It has already happened twice in exactly this
 * shape:
 *
 *   - commit edfc2ec: the board filter script read an account id out of a
 *     data-* attribute that a markup edit had renamed. `astro check` was
 *     green. Every board load threw a ReferenceError in the browser.
 *   - /profile, 2026-09: two of three client surfaces that read the same
 *     upload-status vocabulary fell out of step with the value the server
 *     actually sends (see docs/regression-strategy.md section 2). That is
 *     the same class one level up the stack -- a shared vocabulary with no
 *     shared definition -- and this gate does not reach it (see LIMITS).
 *
 * WHAT THIS DOES. It is a static, no-browser, no-build gate in two halves.
 *
 *   HALF A -- every client script in the repo (the <script> blocks inside
 *   src/**\/*.astro, plus the two files in public/scripts/) is scanned for
 *   querySelector(All), getElementById, .closest, .matches and .dataset
 *   reads with a literal argument. For each one, this asks: does the
 *   literal's id / class / data-* / tag name appear as real markup
 *   somewhere in the repo? If it is in the same file, that is cheap and
 *   expected and is only counted. If it is in a DIFFERENT file, that pair
 *   is the dangerous one -- nothing else in this repo writes it down -- so
 *   it is printed: "A.astro expects SELECTOR, provided by B.astro:NN".
 *   A selector built at runtime (a template literal with `${...}`, a
 *   variable, a concatenation) cannot be checked this way; it is reported
 *   by name under UNVERIFIABLE rather than silently skipped.
 *
 *   HALF B -- public/scripts/ledger-v4-app.js and ledger-v4-views.js are
 *   1,741 lines that sit outside `astro check` entirely (see LIMITS). This
 *   half asserts, by name, the specific markup and JSON-shape assumptions
 *   those two files make about src/pages/jobs-data.astro and about the
 *   payload src/lib/jobs-data-page.ts and src/pages/jobs-data/summary.ts
 *   produce: the mount id and its data-* attributes, the script tag the
 *   initial payload rides in, the field names the client destructures out
 *   of that payload, the two JSON keys a filter press expects back from
 *   /jobs-data/summary, and that the nine view names ledger-v4-views.js
 *   registers on window.LEDGER_VIEWS are the same nine names every other
 *   consumer in the repo expects.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 *   - It does not run a browser and does not render anything. It cannot
 *     see an attribute that is only ever produced at runtime by a database
 *     row, and it cannot see a selector that resolves to nothing when the
 *     page has zero results. That is Layer 1 in docs/regression-strategy.md,
 *     not this gate.
 *   - It does not model CSS combinators. A selector like `header.hdr .nav`
 *     is checked as a bag of required atoms (tag "header", class "hdr",
 *     class "nav") that must each appear somewhere, not as "an element
 *     with class nav that is a descendant of an element with class hdr
 *     and tag header". A markup change that keeps every atom but breaks
 *     the nesting passes this gate and would only be caught by a real DOM.
 *   - It does not resolve a helper. A selector assembled by a shared
 *     function (`selectorFor(x)`) is reported UNVERIFIABLE by that
 *     function's call site, not traced into the function.
 *   - Presence is checked two ways and either is enough to pass: a
 *     targeted regex for `class=`, `id=` and `data-*` attribute syntax
 *     (precise), and, only when that finds nothing anywhere in the repo, a
 *     plain substring search for the identifier (so a class built through
 *     `class:list={[...]}`, `cx(...)` or some other form this gate's
 *     regex does not model still counts as provided, instead of this gate
 *     crying wolf on syntax it never learned to parse). A pass reached only
 *     through the substring fallback is marked "(text match)" so a human
 *     can double check it. Both tiers coming up empty is the only thing
 *     that fails: a truly absent identifier, string-searched across the
 *     whole repository, is the actual signature of the rename-or-drop bug
 *     this gate exists to catch.
 *   - It does NOT cover the resume-upload class of bug (an untyped wire
 *     vocabulary hand-copied into several client files): that is a JSON
 *     value agreement, not a DOM selector agreement, and needs the wire-
 *     contract modules docs/regression-strategy.md section 5 (Layer 3)
 *     describes, not this script.
 *
 * EXIT CODES. 0 = every checkable selector resolved. 1 = at least one
 * selector's identifiers are not rendered anywhere in the repo, or a Half B
 * assumption no longer holds -- read the printed line, it names the file,
 * the line and what to fix. 2 = the gate could not run at all (a file it
 * depends on to even ask the question is missing, or scanning the repo
 * turned up zero client scripts, which means the extraction itself is
 * broken, not that the app has none). This script never exits 0 having
 * found nothing: a gate that could not run has measured nothing, and
 * printing green for that is the exact failure this repo is done shipping.
 *
 * Plain Node ESM, Node 24, zero dependencies beyond node:fs / node:path.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { partition, report } from '../test/conform/accepted.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'check-dom-contracts';

const EXIT = { PASS: 0, FAIL: 1, CANNOT_RUN: 2 };

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

function rel(p) {
  return relative(REPO, p).split('\\').join('/');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineAt(text, index) {
  if (index < 0) return null;
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') n++;
  }
  return n;
}

function kebab(camel) {
  return camel.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[A-Z]/g, (m) => m.toLowerCase());
}

/** Recursively list files under dir whose name matches the given extension. */
function walk(dir, ext, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      walk(p, ext, out);
    } else if (extname(entry) === ext) {
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// File corpus.
// ---------------------------------------------------------------------------

const ASTRO_FILES = walk(join(REPO, 'src'), '.astro').sort();
const PUBLIC_SCRIPT_FILES = existsSync(join(REPO, 'public', 'scripts'))
  ? readdirSync(join(REPO, 'public', 'scripts'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => join(REPO, 'public', 'scripts', f))
      .sort()
  : [];

if (ASTRO_FILES.length === 0) {
  console.error(`${NAME}: found zero .astro files under src/. Either the repo moved or this script's file walk is broken.`);
  console.error(`${NAME}: refusing to report a pass having scanned nothing. Exit 2.`);
  process.exit(EXIT.CANNOT_RUN);
}

/** Read once, cache forever -- every file is read at most a handful of times. */
const fileTextCache = new Map();
function readText(path) {
  if (!fileTextCache.has(path)) {
    fileTextCache.set(path, readFileSync(path, 'utf8'));
  }
  return fileTextCache.get(path);
}

/** Strip <style>...</style> blocks: CSS selects markup, it never provides it. */
function providerTextFor(path) {
  const text = readText(path);
  return text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => '\n'.repeat((m.match(/\n/g) || []).length));
}

const ALL_PROVIDER_FILES = [...ASTRO_FILES, ...PUBLIC_SCRIPT_FILES];

// ---------------------------------------------------------------------------
// HALF A -- extract client script text out of each source file.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ScriptBlock
 * @property {string} file    absolute path of the source file
 * @property {string} text    the script's own text (module or inline)
 * @property {number} startIndex  offset of `text` within the FULL file text
 */

/** All <script>...</script> block bodies in an .astro file, each with its
 *  absolute offset in the file so line numbers come out right. */
function scriptBlocksIn(astroPath) {
  const text = readText(astroPath);
  const blocks = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(text))) {
    const content = m[1];
    const prefixLen = m[0].length - content.length - '</script>'.length;
    const startIndex = m.index + prefixLen;
    blocks.push({ file: astroPath, text: content, startIndex });
  }
  return blocks;
}

/** @type {ScriptBlock[]} */
const SCRIPT_BLOCKS = [];
for (const f of ASTRO_FILES) SCRIPT_BLOCKS.push(...scriptBlocksIn(f));
for (const f of PUBLIC_SCRIPT_FILES) SCRIPT_BLOCKS.push({ file: f, text: readText(f), startIndex: 0 });

// ---------------------------------------------------------------------------
// HALF A -- pull selector-call sites and dataset reads out of each block.
// ---------------------------------------------------------------------------

const QUERY_FNS = ['querySelectorAll', 'querySelector', 'getElementById', 'closest', 'matches'];

/**
 * Manually walk a call's argument list starting just after its opening '('.
 * Regex cannot reliably find the matching ')' when the argument itself
 * contains parens or quoted parens, so this tracks paren depth and string
 * state by hand. Returns { argsText, endIndex } or null if unbalanced.
 */
function readBalancedArgs(text, openParenIndex) {
  let depth = 1;
  let i = openParenIndex + 1;
  const start = i;
  let quote = null;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (depth !== 0) return null;
  return { argsText: text.slice(start, i), endIndex: i };
}

/** Is `argsText` exactly one string literal (quote/backtick), nothing else? */
function staticLiteral(argsText) {
  const t = argsText.trim();
  const m = /^(['"`])((?:\\.|(?!\1)[\s\S])*)\1$/.exec(t);
  if (!m) return null;
  const [, q, body] = m;
  if (q === '`' && body.includes('${')) return null; // interpolated template literal
  // Unescape the small set of escapes that show up in these files.
  return body.replace(/\\(.)/g, '$1');
}

/**
 * @typedef {object} CallSite
 * @property {string} file
 * @property {number} line
 * @property {string} fn
 * @property {string|null} literal   the resolved selector/id string, or null if dynamic
 * @property {string} raw            the raw argument text, for the UNVERIFIABLE report
 */

/** @type {CallSite[]} */
const CALL_SITES = [];
/** @type {{file:string, line:number, prop:string}[]} */
const DATASET_READS = [];
/** @type {{file:string, line:number, prop:string}[]} */
const DATASET_WRITES = [];
/** @type {{file:string, line:number, snippet:string}[]} */
const DYNAMIC_DATASET = [];

/** Line number for an offset local to a script block, against the FULL file
 *  text -- astro <script> blocks start partway through their file, so the
 *  local offset has to be added to the block's own start before counting
 *  newlines, never counted against the block's own (0-based) text alone. */
function absoluteLine(file, startIndex, localIndex) {
  return lineAt(readText(file), startIndex + localIndex);
}

for (const block of SCRIPT_BLOCKS) {
  const { file, text, startIndex } = block;

  for (const fn of QUERY_FNS) {
    const head = new RegExp(`(?:^|[^\\w$])${escapeRe(fn)}\\s*(?:<[^>]*>)?\\s*\\(`, 'g');
    let hm;
    while ((hm = head.exec(text))) {
      const openIdx = hm.index + hm[0].length - 1;
      const balanced = readBalancedArgs(text, openIdx);
      if (!balanced) continue;
      const line = absoluteLine(file, startIndex, hm.index);
      const literal = staticLiteral(balanced.argsText);
      CALL_SITES.push({ file, line, fn, literal, raw: balanced.argsText.trim().slice(0, 80) });
    }
  }

  // `.dataset.prop` can be a READ (needs markup or another script to have
  // set data-prop first) or a WRITE (`el.dataset.prop = x`, which stamps the
  // attribute on at runtime and needs no markup on either side -- a script
  // building its own elements, e.g. Board.astro's custom <select> menu,
  // writes and reads the same property on nodes it created itself). Only
  // reads go in the required-checks list; writes go in DATASET_WRITES and
  // count as a valid provider for that property everywhere below, so a
  // write-then-read within one script's own dynamic markup is not reported
  // as a cross-file mystery or, worse, a false FAIL.
  const dsRe = /\.dataset\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let dm;
  while ((dm = dsRe.exec(text))) {
    const after = text.slice(dm.index + dm[0].length).match(/^\s*(=+)/);
    const isWrite = Boolean(after && after[1] === '=');
    const line = absoluteLine(file, startIndex, dm.index);
    if (isWrite) {
      DATASET_WRITES.push({ file, line, prop: dm[1] });
    } else {
      DATASET_READS.push({ file, line, prop: dm[1] });
    }
  }
  const dsDynRe = /\.dataset\[/g;
  let ddm;
  while ((ddm = dsDynRe.exec(text))) {
    DYNAMIC_DATASET.push({ file, line: absoluteLine(file, startIndex, ddm.index), snippet: text.slice(ddm.index, ddm.index + 40).trim() });
  }
}

if (CALL_SITES.length === 0 && DATASET_READS.length === 0) {
  console.error(`${NAME}: scanned ${ASTRO_FILES.length} .astro files and ${PUBLIC_SCRIPT_FILES.length} public/scripts files and found zero query calls and zero dataset reads.`);
  console.error(`${NAME}: that almost certainly means the extraction regexes broke, not that the app stopped touching the DOM. Exit 2.`);
  process.exit(EXIT.CANNOT_RUN);
}

// A SECOND, INDEPENDENT sanity check, because the check above can pass while
// the structured extraction for just ONE function name is silently broken
// (this happened during development: a stray character in the word-boundary
// regex made every querySelector/getElementById/closest/matches call
// invisible while dataset reads kept working fine, so the pair-count-above-
// zero guard did not fire and the gate would have reported real-looking
// results computed from a fifth of the corpus). For each function name, a
// crude unstructured substring count and the structured call-site count must
// agree on whether that function is used AT ALL in the scanned files.
for (const fn of QUERY_FNS) {
  const rawHits = SCRIPT_BLOCKS.reduce((n, b) => n + (b.text.split(fn + '(').length - 1), 0);
  const structuredHits = CALL_SITES.filter((c) => c.fn === fn).length;
  if (rawHits > 0 && structuredHits === 0) {
    console.error(`${NAME}: "${fn}(" appears ${rawHits} time(s) in the scanned files (plain substring count) but the structured extractor found 0 call sites for it.`);
    console.error(`${NAME}: the extractor for this function is broken, not the app. Fix the regex in this script before trusting any count above. Exit 2.`);
    process.exit(EXIT.CANNOT_RUN);
  }
}

// ---------------------------------------------------------------------------
// HALF A -- parse a selector string into the atoms it requires.
// ---------------------------------------------------------------------------

/** Split `s` on `sep` chars, but never inside [...] or quotes. */
function splitTopLevel(s, seps) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[') { depth++; cur += c; continue; }
    if (c === ']') { depth--; cur += c; continue; }
    if (depth === 0 && seps.includes(c)) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : [s.trim()];
}

/**
 * @typedef {{tag:string|null, classes:string[], ids:string[], attrs:string[]}} Atoms
 */

/** Parse one simple selector (no combinators) into its atoms. */
function parseSimpleSelector(seg) {
  const atoms = { tag: null, classes: [], ids: [], attrs: [] };
  const re = /^[a-zA-Z][\w-]*|\.[a-zA-Z_-][\w-]*|#[a-zA-Z_-][\w-]*|\[[^\]]*\]|::?[a-zA-Z-]+(?:\([^)]*\))?/g;
  let m;
  let first = true;
  while ((m = re.exec(seg))) {
    const tok = m[0];
    if (tok.startsWith('.')) atoms.classes.push(tok.slice(1));
    else if (tok.startsWith('#')) atoms.ids.push(tok.slice(1));
    else if (tok.startsWith('[')) {
      const inner = tok.slice(1, -1);
      const attrName = inner.split(/[=~^$*|\s]/)[0].trim();
      if (attrName) atoms.attrs.push(attrName);
    } else if (tok.startsWith(':')) {
      // pseudo-class / pseudo-element, not a markup atom.
    } else if (first) {
      atoms.tag = tok;
    }
    first = false;
  }
  return atoms;
}

/** A selector string may be a comma list of alternatives; each alternative
 *  is itself a chain of simple selectors joined by combinators. This gate
 *  only checks the rightmost simple selector of each alternative (the atoms
 *  of the element actually returned), per the "no combinator modelling"
 *  limitation in the header comment. */
function parseSelector(selector) {
  return splitTopLevel(selector, ',').map((alt) => {
    const segs = splitTopLevel(alt, ' >+~\t').filter(Boolean);
    const last = segs[segs.length - 1] || alt;
    return parseSimpleSelector(last);
  });
}

// ---------------------------------------------------------------------------
// HALF A -- does a file provide a given atom?
// ---------------------------------------------------------------------------

const CLASS_ATTR_RE = /class(?:Name)?(?::list)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
const ID_ATTR_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;

function splitWords(s) {
  return s.split(/[^a-zA-Z0-9_-]+/).filter(Boolean);
}

/** Tier 1 (precise): does providerText contain a real class="" / class:list
 *  carrying `name`? Returns the character index of the match, or -1. */
function findClassAttr(providerText, name) {
  CLASS_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = CLASS_ATTR_RE.exec(providerText))) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    if (splitWords(value).includes(name)) return m.index;
  }
  return -1;
}

function findIdAttr(providerText, name) {
  ID_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ID_ATTR_RE.exec(providerText))) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (value === name || splitWords(value).includes(name)) return m.index;
  }
  return -1;
}

function findAttr(providerText, name) {
  const re = new RegExp(`\\b${escapeRe(name)}\\s*[=>/\\s]`, 'g');
  const m = re.exec(providerText);
  return m ? m.index : -1;
}

function findTag(providerText, name) {
  const re = new RegExp(`<${escapeRe(name)}(?=[\\s>/])`, 'gi');
  const m = re.exec(providerText);
  return m ? m.index : -1;
}

/** Tier 2 (fallback): a plain, case-sensitive, word-bounded substring
 *  search, used only when tier 1 found the atom nowhere in the repo. */
function findSubstring(text, name, minOccurrences) {
  const re = new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`, 'g');
  let count = 0;
  let firstIndex = -1;
  let m;
  while ((m = re.exec(text))) {
    if (firstIndex === -1) firstIndex = m.index;
    count++;
    if (count >= minOccurrences) return firstIndex;
  }
  return -1;
}

/**
 * Locate one atom across the whole corpus. Checks `selfFile` first (with
 * tier-1 precision), then every other file (tier 1), then -- only if tier 1
 * came up empty everywhere -- falls back to a raw substring search
 * (self-file needs 2 occurrences so the call site does not match itself).
 */
function locateAtom(atom, selfFile) {
  const finder =
    atom.kind === 'class' ? findClassAttr :
    atom.kind === 'id' ? findIdAttr :
    atom.kind === 'attr' ? findAttr :
    findTag;

  // A data-* attribute can also be stamped on at runtime by
  // `el.dataset.prop = x` rather than written in markup (see DATASET_WRITES
  // above) -- a script that builds and reads its own elements needs no
  // provider on either side, so a matching write counts as one here.
  const datasetWriteLine = (file) => {
    if (atom.kind !== 'attr' || !atom.value.startsWith('data-')) return -1;
    const hit = DATASET_WRITES.find((w) => w.file === file && 'data-' + kebab(w.prop) === atom.value);
    return hit ? hit.line : -1;
  };

  // Self file, tier 1.
  const selfText = providerTextFor(selfFile);
  let idx = finder(selfText, atom.value);
  if (idx !== -1) return { file: selfFile, sameFile: true, line: lineAt(readText(selfFile), idx), fallback: false };
  const selfWrite = datasetWriteLine(selfFile);
  if (selfWrite !== -1) return { file: selfFile, sameFile: true, line: selfWrite, fallback: false };

  // Other files, tier 1, in a stable order.
  for (const f of ALL_PROVIDER_FILES) {
    if (f === selfFile) continue;
    const t = providerTextFor(f);
    const i = finder(t, atom.value);
    if (i !== -1) return { file: f, sameFile: false, line: lineAt(readText(f), i), fallback: false };
    const w = datasetWriteLine(f);
    if (w !== -1) return { file: f, sameFile: false, line: w, fallback: false };
  }

  // Tier 2: raw substring, self file first (needs 2 hits), then others.
  const selfSub = findSubstring(readText(selfFile), atom.value, 2);
  if (selfSub !== -1) return { file: selfFile, sameFile: true, line: lineAt(readText(selfFile), selfSub), fallback: true };
  for (const f of ALL_PROVIDER_FILES) {
    if (f === selfFile) continue;
    const i = findSubstring(readText(f), atom.value, 1);
    if (i !== -1) return { file: f, sameFile: false, line: lineAt(readText(f), i), fallback: true };
  }
  return null;
}

/** Flatten one selector alternative's atoms into a list to locate. */
function atomList(atoms) {
  const list = [];
  if (atoms.tag) list.push({ kind: 'tag', value: atoms.tag });
  for (const c of atoms.classes) list.push({ kind: 'class', value: c });
  for (const i of atoms.ids) list.push({ kind: 'id', value: i });
  for (const a of atoms.attrs) list.push({ kind: 'attr', value: a });
  return list;
}

// ---------------------------------------------------------------------------
// HALF A -- evaluate every call site and dataset read.
// ---------------------------------------------------------------------------

const results = {
  sameFilePass: 0,
  crossFilePairs: [],  // { file, line, fn, selector, providerFile, providerLine, fallback }
  unverifiable: [],    // { file, line, fn, raw }
  fails: [],           // { file, line, fn, selector, atom }
};

for (const site of CALL_SITES) {
  if (site.literal === null) {
    results.unverifiable.push({ file: site.file, line: site.line, fn: site.fn, raw: site.raw });
    continue;
  }
  // getElementById takes a bare id, not a CSS selector -- 'ledger-data' must
  // be treated as an id atom, not run through the selector parser, which
  // would read a bare alphabetic string as a TAG name and check for a
  // literal `<ledger-data` element instead of an id="ledger-data" attribute.
  const alternatives = site.fn === 'getElementById'
    ? [{ tag: null, classes: [], ids: [site.literal], attrs: [] }]
    : parseSelector(site.literal);
  let bestAlt = null; // the alternative that resolved most atoms, for reporting on total failure
  let allAtomsEmpty = true;

  let altPassed = false;
  for (const atoms of alternatives) {
    const atoms_ = atomList(atoms);
    if (atoms_.length === 0) { altPassed = true; continue; } // nothing to verify (pure pseudo-selector etc.)
    allAtomsEmpty = false;
    let thisAltOk = true;
    let worstMiss = null;
    let providerInfo = null; // from the most specific atom located, for the printed pair
    for (const atom of atoms_) {
      const loc = locateAtom(atom, site.file);
      if (!loc) { thisAltOk = false; worstMiss = atom; break; }
      // Prefer id/attr over class over tag for the reported provider line.
      if (!providerInfo || (providerInfo.atomKind === 'tag' && atom.kind !== 'tag')) {
        providerInfo = { ...loc, atomKind: atom.kind, atomValue: atom.value };
      }
    }
    if (thisAltOk) {
      altPassed = true;
      bestAlt = providerInfo;
      break;
    } else if (!bestAlt) {
      bestAlt = { miss: worstMiss };
    }
  }

  if (allAtomsEmpty && !altPassed) {
    // Selector had no checkable atoms at all (e.g. bare pseudo-class list).
    results.sameFilePass++;
    continue;
  }

  if (altPassed) {
    if (bestAlt && bestAlt.sameFile === false) {
      results.crossFilePairs.push({
        file: site.file, line: site.line, fn: site.fn, selector: site.literal,
        providerFile: bestAlt.file, providerLine: bestAlt.line, fallback: bestAlt.fallback,
      });
    } else {
      results.sameFilePass++;
    }
  } else {
    results.fails.push({
      file: site.file, line: site.line, fn: site.fn, selector: site.literal,
      atom: bestAlt && bestAlt.miss ? `${bestAlt.miss.kind}:${bestAlt.miss.value}` : 'unknown',
    });
  }
}

for (const d of DATASET_READS) {
  const attrName = 'data-' + kebab(d.prop);
  const loc = locateAtom({ kind: 'attr', value: attrName }, d.file);
  if (!loc) {
    results.fails.push({ file: d.file, line: d.line, fn: 'dataset', selector: `.dataset.${d.prop}`, atom: `attr:${attrName}` });
  } else if (loc.sameFile) {
    results.sameFilePass++;
  } else {
    results.crossFilePairs.push({
      file: d.file, line: d.line, fn: 'dataset', selector: `.dataset.${d.prop}`,
      providerFile: loc.file, providerLine: loc.line, fallback: loc.fallback,
    });
  }
}

for (const d of DYNAMIC_DATASET) {
  results.unverifiable.push({ file: d.file, line: d.line, fn: 'dataset[..]', raw: d.snippet });
}

// ---------------------------------------------------------------------------
// HALF B -- public/scripts/ledger-v4-*.js against src/pages/jobs-data.astro
// and the payload/endpoint that feed it. Hand-written, because these are the
// specific assumptions research already named, not a class of assumption a
// generic scanner can enumerate.
// ---------------------------------------------------------------------------

const halfB = { assumptions: [], fails: [], cannotRun: [] };

function requireFile(label, path) {
  if (!existsSync(path)) {
    halfB.cannotRun.push(`${label} does not exist at ${rel(path)}`);
    return null;
  }
  return readText(path);
}

const APP_JS = join(REPO, 'public', 'scripts', 'ledger-v4-app.js');
const VIEWS_JS = join(REPO, 'public', 'scripts', 'ledger-v4-views.js');
const JOBS_DATA_ASTRO = join(REPO, 'src', 'pages', 'jobs-data.astro');
const JOBS_DATA_PAGE_TS = join(REPO, 'src', 'lib', 'jobs-data-page.ts');
const SUMMARY_TS = join(REPO, 'src', 'pages', 'jobs-data', 'summary.ts');
const JOBS_DATA_AGG_TS = join(REPO, 'src', 'lib', 'jobs-data-agg.ts');
const RENDER_TEST_TS = join(REPO, 'src', 'lib', 'jobs-data-render.test.ts');

const appText = requireFile('ledger-v4-app.js', APP_JS);
const viewsText = requireFile('ledger-v4-views.js', VIEWS_JS);
const pageAstroText = requireFile('src/pages/jobs-data.astro', JOBS_DATA_ASTRO);
const pageTsText = requireFile('src/lib/jobs-data-page.ts', JOBS_DATA_PAGE_TS);
const summaryTsText = requireFile('src/pages/jobs-data/summary.ts', SUMMARY_TS);
const aggTsText = requireFile('src/lib/jobs-data-agg.ts', JOBS_DATA_AGG_TS);
const renderTestText = requireFile('src/lib/jobs-data-render.test.ts', RENDER_TEST_TS);

function assumeB(name, ok, detail) {
  halfB.assumptions.push({ name, ok, detail });
  if (!ok) halfB.fails.push({ name, detail });
}

if (appText && pageAstroText) {
  assumeB(
    'app.js finds its mount by id="ledger-app"',
    /getElementById\(\s*['"]ledger-app['"]\s*\)/.test(appText) && /id=["']ledger-app["']/.test(pageAstroText),
    'ledger-v4-app.js:getElementById(\'ledger-app\') <-> src/pages/jobs-data.astro <div id="ledger-app" ...>'
  );
  assumeB(
    'app.js reads the summary endpoint path from mount.dataset.summary',
    /dataset\.summary/.test(appText) && /data-summary=/.test(pageAstroText),
    'ledger-v4-app.js:mount.dataset.summary <-> jobs-data.astro data-summary={withBase(\'/jobs-data/summary\')}'
  );
  assumeB(
    'app.js reads the "named" flag from mount.dataset.named',
    /dataset\.named/.test(appText) && /data-named=/.test(pageAstroText),
    'ledger-v4-app.js:mount.dataset.named <-> jobs-data.astro data-named="true"'
  );
  assumeB(
    'app.js reads the initial payload from a script tag id="ledger-data"',
    /getElementById\(\s*['"]ledger-data['"]\s*\)/.test(appText) && /id=["']ledger-data["']/.test(pageAstroText),
    'ledger-v4-app.js:getElementById(\'ledger-data\') <-> jobs-data.astro <script id="ledger-data" type="application/json" ...>'
  );
  assumeB(
    'jobs-data.astro actually loads both ledger-v4-app.js and ledger-v4-views.js',
    /ledger-v4-app\.js/.test(pageAstroText) && /ledger-v4-views\.js/.test(pageAstroText),
    'jobs-data.astro builds appJs/viewsJs from \'/scripts/ledger-v4-app.js\' and \'/scripts/ledger-v4-views.js\' and <script src> tags for both'
  );
}

if (appText && pageTsText) {
  // Top-level payload fields app.js destructures out of DATA.
  const dataFields = ['SWEEP', 'FACTS', 'INDUSTRY', 'TEAM', 'SIGNALS', 'TIERS', 'RULES', 'RULE_KEYS', 'PAY_LO', 'PAY_HI', 'LIFE_HI'];
  for (const field of dataFields) {
    const readByApp = new RegExp(`DATA\\.${field}\\b`).test(appText);
    if (!readByApp) continue; // only assert fields app.js actually reads
    const emittedByPage = new RegExp(`\\b${field}\\b`).test(pageTsText);
    assumeB(
      `initial payload carries ${field} (app.js reads DATA.${field})`,
      emittedByPage,
      `ledger-v4-app.js reads DATA.${field}; src/lib/jobs-data-page.ts's buildJobsDataPayload() must return a "${field}" field`
    );
  }
  assumeB(
    'app.js reads DATA.VIEW.live and DATA.VIEW.kills for the first paint',
    /DATA\.VIEW/.test(appText) && /\bVIEW\b/.test(pageTsText),
    'ledger-v4-app.js reads DATA.VIEW.live / DATA.VIEW.kills; jobs-data-page.ts returns "VIEW: view" where view = cachedView(...)'
  );
}

if (appText && aggTsText) {
  const factsFields = ['liveN', 'customLivePct', 'atsOptions', 'titleIndex'];
  for (const field of factsFields) {
    const readByApp = new RegExp(`FACTS\\.${field}\\b`).test(appText);
    if (!readByApp) continue;
    assumeB(
      `BoardFacts carries ${field} (app.js reads FACTS.${field})`,
      new RegExp(`\\b${field}\\s*:`).test(aggTsText) || new RegExp(`\\b${field}\\b`).test(aggTsText),
      `ledger-v4-app.js reads FACTS.${field}; src/lib/jobs-data-agg.ts's BoardFacts type / boardFacts() must produce a "${field}" field`
    );
  }
}

if (appText && summaryTsText) {
  assumeB(
    'a filter press expects {live, kills} back from /jobs-data/summary',
    /body\.live\b/.test(appText) && /body\.kills\b/.test(appText),
    'ledger-v4-app.js: AGG = body.live, KAGG = body.kills, read from the fetch(SUMMARY_PATH) response'
  );
  assumeB(
    'summary.ts actually answers with "live" and "kills" keys',
    /\blive\s*:\s*view\.live\b/.test(summaryTsText) || /\blive\b/.test(summaryTsText),
    'src/pages/jobs-data/summary.ts: json({ stamp: view.stamp, live: view.live, kills: view.kills }, 200, ...)'
  );
  const summaryHasBoth = /\blive\b/.test(summaryTsText) && /\bkills\b/.test(summaryTsText);
  assumeB(
    'the wire keys app.js reads (live, kills) are both present in summary.ts\'s response object',
    summaryHasBoth,
    'if either key is renamed on one side only, a filter press silently resets that half of the page to its empty state -- no error, no failed request'
  );
}

if (viewsText && appText) {
  // window.LEDGER_VIEWS registration in views.js.
  const registryMatch = /window\.LEDGER_VIEWS\s*=\s*\{([^}]*)\}/.exec(viewsText);
  const registered = registryMatch
    ? Array.from(registryMatch[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)).map((m) => m[1])
    : [];
  assumeB(
    'ledger-v4-views.js registers at least one view on window.LEDGER_VIEWS',
    registered.length > 0,
    'expected a "window.LEDGER_VIEWS = { render_x: render_x, ... }" assignment in ledger-v4-views.js; found none, so app.js\'s render() loop has nothing to call'
  );

  if (renderTestText) {
    const testViewsMatch = /const\s+VIEWS\s*=\s*\[([\s\S]*?)\]/.exec(renderTestText);
    const testViews = testViewsMatch
      ? Array.from(testViewsMatch[1].matchAll(/'([^']+)'/g)).map((m) => m[1])
      : [];
    const missingFromViews = testViews.filter((v) => !registered.includes(v));
    const missingFromTest = registered.filter((v) => !testViews.includes(v));
    assumeB(
      'the view names src/lib/jobs-data-render.test.ts exercises are exactly the names ledger-v4-views.js registers',
      testViews.length > 0 && missingFromViews.length === 0 && missingFromTest.length === 0,
      testViews.length === 0
        ? 'could not find a VIEWS = [...] array in jobs-data-render.test.ts to compare against'
        : `test expects [${testViews.join(', ')}]; views.js registers [${registered.join(', ')}]; ` +
          `missing from registry: [${missingFromViews.join(', ') || 'none'}]; missing from test: [${missingFromTest.join(', ') || 'none'}]`
    );
  }
}

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------

console.log(`${NAME}: scanned ${ASTRO_FILES.length} .astro files and ${PUBLIC_SCRIPT_FILES.length} public/scripts files.`);
console.log(`${NAME}: ${CALL_SITES.length} query call sites (querySelector/querySelectorAll/getElementById/closest/matches), ${DATASET_READS.length} static dataset reads.`);
console.log('');

console.log('HALF A -- static selector contracts');
console.log('------------------------------------');
console.log(`  same-file (querying script and its markup are one file): ${results.sameFilePass} OK`);
console.log('');

if (results.crossFilePairs.length) {
  console.log(`  cross-file pairs (the dangerous ones -- written down here for the first time): ${results.crossFilePairs.length}`);
  for (const p of results.crossFilePairs) {
    const tag = p.fallback ? ' [text match, not attribute-parsed -- worth a manual glance]' : '';
    console.log(`    ${rel(p.file)}:${p.line} expects ${JSON.stringify(p.selector)} (${p.fn}), provided by ${rel(p.providerFile)}:${p.providerLine}${tag}`);
  }
  console.log('');
}

if (results.unverifiable.length) {
  console.log(`  UNVERIFIABLE (selector built at runtime, not a literal -- reported by name, not skipped): ${results.unverifiable.length}`);
  for (const u of results.unverifiable) {
    console.log(`    ${rel(u.file)}:${u.line} ${u.fn}(${u.raw}${u.raw.length >= 80 ? '...' : ''})`);
  }
  console.log('');
}

if (results.fails.length) {
  console.log(`  FAIL -- selector's identifier appears NOWHERE in the repo: ${results.fails.length}`);
  for (const f of results.fails) {
    console.log(`    ${rel(f.file)}:${f.line}  ${f.fn}(${JSON.stringify(f.selector)})`);
    console.log(`        missing atom: ${f.atom}`);
    console.log(`        what to do: either this file's markup dropped/renamed it, or the script is dead code querying something that no longer exists. Check both sides of that name.`);
  }
  console.log('');
}

console.log('HALF B -- public/scripts/ledger-v4-*.js against jobs-data.astro and its payload');
console.log('---------------------------------------------------------------------------------');
if (halfB.cannotRun.length) {
  console.log(`  COULD NOT CHECK: ${halfB.cannotRun.length} required file(s) missing:`);
  for (const c of halfB.cannotRun) console.log(`    - ${c}`);
} else {
  for (const a of halfB.assumptions) {
    console.log(`  ${a.ok ? 'OK  ' : 'FAIL'} ${a.name}`);
    if (!a.ok) console.log(`        ${a.detail}`);
  }
}
console.log('');
console.log('  HONEST LIMIT: src/lib/jobs-data-render.test.ts is the one test in this repo that');
console.log('  actually EXECUTES these two files against a real payload, but it is wrapped in');
console.log('  `describe.skip` unless DATABASE_URL is set (lines 22-23 of that file). On a machine');
console.log('  or CI runner with no database, that suite silently drops out and this static gate');
console.log('  is the only thing left standing on 1,741 lines of untyped browser code -- and this');
console.log('  gate does not execute a single line of either file, it only checks the string');
console.log('  contracts named above. A change that keeps every name here the same but breaks the');
console.log('  actual rendering logic will not be caught by anything on a database-less machine.');
console.log('');

// ---------------------------------------------------------------------------
// The ratchet -- stable ids for the two kinds of finding this gate produces.
//
// WHY. A gate landed on a repo that already has debt is red on its first
// run, and a gate that is red on its first run gets bypassed -- this repo
// has already lost two instruments exactly that way (test/conform/accepted
// .json's own $comment names both). So a finding this gate has already shown
// the owner and that is recorded in test/conform/accepted.json is reported
// below, not fatal; only a FRESH finding, or an accepted one that stopped
// reproducing, fails the gate. See test/conform/accepted.mjs.
//
// Ids carry no line number on purpose: Board.astro's two dead selectors sit
// at lines 288-289 today, but the id must survive the lines above them
// moving, or an accepted finding reappears as fresh for a reason that has
// nothing to do with the finding itself.
// ---------------------------------------------------------------------------

/** A HALF A fail's `atom` is "kind:value" (e.g. "attr:data-count-rows"); the
 *  kind prefix is bookkeeping for this script, not part of the thing's own
 *  name, so the id drops it and keeps only the value. */
function domContractId(file, atom) {
  const identifier = atom.includes(':') ? atom.slice(atom.indexOf(':') + 1) : atom;
  return `dom-contract:${rel(file)}:${identifier}`;
}

/** A HALF B fail has no single querying file -- it is an assumption about a
 *  pair or chain of files -- so its id is the assumption's own name, slugged.
 *  The name is written once, by hand, in this script, and does not move. */
function halfBId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `dom-contract:half-b:${slug}`;
}

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------

const totalFails = results.fails.length + halfB.fails.length;
const cannotRun = halfB.cannotRun.length > 0;

if (cannotRun) {
  console.error(`${NAME}: exit 2 -- Half B could not run against the files it needs. See COULD NOT CHECK above.`);
  process.exit(EXIT.CANNOT_RUN);
}

if (totalFails > 0) {
  console.log(`${NAME}: ${totalFails} contract(s) broken (${results.fails.length} DOM selector, ${halfB.fails.length} Half B assumption). See FAIL lines above.`);
}

const findings = [
  ...results.fails.map((f) => ({ id: domContractId(f.file, f.atom), ...f })),
  ...halfB.fails.map((f) => ({ id: halfBId(f.name), ...f })),
];
const { fresh, accepted, stale } = partition(NAME, findings);
report({ accepted, stale });

if (fresh.length > 0) {
  console.error(`\n${NAME}: exit 1 -- ${fresh.length} contract(s) broken that are NOT in test/conform/accepted.json. See FAIL lines above.`);
}
if (stale.length > 0) {
  console.error(`${NAME}: exit 1 -- ${stale.length} accepted finding(s) above no longer reproduce. That line is now a lie; delete it from test/conform/accepted.json.`);
}
if (fresh.length > 0 || stale.length > 0) {
  process.exit(EXIT.FAIL);
}

console.log(`${NAME}: exit 0 -- every static selector, id and data-* contract this gate can check still agrees on both sides, or is accepted in test/conform/accepted.json.`);
process.exit(EXIT.PASS);
