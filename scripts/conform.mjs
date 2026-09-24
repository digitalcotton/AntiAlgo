#!/usr/bin/env node
/**
 * conform.mjs: the one command.
 *
 *   npm run conform          the fast gate. Everything that cannot go red for a
 *                            reason other than your code. Target: under 90s.
 *   npm run conform -- --deep   adds the browser: the pixel gate, the ARIA
 *                            baselines, the route sweep as four roles.
 *   npm run conform -- --list   print what each tier runs and stop.
 *
 * WHY A RUNNER AND NOT A CHAIN OF &&. Three reasons, each learned from an
 * instrument this project has already lost.
 *
 *   1. `a && b && c` stops at the first failure, so you fix one thing, run again,
 *      and learn about the next. Four rounds to see four problems. This runs every
 *      check and reports all of them at once, because the question being asked is
 *      "is it safe to ship", not "what is the first thing wrong".
 *
 *   2. Exit code 2 means COULD NOT RUN, and it must never be treated as a pass.
 *      A gate whose database was unreachable has measured nothing. The Index wrote
 *      this down as the most dangerous failure mode a suite has — looking green
 *      while measuring nothing — and a shell chain cannot tell 2 from 1.
 *
 *   3. The receipt. A green run writes .claude/.sweep-receipt.json, which the Stop
 *      hook reads to refuse a turn that calls a change done without measuring it.
 *      A receipt written by anything other than a genuinely green run is a forgery,
 *      so exactly one place writes it, and that is here.
 *
 * WHAT IS DELIBERATELY NOT IN THE FAST TIER. Anything that needs the network, a
 * provider key, money, or a browser. Those live behind --deep and in the nightly
 * run. The fast tier has to be something you actually run on every change, and the
 * moment it takes longer than making the change it stops being that.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'conform';

/** PASS / FAIL / CANNOT RUN, the contract every gate in this repo honours. */
const EXIT = { PASS: 0, FAIL: 1, CANNOT_RUN: 2 };

/**
 * The gates, cheapest first.
 *
 * Cost order is not cosmetic: a typo in a token name should tell you in half a
 * second, not four minutes into a browser run. Nothing here depends on anything
 * else here, so the order is free to be the useful one.
 */
const FAST = [
  {
    id: 'types',
    what: 'the types hold, including every <script> block inside an .astro file',
    argv: ['npm', 'run', 'check'],
    // astro check exits non-zero on error; it has no separate could-not-run code.
    note: 'This is the gate that would have caught edfc2ec — a client script reading a frontmatter identifier that no longer existed — and it was red and ignored for five commits before 2026-09-23.'
  },
  {
    id: 'unit',
    what: '1,248 tests: the libs, the components, the endpoints, the wire contracts',
    argv: ['npx', 'vitest', 'run']
  },
  {
    id: 'invariants',
    what: 'the five structural invariants, including that nothing under src/pages can be shadowed by the root api/ directory',
    argv: ['node', 'scripts/gate-invariants.mjs']
  },
  {
    id: 'dom-contracts',
    what: 'every selector a client script queries is still provided by the markup that is supposed to provide it',
    argv: ['node', 'scripts/check-dom-contracts.mjs']
  },
  {
    id: 'tokens',
    what: 'every var(--x) resolves, and the generated stylesheets match a fresh build from tokens/',
    argv: ['node', 'scripts/check-tokens.mjs']
  },
  {
    id: 'routes',
    what: 'the route manifest, regenerated and checked against the filesystem',
    argv: ['node', 'scripts/route-census.mjs']
  }
];

/**
 * Added by --deep: the browser tier. Needs a dev server, Chromium, and the test
 * database (`npm run db:test:reset` once, then it stays put).
 *
 * ONE invocation, not three. Playwright starts the dev server, mints a session per
 * role in its setup project, and runs every spec across every project in one go —
 * so splitting this into separate gates would pay for the server start and the
 * session minting three times over to buy nothing but a prettier summary. The HTML
 * report (`npm run conform:report`) breaks the result down far better than this
 * runner's one-line-per-gate ever could.
 */
const DEEP = [
  {
    id: 'browser',
    what: '209 assertions: every route as five audiences, plus 14 pixel baselines',
    argv: ['npx', 'playwright', 'test'],
    note: 'Loads every public route and every gated route as signed-out, waitlisted, member, paid and internal — asserting both that what should open, opens, and that what should refuse, refuses. Pixels only on the two authored galleries; never on a page whose content comes from the nightly sweep, which is the mistake that killed the last visual gate.'
  }
];

function run(gate) {
  const started = Date.now();
  const result = spawnSync(gate.argv[0], gate.argv.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024
  });
  const ms = Date.now() - started;

  // A gate that could not be launched at all is CANNOT_RUN, not a failure of the
  // thing it was measuring. Saying "your code is fine" because node is missing
  // would be the exact lie this file is built to refuse.
  if (result.error) {
    return { ...gate, code: EXIT.CANNOT_RUN, ms, output: `could not launch ${gate.argv.join(' ')}: ${result.error.message}` };
  }
  return {
    ...gate,
    code: result.status === null ? EXIT.CANNOT_RUN : result.status,
    ms,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd()
  };
}

const args = process.argv.slice(2);
const deep = args.includes('--deep');
const gates = deep ? [...FAST, ...DEEP] : FAST;

if (args.includes('--list')) {
  console.log(`${NAME}: the fast tier runs ${FAST.length} gates; --deep adds ${DEEP.length}.\n`);
  for (const gate of [...FAST, ...DEEP]) {
    console.log(`  ${gate.id.padEnd(14)} ${gate.what}`);
    console.log(`  ${''.padEnd(14)} $ ${gate.argv.join(' ')}`);
    if (gate.note) console.log(`  ${''.padEnd(14)} ${gate.note}`);
    console.log('');
  }
  process.exit(0);
}

console.log(`${NAME}: ${gates.length} gates${deep ? ', deep tier' : ''}. Every one runs; none short-circuits.\n`);

const results = gates.map((gate) => {
  const result = run(gate);
  const label = result.code === EXIT.PASS ? 'PASS' : result.code === EXIT.CANNOT_RUN ? 'COULD NOT RUN' : 'FAIL';
  console.log(`${label.padEnd(14)} ${result.id.padEnd(14)} ${(result.ms / 1000).toFixed(1)}s  ${result.what}`);
  return result;
});

const failed = results.filter((r) => r.code === EXIT.FAIL);
const broken = results.filter((r) => r.code === EXIT.CANNOT_RUN);

// The detail, after the summary, so the shape of the run is visible before the
// wall of output. Only for the gates that have something to say.
for (const result of [...broken, ...failed]) {
  console.log(`\n${'─'.repeat(78)}\n${result.id}: ${result.code === EXIT.CANNOT_RUN ? 'COULD NOT RUN' : 'FAILED'}\n`);
  console.log(result.output || '(no output)');
}

const total = (results.reduce((sum, r) => sum + r.ms, 0) / 1000).toFixed(1);
console.log(`\n${'═'.repeat(78)}`);

if (broken.length) {
  // Deliberately reported before failures and with its own exit code: this is the
  // state that must never be mistaken for either green or red.
  console.log(`${NAME}: ${broken.length} gate(s) COULD NOT RUN — ${broken.map((r) => r.id).join(', ')}.`);
  console.log('A gate that could not run has measured nothing. This is not a pass and it is not a failure;');
  console.log('it means the answer is unknown. Fix the instrument, then ask again.');
  process.exit(EXIT.CANNOT_RUN);
}

if (failed.length) {
  console.log(`${NAME}: RED. ${failed.length} of ${results.length} gates failed in ${total}s — ${failed.map((r) => r.id).join(', ')}.`);
  console.log('Known findings are listed in test/conform/accepted.json and are not fatal. Anything above is new.');
  process.exit(EXIT.FAIL);
}

// The receipt. Written here and nowhere else.
try {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? 'unknown';
  mkdirSync(join(ROOT, '.claude'), { recursive: true });
  writeFileSync(
    join(ROOT, '.claude', '.sweep-receipt.json'),
    JSON.stringify({ sha, at: Date.now(), green: true, gates: results.map((r) => r.id), deep }, null, 2)
  );
} catch {
  // A receipt that cannot be written does not make the run less green. The Stop
  // hook will ask again, which is the safe direction to fail in.
}

console.log(`${NAME}: GREEN. ${results.length} gates in ${total}s.`);
if (!deep) console.log('The browser gates did not run. `npm run conform -- --deep` before a push.');
process.exit(EXIT.PASS);
