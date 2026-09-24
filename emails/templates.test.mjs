import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTokens } from './lib/tokens.mjs';
import { typeRoles } from './lib/shell.mjs';
import { buildChangeEmailConfirmation } from './templates/change-email.mjs';
import { buildConfirmNudge } from './templates/confirm-nudge.mjs';
import { buildInstantAlert } from './templates/instant-alert.mjs';
import { buildNightlyReceiptEmail } from './templates/nightly-receipt.mjs';
import { buildWeeklyDigest } from './templates/weekly-digest.mjs';
import * as data from '../src/lib/data.ts';
import * as readings from '../src/lib/readings.ts';
import { SITE } from '../src/data/site.ts';
import * as nav from '../src/data/nav.ts';

/**
 * Four invariants, across every template in emails/templates/, that no
 * existing test in this directory checks:
 *
 *   1. every template produces non-empty output;
 *   2. every literal hex colour and px length in that output is one the
 *      compiled token pipeline actually produced (see emails/lib/tokens.mjs),
 *      not a hand-typed value silently drifted from it;
 *   3. no template leaks an unresolved value into what a reader sees
 *      ("undefined", "NaN", "[object Object]");
 *   4. every href is absolute, or is one of the two documented merge fields
 *      the sending platform substitutes (emails/README.md, "beehiiv").
 *
 * confirm-nudge.mjs and weekly-digest.mjs already have their own test files
 * covering the copy and the selection logic; this file does not repeat that.
 * All five templates get the same four structural checks here, because none
 * of the five had them before today (vitest.config.ts excluded this whole
 * directory until this change — see that file's own comment).
 *
 * Per emails/lib/tokens.mjs's own header, the shared builder already threads
 * every visual value through `t.raw()` / `t.px()` — the templates never write
 * a hex code or a px number by hand for anything the design ramp owns. So
 * check #2 below asserts the threading (every literal actually resolves back
 * to something the compiled tokens.css produces) rather than restating any
 * value, exactly as this task's own instructions ask when a shared builder
 * already exists.
 */

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const TOKENS_CSS = resolve(REPO, 'src/styles/tokens.css');
const t = loadTokens(TOKENS_CSS);
const roles = typeRoles(t);
const merge = { unsubscribeTag: '{{unsubscribe_url}}', manageTag: '{{preferences_url}}' };
// src/data/nav.ts's own header records that its ECOSYSTEM export was removed
// in a concurrent change while emails/lib/parts.mjs's footer() (untouched by
// this task) still reads it; stubbing it here is the same test-isolation
// workaround emails/templates/weekly-digest.test.mjs already applies, not a
// change to the behaviour under test.
const navStub = { ...nav, ECOSYSTEM: nav.ECOSYSTEM ?? [] };

// ---------------------------------------------------------------------------
// Token-drift detection: every hex colour and px length the compiled token
// file can actually produce, computed from the file itself rather than
// retyped, so this test cannot drift from tokens.css the same way a template
// could.
// ---------------------------------------------------------------------------

/** Every literal hex value any declaration in tokens.css resolves to. */
function tokenHexValues(tokens) {
  const set = new Set();
  for (const key of tokens.declarations.keys()) {
    let value;
    try {
      value = tokens.raw(key);
    } catch {
      continue;
    }
    for (const match of value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      set.add(match[0].toLowerCase());
    }
  }
  return set;
}

/** Every whole-pixel value tokens.css's own length tokens convert to. */
function tokenPxValues(tokens) {
  const set = new Set();
  for (const key of tokens.declarations.keys()) {
    try {
      set.add(tokens.px(key));
    } catch {
      // Not a length token (a colour, a font stack, a curve, a bare weight).
    }
  }
  return set;
}

/**
 * The five type roles' own px values (font-size, and line-height computed as
 * `round(size_px * leading)` — emails/lib/shell.mjs's typeRoles()). A
 * line-height is not itself one token's px() output, it is two tokens
 * multiplied, so it will never appear in tokenPxValues() above even though it
 * is fully threaded. `roles` is the same object every template in this file
 * renders with, so reading real px values back out of it — rather than
 * re-deriving the multiplication by hand here — is asserting the threading,
 * not restating it.
 */
function rolePxValues(rolesObject) {
  const set = new Set();
  for (const declarations of Object.values(rolesObject)) {
    for (const value of Object.values(declarations)) {
      const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value));
      if (match) set.add(Math.round(Number(match[1])));
    }
  }
  return set;
}

const TOKEN_HEX = tokenHexValues(t);
const TOKEN_PX = new Set([...tokenPxValues(t), ...rolePxValues(roles)]);

/** Strips CSS and HTML comments, so a number mentioned in prose explaining a
 *  design decision (shell.mjs's own `document_()` carries one, about a
 *  measurement at 476px) is never mistaken for a rendered value. */
function withoutComments(html) {
  return html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * The only px numbers in these five templates' rendered output that do not,
 * and should not, come from the design ramp: fixed mail-client and table
 * dimensions, each with its own justifying comment at the cited line.
 *
 *   600  emails/lib/shell.mjs EMAIL_WIDTH — "a mail client constraint, not a
 *        design value... no token owns it," per that constant's own comment.
 *   620  emails/lib/shell.mjs's `@media (max-width: 620px)` — Outlook's own
 *        reading-pane breakpoint, the same species of literal as EMAIL_WIDTH.
 *   110  emails/lib/parts.mjs factLine()'s fixed label column.
 *   90   emails/templates/instant-alert.mjs's own fixed score column.
 *
 * Not listed here because they are not actually exceptions: the preview
 * line's 1px hack (shell.mjs) equals --border-hairline, and jobRow()'s 64px
 * fit column (parts.mjs) equals --space-800 — both already members of
 * TOKEN_PX, so they need no allowance and this test would still catch it if
 * either token's value ever changed out from under that coincidence.
 */
const STRUCTURAL_PX = new Set([600, 620, 110, 90]);

/** Every hex colour in `html`/`text`, ignoring numeric HTML entities like
 *  `&#8203;` or `&#183;`, whose digits are valid hex and would otherwise
 *  read as a 3-4 digit colour. */
function hexColoursIn(output) {
  return [...output.matchAll(/(?<!&)#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
}

/** Every `NNpx` literal in `output`. */
function pxLengthsIn(output) {
  return [...output.matchAll(/\b(\d+)px\b/g)].map((m) => Number(m[1]));
}

function assertTokensThreaded(built, label) {
  for (const surface of [withoutComments(built.html), built.text ?? '']) {
    for (const hex of hexColoursIn(surface)) {
      expect(TOKEN_HEX.has(hex), `${label}: "${hex}" is not a colour tokens.css produces — it has drifted from the token pipeline`).toBe(
        true
      );
    }
    for (const px of pxLengthsIn(surface)) {
      const ok = TOKEN_PX.has(px) || STRUCTURAL_PX.has(px);
      expect(
        ok,
        `${label}: "${px}px" is neither a value tokens.css's length tokens produce nor a documented structural literal — it has drifted, or is a new magic number that needs one or the other`
      ).toBe(true);
    }
  }
}

function assertNoLeakedValue(built, label) {
  for (const [name, surface] of [
    ['subject', built.subject],
    ['preheader', built.preheader ?? ''],
    ['html', built.html],
    ['text', built.text ?? '']
  ]) {
    expect(surface, `${label}.${name} is empty`).toBeTruthy();
    expect(String(surface).includes('undefined'), `${label}.${name} interpolated an undefined value`).toBe(false);
    expect(String(surface).includes('NaN'), `${label}.${name} interpolated NaN`).toBe(false);
    expect(String(surface).includes('[object Object]'), `${label}.${name} interpolated an unstringified object`).toBe(false);
  }
}

/** Every `href="..."` in an HTML fragment. */
function hrefsIn(html) {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

function assertLinksAbsolute(built, label) {
  // nightly-receipt.mjs's own header states it carries none: "There is no
  // unsubscribe, no manage link, no ecosystem band: those belong to a reader
  // who asked to be on a list, and nobody asked to be on this one." Zero
  // links is that template's correct, documented state, not a fixture gap.
  const hrefs = hrefsIn(built.html);
  for (const href of hrefs) {
    // The two merge fields README.md's "beehiiv" section names: substituted
    // by the sending platform at send time, not a link this template resolves.
    if (href === merge.unsubscribeTag || href === merge.manageTag) continue;
    const absolute = /^https?:\/\//.test(href) || href.startsWith('mailto:');
    expect(absolute, `${label}: href "${href}" is not absolute — a relative href in an inbox resolves against the webmail host or nowhere`).toBe(
      true
    );
  }
}

/** Every template except nightly-receipt.mjs (see assertLinksAbsolute's own
 *  comment) is expected to actually link somewhere; this guards against a
 *  fixture that silently exercises none of a template's markup. */
function assertHasLinks(built, label) {
  expect(hrefsIn(built.html).length, `${label}: no links rendered — the fixture is not exercising this template's markup`).toBeGreaterThan(0);
}

function assertNonEmptyAndSane(built, label) {
  assertNoLeakedValue(built, label);
  assertTokensThreaded(built, label);
  assertLinksAbsolute(built, label);
}

// ---------------------------------------------------------------------------
// change-email.mjs — no shared `data` module; a transactional fixture only.
// ---------------------------------------------------------------------------
describe('buildChangeEmailConfirmation', () => {
  const built = buildChangeEmailConfirmation({
    t,
    roles,
    site: SITE,
    oldEmail: 'ryan@old-address.example.com',
    newEmail: 'ryan@new-address.example.com',
    confirmUrl: `${SITE.url}/verify-email?token=fixture-token`
  });

  it('produces sane, token-clean, fully-linked output', () => {
    assertNonEmptyAndSane(built, 'buildChangeEmailConfirmation');
    assertHasLinks(built, 'buildChangeEmailConfirmation');
  });

  it('names both addresses in both parts', () => {
    expect(built.html).toContain('ryan@old-address.example.com');
    expect(built.html).toContain('ryan@new-address.example.com');
    expect(built.text).toContain('ryan@old-address.example.com');
    expect(built.text).toContain('ryan@new-address.example.com');
  });
});

// ---------------------------------------------------------------------------
// confirm-nudge.mjs — already covered for copy/selection by
// confirm-nudge.test.mjs; here only for the four structural checks.
// ---------------------------------------------------------------------------
describe('buildConfirmNudge (structural checks only — see confirm-nudge.test.mjs for copy)', () => {
  const built = buildConfirmNudge({
    t,
    roles,
    site: SITE,
    pending: [
      { title: 'Staff Product Designer', company: 'Ambience', days: 5 },
      { title: null, company: null, days: 1 }
    ],
    deskUrl: `${SITE.url}/desk`
  });

  it('produces sane, token-clean, fully-linked output', () => {
    assertNonEmptyAndSane(built, 'buildConfirmNudge');
    assertHasLinks(built, 'buildConfirmNudge');
  });
});

// ---------------------------------------------------------------------------
// instant-alert.mjs — against the real fixtures, the same way
// weekly-digest.test.mjs exercises weekly-digest.mjs.
// ---------------------------------------------------------------------------
describe('buildInstantAlert', () => {
  const built = buildInstantAlert({ t, roles, data, site: SITE, nav: navStub, merge });

  it('produces sane, token-clean, fully-linked output', () => {
    assertNonEmptyAndSane(built, 'buildInstantAlert');
    assertHasLinks(built, 'buildInstantAlert');
  });

  it('carries a fit score and a rubric breakdown', () => {
    expect(built.html).toContain('Fit of 100');
    expect(built.text).toContain('WHY IT MATCHED');
  });
});

// ---------------------------------------------------------------------------
// nightly-receipt.mjs — the operator report. Its own header explains it is
// deliberately NOT built by any script this repo has yet (see that file's
// "WHY THIS TEMPLATE IS NOT IN scripts/build-emails.mjs's EMAILS MAP"), so
// there is no existing model-builder to import; the fixture below states
// every field the template itself reads (grep buildNightlyReceiptEmail for
// `model.`), nothing more.
// ---------------------------------------------------------------------------
describe('buildNightlyReceiptEmail', () => {
  const plainText = [
    'THE INDEX / NIGHTLY RECEIPT',
    'Swept 2026-09-24T07:30:00Z',
    'Boards 45 / Pulled 64 / Verified live 64 / Killed 0',
    'No alarms.'
  ].join('\n');

  const model = {
    sweptAtUtc: '2026-09-24T07:30:00Z',
    generatedAtUtc: '2026-09-24T07:41:12Z',
    ageLine: 'Read 11 minutes after the sweep finished.',
    counts: {
      boards: 45,
      postingsObserved: 64,
      pulled: 64,
      verifiedLive: 64,
      killed: 0,
      killedUnattributed: 0,
      killedByRule: [
        ['stale-90d', 0],
        ['404-on-recheck', 0]
      ]
    },
    boardFailures: [],
    changeLine: 'No change against last night: 64 verified live both nights.',
    medianLine: 'Seven day trailing median: 61 verified live.',
    buildLine: 'Build: green.',
    gatesLine: '6 of 6 gates passed.',
    gates: {
      list: [
        { id: 'types', verdict: 'pass' },
        { id: 'unit', verdict: 'pass' }
      ]
    },
    decisionsLine: 'No decisions pending.',
    decisions: { headings: [] },
    alarms: [],
    footerLine: 'Generated by the nightly pipeline, read by the operator only.'
  };

  const built = buildNightlyReceiptEmail({ t, roles, site: SITE, model, plainText });

  it('produces sane, token-clean, fully-linked output', () => {
    assertNonEmptyAndSane(built, 'buildNightlyReceiptEmail');
  });

  it('reuses the exact plain-text receipt as its text part, not a second rendering of it', () => {
    expect(built.text).toBe(plainText);
  });

  it('an alarm renders in the alarm colour, not silently dropped', () => {
    const withAlarm = buildNightlyReceiptEmail({
      t,
      roles,
      site: SITE,
      model: { ...model, alarms: [{ code: 'BOARD-TIMEOUT', text: 'One board did not answer within the timeout.' }] },
      plainText
    });
    assertNonEmptyAndSane(withAlarm, 'buildNightlyReceiptEmail (with alarm)');
    expect(withAlarm.html).toContain('BOARD-TIMEOUT');
    expect(withAlarm.html).toContain('1 alarm');
  });
});

// ---------------------------------------------------------------------------
// weekly-digest.mjs — already covered in depth by weekly-digest.test.mjs;
// here only for the four structural checks, on both the normal and the
// empty-week path, since the two produce meaningfully different markup.
// ---------------------------------------------------------------------------
describe('buildWeeklyDigest (structural checks only — see weekly-digest.test.mjs for selection logic)', () => {
  it('the normal path produces sane, token-clean, fully-linked output', () => {
    const built = buildWeeklyDigest({ t, roles, data, readings, site: SITE, nav: navStub, merge });
    expect(built.send).toBe(true);
    assertNonEmptyAndSane(built, 'buildWeeklyDigest');
    assertHasLinks(built, 'buildWeeklyDigest');
  });

  it('the empty-week sentinel also produces sane, token-clean, fully-linked output', () => {
    const emptyData = {
      sweepDate: () => '2026-08-23',
      sweptStamp: () => 'Aug 23, 2026, 07:30 UTC',
      sweptAt: () => '2026-08-23T07:30:02Z',
      daysBetween: data.daysBetween,
      formatDate: data.formatDate,
      verifiedJobs: () => [],
      sortJobs: () => [],
      loadKills: () => [],
      killArchive: () => [],
      loadJobs: () => [],
      loadStats: () => ({
        swept_at_utc: '2026-08-23T07:30:02Z',
        boards: 0,
        pulled: 0,
        verified_live: 0,
        killed: 0,
        killed_by_rule: {},
        killed_unattributed: 0
      })
    };
    const built = buildWeeklyDigest({ t, roles, data: emptyData, readings, site: SITE, nav: navStub, merge });
    expect(built.send).toBe(false);
    assertNonEmptyAndSane(built, 'buildWeeklyDigest (empty week)');
    assertHasLinks(built, 'buildWeeklyDigest (empty week)');
  });
});
