import { describe, expect, it } from 'vitest';
import { renderCover, renderResume, type ProfileRecord } from './tailor';
import type { ProfileEntry } from './record';
import type { Job } from './data';
import { coverHasBody, resumeHasBody, resumeLines } from './pdf-resume';

/**
 * pdf-resume.ts's layout, the parts RUN-DRAFT.md phase 2 and RESUME-RULES.md
 * name explicitly: the current title rides in the top third, above the first
 * experience entry (which is ordered by relevance to the posting, not recency),
 * so a skim reads the person's current role first.
 */

function entry(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    prfId: 'PRF-0001',
    kind: 'role_held',
    employerOrInstitution: 'Acme Corp',
    officialTitle: 'Staff Designer',
    start: { year: 2020, month: 3 },
    end: null,
    location: 'Remote',
    description: 'Led the checkout redesign.',
    classification: 'private',
    provenance: 'you_told_us',
    artifacts: [],
    ...overrides
  };
}

function target(): Job {
  return { company: 'Northwind', title: 'Designer', description_html: '<p>checkout redesign</p>' } as unknown as Job;
}

function indexOfLine(lines: readonly { text: string }[], predicate: (t: string) => boolean): number {
  return lines.findIndex((l) => predicate(l.text));
}

describe('resumeLines(): the current title is in the top third', () => {
  it('draws the current role title above the first section heading', async () => {
    // Two roles: an older, keyword-relevant one (so relevance would sort it
    // first inside Experience) and the current one. The current title must still
    // appear above the Experience heading, from the top subtitle.
    const record: ProfileRecord = [
      entry({
        prfId: 'PRF-0001',
        officialTitle: 'Design Lead',
        employerOrInstitution: 'Fathom',
        description: 'Owned the checkout redesign and the design system.',
        start: { year: 2016, month: 1 },
        end: { year: 2020, month: 1 }
      }),
      entry({
        prfId: 'PRF-0002',
        officialTitle: 'Principal Designer',
        employerOrInstitution: 'Northwind',
        description: 'Set direction.',
        start: { year: 2020, month: 2 },
        end: null
      })
    ];
    const resume = await renderResume(record, { kind: 'verified_posting', job: target() }, undefined, {
      name: 'Jordan Rivera',
      email: 'jordan@example.com',
      links: []
    });
    const lines = resumeLines(resume);

    const nameIdx = indexOfLine(lines, (t) => t === 'Jordan Rivera');
    const currentIdx = indexOfLine(lines, (t) => t.startsWith('Principal Designer, Northwind'));
    const headingIdx = indexOfLine(lines, (t) => t === 'Experience');

    expect(nameIdx).toBe(0);
    expect(currentIdx).toBeGreaterThan(nameIdx);
    expect(currentIdx).toBeLessThan(headingIdx);
  });

  it('draws no current-title subtitle when the record names no ongoing role', async () => {
    const record: ProfileRecord = [
      entry({ prfId: 'PRF-0001', officialTitle: 'Designer', end: { year: 2022, month: 6 } })
    ];
    const resume = await renderResume(record, { kind: 'verified_posting', job: target() }, undefined, {
      name: 'Jordan Rivera',
      email: null,
      links: []
    });
    const lines = resumeLines(resume);
    // The only 'Designer' line is inside Experience, after the heading, never a
    // top subtitle before it.
    const headingIdx = indexOfLine(lines, (t) => t === 'Experience');
    const firstDesignerIdx = indexOfLine(lines, (t) => t === 'Designer');
    expect(firstDesignerIdx).toBeGreaterThan(headingIdx);
  });
});

/**
 * The blank-document guard: a render with nothing to draw must be caught before
 * it is handed to the PDF writer, so a person never downloads a valid-but-empty
 * page. The resume's body is its entry cores; the cover's is its bullets, which
 * a role with no description does not produce. These are the checks the download
 * route (desk/job-draft/[slug]/[doc].ts) and the result page both gate on.
 */
describe('resumeHasBody / coverHasBody: the blank-document guard', () => {
  const header = { name: 'Jordan Rivera', email: 'jordan@example.com', links: [] };

  async function renders(record: ProfileRecord) {
    const t = { kind: 'verified_posting' as const, job: target() };
    return {
      resume: await renderResume(record, t, undefined, header),
      cover: await renderCover(record, t, undefined, null, header)
    };
  }

  it('a role with a description has a resume body and a cover body', async () => {
    const { resume, cover } = await renders([
      entry({ officialTitle: 'Staff Designer', description: 'Led the checkout redesign end to end.' })
    ]);
    expect(resumeHasBody(resume)).toBe(true);
    expect(coverHasBody(cover)).toBe(true);
  });

  it('a role with no description still has a resume body but no cover body', async () => {
    // The exact shape a resume-parsed record of bare roles produces: cores but
    // no bullets. The resume prints the cores; the cover has nothing to say.
    const { resume, cover } = await renders([
      entry({ officialTitle: 'Staff Designer', description: '' })
    ]);
    expect(resumeHasBody(resume)).toBe(true);
    expect(coverHasBody(cover)).toBe(false);
  });

  it('an empty record has neither a resume body nor a cover body', async () => {
    const { resume, cover } = await renders([]);
    expect(resumeHasBody(resume)).toBe(false);
    expect(coverHasBody(cover)).toBe(false);
  });
});

describe('resumeLines(): an undated entry prints no date line (db/204)', () => {
  it('draws the title, then goes straight on: no empty meta line and no "to Present" for it', async () => {
    const record: ProfileRecord = [
      entry(),
      entry({ prfId: 'PRF-0002', kind: 'skill', employerOrInstitution: null, officialTitle: 'Figma', start: null, description: '' })
    ];
    const header = { name: 'Jordan Rivera', email: 'jordan@example.com', links: [] };
    const resume = await renderResume(record, { kind: 'verified_posting', job: target() }, undefined, header);
    const lines = resumeLines(resume);

    const figma = indexOfLine(lines, (t) => t === 'Figma');
    expect(figma).toBeGreaterThanOrEqual(0);
    // Nothing blank anywhere: an undated, employerless entry has no meta line at all.
    expect(lines.some((l) => l.text.trim() === '')).toBe(false);
    // The line after the title, if any, is not a date range for it.
    const next = lines[figma + 1];
    if (next) expect(next.text).not.toContain(' to ');
    // The dated role still prints its range exactly as before.
    expect(indexOfLine(lines, (t) => t.includes('March 2020 to Present'))).toBeGreaterThanOrEqual(0);
  });
});

describe('resumeLines(): the summary block rides in the top third', () => {
  it('draws a Summary heading and the summary text above Experience, in place of the bare title line', async () => {
    const record: ProfileRecord = [
      entry({ prfId: 'PRF-0001', officialTitle: 'Principal Designer', employerOrInstitution: 'Northwind', end: null }),
      entry({ prfId: 'PRF-0002', kind: 'skill', officialTitle: 'Checkout', employerOrInstitution: null, description: '', start: { year: 2019, month: null } })
    ];
    const resume = await renderResume(record, { kind: 'verified_posting', job: target() }, undefined, {
      name: 'Jordan Rivera',
      email: null,
      links: []
    });
    const lines = resumeLines(resume);
    const summaryHeadingIdx = indexOfLine(lines, (t) => t === 'Summary');
    const summaryIdx = indexOfLine(lines, (t) => t === resume.summary?.text);
    const headingIdx = indexOfLine(lines, (t) => t === 'Experience');

    expect(resume.summary?.text).toBe('Principal Designer, Northwind, March 2020 to Present. Checkout.');
    expect(summaryHeadingIdx).toBeGreaterThan(0);
    expect(summaryIdx).toBe(summaryHeadingIdx + 1);
    expect(summaryIdx).toBeLessThan(headingIdx);
    // The title is not drawn twice at the top: the summary carries it.
    expect(lines.filter((l) => l.text.startsWith('Principal Designer, Northwind')).length).toBe(1);
  });

  it('a render stored before summaries existed still draws the bare current-title line', async () => {
    const record: ProfileRecord = [
      entry({ prfId: 'PRF-0001', officialTitle: 'Principal Designer', employerOrInstitution: 'Northwind', end: null })
    ];
    const fresh = await renderResume(record, { kind: 'verified_posting', job: target() }, undefined, {
      name: 'Jordan Rivera',
      email: null,
      links: []
    });
    const lines = resumeLines({ ...fresh, summary: undefined });
    expect(indexOfLine(lines, (t) => t === 'Summary')).toBe(-1);
    expect(indexOfLine(lines, (t) => t === 'Principal Designer, Northwind')).toBeGreaterThan(0);
  });
});
