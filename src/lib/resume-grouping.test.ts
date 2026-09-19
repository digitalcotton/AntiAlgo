import { describe, expect, it } from 'vitest';
import { groupResumeSection, type ResumeGroup } from './resume-grouping';
import type { RenderEntry, RenderSection } from './tailor';
import type { EntryKind } from './record';

/**
 * The credential fold (resume-grouping.ts). It is presentation only: every
 * entry, every core, and every provenance id survives, so these tests pin that
 * a wall of same-issuer thin credentials becomes one group that still names
 * each title and cites each id, while anything substantial or lone is left
 * alone. The issuer is read from the employer field when set, else from the
 * lone bullet, because a certification commonly leaves employer null and names
 * the issuing body in its description (which renders as that bullet).
 */

function entry(overrides: {
  prfId: string;
  kind?: EntryKind;
  title: string;
  employer?: string | null;
  /** The single bullet's text, where a certification's issuer lives when the
      employer field is null. */
  bulletText?: string;
  /** null for an undated credential (db/204); absent for the default 2017 start. */
  start?: { year: number; month?: number } | null;
  end?: { year: number; month?: number } | null;
}): RenderEntry {
  const bullets = overrides.bulletText ? [{ text: overrides.bulletText, sourcePrfIds: [overrides.prfId] }] : [];
  return {
    prfId: overrides.prfId,
    kind: overrides.kind ?? 'recognition',
    core: {
      employerOrInstitution: overrides.employer ?? null,
      officialTitle: overrides.title,
      start: overrides.start === undefined ? { year: 2017, month: 1 } : overrides.start,
      end: overrides.end === undefined ? null : overrides.end
    },
    descriptiveTitle: null,
    bullets
  } as unknown as RenderEntry;
}

function section(kind: EntryKind, entries: RenderEntry[]): RenderSection {
  return { kind, heading: 'Recognition', entries };
}

// A certification: employer null, the issuer in the single bullet, exactly the
// shape a recognition entry has in the record (db/004).
const CERT = (n: number, title: string, issuer = 'International Scrum Institute') =>
  entry({ prfId: `PRF-00${n}`, title, employer: null, bulletText: issuer, start: { year: 2017, month: 1 } });

describe('groupResumeSection(): folds a wall, leaves substance', () => {
  it('folds three or more same-issuer thin credentials, keyed on the bullet when employer is null', () => {
    const rows = groupResumeSection(
      section('recognition', [CERT(8, 'Scrum Master'), CERT(9, 'Scrum Coach'), CERT(10, 'Scrum Trainer')])
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('group');
    const group = (rows[0] as { group: ResumeGroup }).group;
    expect(group.issuer).toBe('International Scrum Institute');
    expect(group.titles).toEqual(['Scrum Master', 'Scrum Coach', 'Scrum Trainer']);
    expect(group.prfIds).toEqual(['PRF-008', 'PRF-009', 'PRF-0010']);
  });

  it('also folds when the issuer is in the employer field', () => {
    const rows = groupResumeSection(
      section('recognition', [
        entry({ prfId: 'PRF-1', title: 'A', employer: 'Body' }),
        entry({ prfId: 'PRF-2', title: 'B', employer: 'Body' }),
        entry({ prfId: 'PRF-3', title: 'C', employer: 'Body' })
      ])
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { group: ResumeGroup }).group.issuer).toBe('Body');
  });

  it('keys the same issuer across a mixed-shape record (employer vs bullet, punctuation and all)', () => {
    // Mid-migration: some entries carry the issuer in the employer field, some
    // still in the renderer-punctuated bullet. All must land in ONE group.
    const rows = groupResumeSection(
      section('recognition', [
        entry({ prfId: 'PRF-1', title: 'A', employer: 'International Scrum Institute' }),
        entry({ prfId: 'PRF-2', title: 'B', employer: null, bulletText: 'International Scrum Institute.' }),
        entry({ prfId: 'PRF-3', title: 'C', employer: 'International Scrum Institute' })
      ])
    );
    expect(rows).toHaveLength(1);
    const group = (rows[0] as { group: ResumeGroup }).group;
    expect(group.issuer).toBe('International Scrum Institute');
    expect(group.titles).toEqual(['A', 'B', 'C']);
  });

  it('does not fold only two: two is not a wall', () => {
    const rows = groupResumeSection(section('recognition', [CERT(8, 'Scrum Master'), CERT(9, 'Scrum Coach')]));
    expect(rows.map((r) => r.kind)).toEqual(['entry', 'entry']);
  });

  it('leaves a substantive credential (a long bullet) as its own entry, folding only the thin ones', () => {
    const rows = groupResumeSection(
      section('recognition', [
        CERT(8, 'Scrum Master'),
        entry({
          prfId: 'PRF-016',
          title: 'Scrum Keynote',
          bulletText: 'Delivered the closing keynote on scaling scrum across a very large distributed engineering organization.'
        }),
        CERT(9, 'Scrum Coach'),
        CERT(10, 'Scrum Trainer')
      ])
    );
    expect(rows.map((r) => r.kind)).toEqual(['group', 'entry']);
    const group = (rows[0] as { group: ResumeGroup }).group;
    expect(group.titles).toEqual(['Scrum Master', 'Scrum Coach', 'Scrum Trainer']);
    expect((rows[1] as { entry: RenderEntry }).entry.core.officialTitle).toBe('Scrum Keynote');
  });

  it('keeps a lone credential from a different issuer as its own entry', () => {
    const rows = groupResumeSection(
      section('recognition', [
        CERT(8, 'Scrum Master'),
        CERT(9, 'Scrum Coach'),
        CERT(10, 'Scrum Trainer'),
        entry({ prfId: 'PRF-013', title: 'Atomic Design', bulletText: 'Brad Frost' })
      ])
    );
    expect(rows.map((r) => r.kind)).toEqual(['group', 'entry']);
    expect((rows[1] as { entry: RenderEntry }).entry.core.officialTitle).toBe('Atomic Design');
  });

  it('combines the date range: earliest start, and Present when any is ongoing', () => {
    const rows = groupResumeSection(
      section('recognition', [
        entry({ prfId: 'PRF-008', title: 'A', bulletText: 'Body', start: { year: 2015, month: 6 }, end: { year: 2016 } }),
        entry({ prfId: 'PRF-009', title: 'B', bulletText: 'Body', start: { year: 2017 }, end: null }),
        entry({ prfId: 'PRF-010', title: 'C', bulletText: 'Body', start: { year: 2018 }, end: { year: 2019 } })
      ])
    );
    const group = (rows[0] as { group: ResumeGroup }).group;
    expect(group.start).toEqual({ year: 2015, month: 6 });
    expect(group.end).toBeNull();
  });

  it('never folds a non-recognition section: roles pass straight through', () => {
    const rows = groupResumeSection(
      section('role_held', [
        entry({ prfId: 'PRF-001', kind: 'role_held', title: 'Designer', employer: 'Acme', bulletText: 'Did work.' }),
        entry({ prfId: 'PRF-002', kind: 'role_held', title: 'Designer', employer: 'Acme', bulletText: 'Did work.' }),
        entry({ prfId: 'PRF-003', kind: 'role_held', title: 'Designer', employer: 'Acme', bulletText: 'Did work.' })
      ])
    );
    expect(rows.map((r) => r.kind)).toEqual(['entry', 'entry', 'entry']);
  });

  it('every folded title survives verbatim, so the parse-proof gate still finds each one', () => {
    const rows = groupResumeSection(
      section('recognition', [CERT(8, 'Scrum Master'), CERT(9, 'Scrum Coach'), CERT(10, 'Scrum Trainer')])
    );
    const joined = (rows[0] as { group: ResumeGroup }).group.titles.join(', ');
    for (const title of ['Scrum Master', 'Scrum Coach', 'Scrum Trainer']) expect(joined).toContain(title);
  });
});

describe('groupResumeSection(): undated credentials in a fold (db/204)', () => {
  it('takes the earliest start among the dated members when one member has no start', () => {
    const rows = groupResumeSection(
      section('recognition', [
        entry({ prfId: 'PRF-1', title: 'Scrum Master', employer: 'Body', start: null }),
        entry({ prfId: 'PRF-2', title: 'Scrum Coach', employer: 'Body', start: { year: 2017, month: 1 } }),
        entry({ prfId: 'PRF-3', title: 'Scrum Trainer', employer: 'Body', start: { year: 2015, month: 1 } })
      ])
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('group');
    const group = (rows[0] as { group: ResumeGroup }).group;
    expect(group.start).toEqual({ year: 2015, month: 1 });
    expect(group.prfIds).toEqual(['PRF-1', 'PRF-2', 'PRF-3']);
  });

  it('folds a wall of wholly undated credentials with a null start', () => {
    const rows = groupResumeSection(
      section('recognition', [
        entry({ prfId: 'PRF-1', title: 'A', employer: 'Body', start: null }),
        entry({ prfId: 'PRF-2', title: 'B', employer: 'Body', start: null }),
        entry({ prfId: 'PRF-3', title: 'C', employer: 'Body', start: null })
      ])
    );
    expect(rows).toHaveLength(1);
    const group = (rows[0] as { group: ResumeGroup }).group;
    expect(group.start).toBeNull();
    expect(group.titles).toEqual(['A', 'B', 'C']);
  });
});
