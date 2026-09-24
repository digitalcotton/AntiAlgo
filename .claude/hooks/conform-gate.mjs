#!/usr/bin/env node
/**
 * Stop hook: refuse to end a turn while src/ has changes newer than the last green
 * gate run.
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
 * The filesystem already knows the answer. The newest mtime under the watched paths
 * is the last time the code changed, it needs no cooperation from another hook, and
 * it cannot be written in the wrong order because nothing writes it.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const ROOT = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());

/** What counts as "the code changed". Mirrors blast-radius.mjs's wide list: the
 *  paths that reach further than any import graph shows. */
const WATCHED = ['src', 'public/scripts', 'tokens', 'db', 'astro.config.mjs', 'vercel.json', 'flags.config.mjs', 'tiers.config.mjs', 'site.config.mjs'];
const CODE = ['.astro', '.ts', '.tsx', '.mjs', '.js', '.json', '.css', '.sql'];

let hook = {};
try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch {}

// Never fight the loop protection: if we already blocked once, let it stop.
if (hook.stop_hook_active) process.exit(0);

/** The newest mtime under a path, or 0. */
function newest(path) {
  let out = 0;
  let stat;
  try { stat = statSync(path); } catch { return 0; }
  if (stat.isFile()) return CODE.includes(extname(path)) ? stat.mtimeMs : 0;
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = join(path, entry.name);
    const at = entry.isDirectory() ? newest(child) : CODE.includes(extname(child)) ? statSync(child).mtimeMs : 0;
    if (at > out) out = at;
  }
  return out;
}

let editedAt = 0;
for (const path of WATCHED) {
  const at = newest(join(ROOT, path));
  if (at > editedAt) editedAt = at;
}
if (editedAt === 0) process.exit(0); // nothing watchable here

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
