/**
 * The gate registry: one place that knows every gate, how to run each one
 * against the real build, and how to run each one against the fixture that
 * proves it can fail.
 *
 * WHY A REGISTRY RATHER THAN TWO LISTS
 * conform (does the site pass?) and conform:prove (can the gates fail?) have to
 * agree about what "the gates" means. Two hand kept lists drift the moment a
 * seventh gate lands, and the drift is silent: the new gate would run in conform
 * and never be proved, which is exactly the decoration BUILD.md warns about.
 * One list, imported by both runners, makes that impossible.
 *
 * The seventh gate landed on 2026-08-23 and the arrangement held: gate 11, pii,
 * was registered here once and both runners picked it up with no other edit.
 * What did NOT hold was every sentence elsewhere that had counted to six by
 * hand, including the line conform printed at the end of a passing run, which
 * announced six independent measurements while seven were running. Those are
 * fixed and read from this array now. The lesson is the one this header already
 * made: a number worth trusting is derived, never typed.
 *
 * WHY EACH GATE HAS ITS OWN FIXTURE FLAG SPELLING
 * The gates were written independently and each author chose a flag that
 * reads well for that gate's subject: a11y and copy and truth and motion take a
 * tree root, perf takes a dist, visual takes a bundle holding both a site and
 * its baselines. Normalising them would mean editing six working scripts to buy
 * nothing but symmetry in this file. The spelling difference is recorded here
 * instead, once, where it costs nothing.
 *
WHICH TREE EACH GATE JUDGES
 * Two builds exist, and the difference is not cosmetic. `npm run build` emits
 * what ships. `npm run build:gated` emits the same site plus /_specimen and
 * /_states, the two review surfaces astro.config injects under SPECIMEN=1,
 * which no visitor can reach and the route census separately proves are absent
 * from production.
 *
 * Pointing every gate at the gated tree, which is what this file used to do,
 * asked the gates that judge published truth to judge a rehearsal. They did
 * their job: gate 2 reported that /_states prints a date the sweep data does
 * not contain, and gate 11 reported an email address on it. Both were reading
 * deliberate placeholder content on a page that never ships, so both were
 * right about the rule and pointed at the wrong page, and the conformance run
 * had been red on it long enough that nobody had seen the steps behind it.
 *
 * So each gate now declares its subject:
 *
 *   'production'  what a visitor can load. Every gate that judges whether the
 *                 site tells the truth reads this, because a claim on a page
 *                 nobody can reach is not a claim the site is making.
 *   'review'      the gated tree, which is production plus the two review
 *                 surfaces. The four browser gates read this, because the
 *                 specimen is a design deliverable in its own right and has to
 *                 be accessible, motion-safe and within budget like any page.
 *
 * A gate that reads neither tree (it works off src/ and its own fixtures)
 * declares no subject and is handed no root.
 *
 * HOW A GATE IS POINTED AT ITS SUBJECT, WHICH IS NOT THE SAME FOR ALL OF THEM.
 * The four browser gates take a directory of built pages, so they carry a
 * `root` here and conform hands them dist-review/client. The three production
 * gates take a REPO-SHAPED root instead (a tree holding src/data/ and dist/)
 * and resolve the build themselves, which is why their should-fail fixtures
 * hold both directories. Handing one of those a page directory does not point
 * it somewhere else, it breaks it: it looked for dist/client/src/data/jobs.json
 * and refused to run. So they carry no `root` and read dist/ where they always
 * did, and what makes that correct is that dist/ is the production build.
 *
 * "Is by construction" is the kind of claim that stops being true quietly, so
 * test/conform.mjs asserts it rather than trusting it: before any gate runs it
 * checks that the production tree does NOT hold the review routes and that the
 * review tree does. Building the gated site into dist/ is precisely how this
 * went wrong, and now it is caught in the first second of a run instead of
 * three gates later.
 *
 * ORDER IS COST ORDER, CHEAPEST FIRST
 * copy needs nothing but the filesystem. truth needs the network but no
 * browser. The last four each start Chromium. Running them cheapest first means
 * a typo in the copy fails in under a second instead of four minutes later, and
 * it means a developer watching the output learns the most likely problem
 * first. Nothing depends on the order otherwise: the gates share no state.
 */

/**
 * @typedef {object} Gate
 * @property {number} number     the gate's number in BUILD.md, so output can be read against the brief
 * @property {string} id         the npm script suffix: npm run gate:<id>
 * @property {string} name       what the gate asserts, in one phrase
 * @property {string[]} run      argv for the real build check, after "node"
 * @property {string[]} prove    argv for the should-fail fixture check, after "node"
 * @property {string} fixture    the fixture directory, for the message when it is missing
 * @property {boolean} browser   true if the gate launches Chromium, which is what makes it slow
 * @property {string} [retired]  the date this gate stopped running. A retired gate is kept in this registry
 *                               so /colophon can go on describing it and say plainly that it no longer runs.
 *                               It has no run or prove argv: the runners skip it.
 * @property {'production'|'review'} [tree]  which built tree this gate judges; omitted where it reads no build
 * @property {(root: string) => string[]} [root]  how this gate is pointed at that tree, since the flag spelling differs per gate
 */

/** @type {Gate[]} */
export const GATES = [
  {
    number: 3,
    id: 'copy',
    name: 'copy lint: banned characters and banned vocabulary',
    run: ['test/gates/copy.mjs'],
    prove: ['test/gates/copy.mjs', '--root', 'test/fixtures/should-fail/copy'],
    fixture: 'test/fixtures/should-fail/copy',
    browser: false,
  },
  {
    number: 2,
    id: 'truth',
    name: 'truth: every rendered number traces to the data or to a sourced fact',
    run: ['test/gates/truth.mjs'],
    prove: ['test/gates/truth.mjs', '--root', 'test/fixtures/should-fail/truth'],
    fixture: 'test/fixtures/should-fail/truth',
    browser: false,
    tree: 'production',
  },
  {
    number: 11,
    id: 'pii',
    name: 'pii: no person-table value or shape reaches a static file',
    run: ['test/gates/pii.mjs'],
    prove: ['test/gates/pii.mjs', '--root', 'test/fixtures/should-fail/pii'],
    fixture: 'test/fixtures/should-fail/pii',
    browser: false,
    tree: 'production',
  },
  {
    // Landed the same way gate 11 did: appended after the existing
    // filesystem-only gates rather than reordering them, because it needs
    // only the filesystem and no network, the same cost class as copy and
    // pii above.
    number: 8,
    id: 'provenance',
    name: 'provenance: renders never alter the immutable core, every core field traces to the schema',
    run: ['test/gates/provenance.mjs'],
    prove: ['test/gates/provenance.mjs', '--root', 'test/fixtures/should-fail/provenance'],
    fixture: 'test/fixtures/should-fail/provenance',
    browser: false,
  },
  {
    // Landed the same way gate 8 and gate 11 did: appended after the
    // existing filesystem-only gates rather than reordering them, because
    // it needs only the filesystem, real functions imported straight out
    // of src/lib, and no network, the same cost class as copy, pii and
    // provenance above.
    number: 9,
    id: 'fabrication',
    name: 'fabrication: 20+ adversarial scenarios, every channel, fail closed',
    run: ['test/gates/fabrication.mjs'],
    prove: ['test/gates/fabrication.mjs', '--root', 'test/fixtures/should-fail/fabrication'],
    fixture: 'test/fixtures/should-fail/fabrication',
    browser: false,
  },
  {
    // Landed the same way gate 8, 9 and 11 did: appended after the existing
    // filesystem-only gates rather than reordering them, because it needs
    // only the filesystem, no browser and no network, the same cost class as
    // copy, truth, pii, provenance and fabrication above.
    number: 10,
    id: 'population',
    name: 'population: every count on a page reconciles to one stated population',
    run: ['test/gates/population.mjs'],
    prove: ['test/gates/population.mjs', '--root', 'test/fixtures/should-fail/population'],
    fixture: 'test/fixtures/should-fail/population',
    browser: false,
    tree: 'production',
  },
  {
    // Landed the same way gates 8, 9, 10 and 11 did: appended among the
    // filesystem-only gates, because it needs only the filesystem, the real
    // functions imported out of src/lib, and no browser and no network. It
    // renders a fixture record through the real tailor and the real PDF writer,
    // re-extracts with the real resume-extract, and proves the drafted-resume
    // PDF preserves every field, hides no text, and sets truthful metadata.
    number: 12,
    id: 'parse-proof',
    name: 'parse-proof: the resume PDF re-extracts byte-intact, hides no text, states truthful metadata',
    run: ['test/gates/parse-proof.mjs'],
    prove: ['test/gates/parse-proof.mjs', '--root', 'test/fixtures/should-fail/parse-proof'],
    fixture: 'test/fixtures/should-fail/parse-proof',
    browser: false,
  },
  {
    number: 1,
    id: 'a11y',
    name: 'accessibility: axe-core, every route, both themes, two viewports',
    run: ['test/gates/a11y.mjs'],
    prove: ['test/gates/a11y.mjs', '--root', 'test/fixtures/should-fail/a11y'],
    fixture: 'test/fixtures/should-fail/a11y',
    browser: true,
    tree: 'review',
    root: (dir) => ['--root', dir],
  },
  {
    number: 6,
    id: 'motion',
    name: 'motion: runs once, under 400ms, absent under reduced motion',
    // --require-signature turns the absence of the signature moment from a
    // PENDING note into a failure. It was always the plan: gate 6's own
    // decision entry says the flag goes into the conform invocation the moment
    // phase 3 lands the moment, because until then the gate proved the
    // reduced-motion half and the "runs once" half had nothing to run against.
    // The moment landed on 2026-08-17 (the verification rule on the index
    // table's assurance band), so the flag is here permanently. Without it this
    // gate would pass a site that quietly deleted its one animation.
    run: ['test/gates/motion.mjs', '--require-signature'],
    prove: ['test/gates/motion.mjs', '--root=test/fixtures/should-fail/motion'],
    fixture: 'test/fixtures/should-fail/motion',
    browser: true,
    tree: 'review',
    root: (dir) => [`--root=${dir}`],
  },
  {
    // RETIRED 2026-09-06, kept here on purpose. The gate is gone: its script,
    // its 60 baselines and its should-fail fixture are deleted, and nothing
    // runs it. It stays in this registry because /colophon builds its gate list
    // from here, and the owner's ruling is that the page goes on carrying the
    // paragraph describing what this gate did. A retired entry is how the page
    // keeps that copy without claiming a verdict for something that did not
    // run. See DECISIONS.md, 2026-09-06.
    number: 5,
    id: 'visual',
    name: 'visual: screenshots match committed baselines',
    retired: '2026-09-06',
    run: [],
    prove: [],
    fixture: '',
    browser: false,
  },
  {
    number: 4,
    id: 'perf',
    name: 'performance: Lighthouse scores and the 150 KiB transfer budget',
    run: ['test/gates/perf.mjs'],
    prove: ['test/gates/perf.mjs', '--dist=test/fixtures/should-fail/perf'],
    fixture: 'test/fixtures/should-fail/perf',
    browser: true,
    tree: 'review',
    root: (dir) => [`--dist=${dir}`],
  },
];

/**
 * What a gate's exit code means. All six agreed on this contract independently,
 * and both runners depend on it, so it is written down once here.
 *
 * The distinction that matters is 2. A gate that could not run has measured
 * nothing, and the dangerous failure mode for any test suite is looking green
 * when it measured nothing. Neither runner is allowed to treat 2 as a pass.
 */
export const EXIT = {
  PASS: 0,
  FAIL: 1,
  CANNOT_RUN: 2,
};

/** Left pad the gate label so the summary lines up without a table library. */
export function label(gate) {
  return `gate ${gate.number} (${gate.id})`.padEnd(20);
}
