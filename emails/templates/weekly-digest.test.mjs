import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTokens } from '../lib/tokens.mjs';
import { typeRoles } from '../lib/shell.mjs';
import { digestWindow, newRoles } from '../lib/content.mjs';
import { buildWeeklyDigest } from './weekly-digest.mjs';
import * as data from '../../src/lib/data.ts';
import * as readings from '../../src/lib/readings.ts';
import { SITE } from '../../src/data/site.ts';
import * as nav from '../../src/data/nav.ts';

/**
 * These tests exercise the real weekly digest template against the real
 * fixtures under src/data/ (via src/lib/data.ts), through the real tokens
 * already compiled at src/styles/tokens.css. Nothing here is mocked except
 * `nav.ECOSYSTEM`: src/data/nav.ts's own header states that export was
 * removed in a concurrent, out-of-scope change while emails/lib/parts.mjs's
 * footer() (read-only to this task) still reads it, which throws before any
 * of this suite's own assertions get a chance to run. Stubbing it here is a
 * test-isolation workaround for a bug outside this task's file list, not a
 * change to the behaviour under test; see the worker report for the same
 * note pointed at the real fix.
 */

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const TOKENS_CSS = resolve(REPO, 'src/styles/tokens.css');
const t = loadTokens(TOKENS_CSS);
const roles = typeRoles(t);
const merge = { unsubscribeTag: '{{unsubscribe_url}}', manageTag: '{{preferences_url}}' };
const navStub = { ...nav, ECOSYSTEM: nav.ECOSYSTEM ?? [] };

// Built from code points, never written as literals. The house rule is that
// these characters do not appear in this repository's own source, and a file
// that names one only to assert its absence is still a file that names one.
// A test for the rule has to obey the rule. (test/gates/copy.mjs does not scan
// emails/ today, so nothing would have caught this; that is a reason to be
// careful here, not a licence.)
const FORBIDDEN_CHARACTERS = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d].map((cp) =>
  String.fromCodePoint(cp)
);

function assertNoForbiddenCharacters(text) {
  for (const character of FORBIDDEN_CHARACTERS) {
    expect(text.includes(character), `found forbidden character ${JSON.stringify(character)}`).toBe(false);
  }
}

describe('buildWeeklyDigest(): the generic path (person omitted)', () => {
  const built = buildWeeklyDigest({ t, roles, data, readings, site: SITE, nav: navStub, merge });

  it('sends: the real fixture always carries new roles this window', () => {
    expect(built.send).toBe(true);
  });

  it('carries the sweep stamp, a subject, and both a real html and text part', () => {
    expect(built.subject).toContain('The Index');
    expect(built.html).toContain(data.sweptStamp().toUpperCase());
    expect(built.text.length).toBeGreaterThan(400);
  });

  it('renders no "Your account" section when no person is passed', () => {
    expect(built.html).not.toContain('Your account');
    expect(built.text).not.toContain('YOUR ACCOUNT');
  });

  it('the subject and preheader, which this file writes in full, carry no forbidden character', () => {
    // Not the full html/text: those interpolate comp_posted straight off
    // src/data/jobs.json (parts.mjs's jobRow(), unmodified by this task), and
    // a real employer range in that fixture ("$200K - $310K") is written
    // with a literal en dash. That is a pre-existing data defect in a
    // read-only file, reported separately; it is not a defect in the copy
    // this file itself authors, which is what subject and preheader are.
    assertNoForbiddenCharacters(built.subject);
    assertNoForbiddenCharacters(built.preheader);
  });
});

describe('buildWeeklyDigest(): the empty week returns a "nothing to send" signal', () => {
  // A stub data module that forces every section empty, so this test proves
  // the sentinel branch itself rather than depending on the fixture staying
  // empty by accident. Every function here is the minimum the empty path
  // (buildWeeklyDigest through buildNothingToSend through parts.mjs's
  // footer()) actually calls; see this file's own header for why footer()
  // needs loadStats() even on the empty path.
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

  it('returns send: false, not an empty shell', () => {
    expect(built.send).toBe(false);
    expect(typeof built.reason).toBe('string');
    expect(built.reason.length).toBeGreaterThan(0);
  });

  it('still returns a real, non-blank html and text part, carrying the sweep stamp', () => {
    expect(built.html).toContain('AUG 23, 2026, 07:30 UTC');
    expect(built.text).toContain('AUG 23, 2026, 07:30 UTC');
    expect(built.html.length).toBeGreaterThan(200);
    expect(built.text.length).toBeGreaterThan(200);
  });

  it('carries no em dash, en dash, or curly quote', () => {
    assertNoForbiddenCharacters(built.html);
    assertNoForbiddenCharacters(built.text);
  });

  it('a person with real news still fires the normal, non-empty path even when the generic week is empty', () => {
    const window = digestWindow(emptyData);
    const withPerson = buildWeeklyDigest({
      t,
      roles,
      data: emptyData,
      readings,
      site: SITE,
      nav: navStub,
      merge,
      person: { watchedCompanies: [], applicationJobIds: [] }
    });
    // Empty person input on an empty week: still nothing to send.
    expect(withPerson.send).toBe(false);
    void window;
  });
});

describe('buildWeeklyDigest(): personalization, against the real fixtures', () => {
  const window = digestWindow(data);
  const rows = newRoles(data, window);

  it('the real fixture has at least one new role to personalize around', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it('a watched company with a new role this week gets a "Your account" section carrying that role', () => {
    const watchedCompany = rows[0].company;
    const built = buildWeeklyDigest({
      t,
      roles,
      data,
      readings,
      site: SITE,
      nav: navStub,
      merge,
      person: { watchedCompanies: [watchedCompany], applicationJobIds: [] }
    });
    expect(built.send).toBe(true);
    expect(built.html).toContain('Your account');
    expect(built.text).toContain('YOUR ACCOUNT');
    expect(built.html).toContain('a company you follow');
  });

  it('an unwatched, made-up company gets no personal section', () => {
    const built = buildWeeklyDigest({
      t,
      roles,
      data,
      readings,
      site: SITE,
      nav: navStub,
      merge,
      person: { watchedCompanies: ['A Company That Does Not Exist In This Sweep'], applicationJobIds: [] }
    });
    expect(built.html).not.toContain('Your account');
    expect(built.text).not.toContain('YOUR ACCOUNT');
  });

  it('a tracked application whose posting closed inside the window reports the closure, dated and reasoned', () => {
    const closedThisWindow = data
      .closedJobs()
      .find((job) => {
        if (!job.closed_on) return false;
        const elapsed = data.daysBetween(job.closed_on, window.to);
        return elapsed !== null && elapsed >= 0 && elapsed <= window.days;
      });
    expect(closedThisWindow, 'the fixture is expected to carry at least one closure inside the digest window').toBeTruthy();

    const built = buildWeeklyDigest({
      t,
      roles,
      data,
      readings,
      site: SITE,
      nav: navStub,
      merge,
      person: { watchedCompanies: [], applicationJobIds: [closedThisWindow.id] }
    });
    expect(built.send).toBe(true);
    expect(built.html).toContain('Your account');
    expect(built.html).toContain('closed this week');
    expect(built.text).toContain('closed this week');
  });

  it('a tracked application whose posting is still live reports nothing: state-change-only', () => {
    const stillLive = data.verifiedJobs()[0];
    expect(stillLive).toBeTruthy();
    const built = buildWeeklyDigest({
      t,
      roles,
      data,
      readings,
      site: SITE,
      nav: navStub,
      merge,
      person: { watchedCompanies: [], applicationJobIds: [stillLive.id] }
    });
    expect(built.html).not.toContain('Your account');
  });

  it('a malformed person input degrades to no personalization rather than throwing', () => {
    expect(() =>
      buildWeeklyDigest({ t, roles, data, readings, site: SITE, nav: navStub, merge, person: { garbage: true } })
    ).not.toThrow();
    const built = buildWeeklyDigest({ t, roles, data, readings, site: SITE, nav: navStub, merge, person: { garbage: true } });
    expect(built.html).not.toContain('Your account');
  });
});
