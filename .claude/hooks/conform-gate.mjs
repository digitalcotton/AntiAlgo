#!/usr/bin/env node
/**
 * Stop hook: refuse to end a turn while watched code has changes newer than the
 * last green gate run.
 *
 * WHY IT NO LONGER USES A MARKER FILE. It used to compare a receipt against
 * .claude/.last-edit, which blast-radius.mjs stamped with Date.now(). That has an
 * ordering bug that bit on 2026-09-24: a PostToolUse hook runs AFTER its tool call
 * completes, so a single Bash call of `sed -i … && npm run conform` wrote the green
 * receipt first and then stamped the marker a few milliseconds later. The marker was
 * always newer than the receipt, so the gate blocked a turn whose work HAD been
 * measured, and the only way past it was to run the gate a second time. A guard that
 * cries wolf gets disabled, which is the whole failure mode this harness exists to
 * prevent — so it is fixed rather than tolerated.
 *
 * WHY IT NO LONGER TRUSTS CLAUDE_PROJECT_DIR, AND NO LONGER TRUSTS MTIME ALONE.
 * The marker fix traded one cry-wolf for two more, both found on 2026-09-27 in a
 * session that was blocked TEN times on work it had measured every time:
 *
 *   1. WRONG TREE. ROOT was CLAUDE_PROJECT_DIR, which points at the main checkout
 *      even when the session is working inside .claude/worktrees/<name>. So the
 *      hook compared the MAIN checkout's files against the MAIN checkout's receipt
 *      while `npm run conform` inside the worktree wrote the WORKTREE's receipt.
 *      It never once read the receipt it had just caused to be written, and it
 *      blocked on someone else's uncommitted edits in a tree the session had not
 *      touched. ROOT is now the worktree the session is actually in.
 *
 *   2. MTIME IS NOT EVIDENCE OF CHANGE. `git worktree add` writes every file at
 *      checkout time, so a brand-new worktree with a zero-byte diff looked
 *      entirely rewritten. `npm run dev` runs `npm run tokens`, which regenerates
 *      src/styles/tokens.css and themes.css byte-identically on every start, so
 *      merely starting a dev server re-armed the gate. Both produced blocks with
 *      nothing whatsoever to measure. The question is now asked of git — what
 *      actually differs — and mtime only decides WHEN a genuinely-changed file
 *      changed.
 *
 * WHAT IT GATES, STATED PLAINLY. Uncommitted changes to watched paths. That is
 * what "the agent just did something" looks like before it is committed, and this
 * repo's own workflow (spec, edit, gate, commit) means work is measured before it
 * becomes a commit. A clean tree has nothing for this hook to protect: no diff, no
 * gate. Committing without measuring is therefore out of scope here by design —
 * catching that belongs in a pre-commit hook or CI, not in a Stop hook that would
 * otherwise demand a fresh 30s run after every single commit.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, extname } from 'node:path';

/** What counts as "the code changed". Mirrors blast-radius.mjs's wide list: the
 *  paths that reach further than any import graph shows. */
const WATCHED = ['src', 'public/scripts', 'tokens', 'db', 'astro.config.mjs', 'vercel.json', 'flags.config.mjs', 'tiers.config.mjs', 'site.config.mjs'];
const CODE = ['.astro', '.ts', '.tsx', '.mjs', '.js', '.json', '.css', '.sql'];

let hook = {};
try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch {}

// Never fight the loop protection: if we already blocked once, let it stop.
if (hook.stop_hook_active) process.exit(0);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * The tree this session is working in, not the one it was launched from.
 *
 * `git rev-parse --show-toplevel` answers with the WORKTREE's own root when run
 * inside a worktree, which is exactly the distinction CLAUDE_PROJECT_DIR cannot
 * make. The hook payload's own cwd is preferred over process.cwd() because the
 * harness may invoke this from elsewhere; CLAUDE_PROJECT_DIR survives only as the
 * last resort, for a session that is somehow not inside a repository at all.
 */
function resolveRoot() {
  for (const candidate of [hook.cwd, process.cwd()]) {
    if (!candidate) continue;
    try {
      const top = git(['rev-parse', '--show-toplevel'], candidate).trim();
      if (top) return resolve(top);
    } catch { /* not a repo, or no git: try the next candidate */ }
  }
  return resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

const ROOT = resolveRoot();

/**
 * The watched files git says actually differ: modified, added, renamed or
 * untracked. Content, not timestamps.
 *
 * -z because a path may contain a space or a quote, and the NUL-delimited form is
 * the only one that survives both. A rename prints `XY\0<new>\0<old>\0`, so the
 * entry after an R status is the old path and is skipped rather than being read as
 * a status line of its own.
 */
function changedWatchedFiles() {
  let out;
  try {
    out = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', ...WATCHED], ROOT);
  } catch {
    return null; // No git here. Caller falls back to "cannot tell", and allows.
  }
  const fields = out.split('\0');
  const files = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (status[0] === 'R' || status[1] === 'R') i += 1; // skip the rename's source
    if (path && CODE.includes(extname(path))) files.push(path);
  }
  return files;
}

const changed = changedWatchedFiles();
// No repository, or nothing changed: there is nothing for this hook to protect.
// A fresh worktree and a dev server's byte-identical token rebuild both land
// here, which is the point.
if (changed === null || changed.length === 0) process.exit(0);

/** When the newest genuinely-changed file was last written. */
let editedAt = 0;
for (const path of changed) {
  try {
    const at = statSync(join(ROOT, path)).mtimeMs;
    if (at > editedAt) editedAt = at;
  } catch { /* deleted between the status call and here */ }
}
if (editedAt === 0) process.exit(0);

const receipt = join(ROOT, '.claude', '.sweep-receipt.json');
let ok = false;
let why = 'no gate run has been recorded in this working tree';
if (existsSync(receipt)) {
  try {
    const r = JSON.parse(readFileSync(receipt, 'utf8'));
    if (r.green !== true) why = 'the last `npm run conform` finished RED';
    // A second of slack: a gate run reads the files it is measuring, and a
    // formatter or a build step can touch an mtime within the same second without
    // the code having changed. Blocking on that is the cry-wolf failure again.
    else if (r.at <= editedAt - 1000) why = 'the last `npm run conform` predates the most recent change under src/';
    else ok = true;
  } catch { why = 'the gate receipt at .claude/.sweep-receipt.json is unreadable'; }
}
if (ok) process.exit(0);

process.stdout.write(JSON.stringify({
  decision: 'block',
  reason:
    `Code under src/ changed and ${why}. Run /conform (or \`npm run conform\`) and report its ` +
    `result before ending the turn — including if it is RED; a red result honestly reported is ` +
    `the point, a turn that ends without measuring is not. If the gate genuinely should not run ` +
    `for this change, say so explicitly.`
}) + '\n');
