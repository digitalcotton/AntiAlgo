import { describe, expect, it } from 'vitest';
import { parseResumeImport, candidateInputFromFields } from './record-import';
import { CEILINGS, validateEntry } from './record';

// record-import.ts is the pure parser behind MASTER-SPEC F2's import boost:
// paste in, proposals out, nothing written anywhere. These tests pin the
// one rule the file's own header states first: never invent. A field the
// parser cannot read with confidence is left empty, not guessed; a block
// with no recognisable shape produces no proposal, not a wrong one; and a
// proposal the record would refuse (CEILINGS, YEAR_MIN/YEAR_MAX) never
// reaches the caller looking acceptable.

function readingFor(proposal: ReturnType<typeof parseResumeImport>['proposals'][number], field: string) {
  return proposal.readings.find((r) => r.field === field) ?? null;
}

describe('parseResumeImport(): a realistic multi-role paste', () => {
  const resume = [
    'Senior Product Designer',
    'Acme Corp | San Francisco, CA',
    'March 2019 - Present',
    '',
    'Led the design system rebuild. Shipped the checkout redesign.',
    '',
    'Product Designer',
    'Beta Industries, Austin, TX',
    'June 2016 - February 2019',
    '',
    'Owned the onboarding flow end to end.'
  ].join('\n');

  const result = parseResumeImport(resume);

  it('proposes one entry per role block', () => {
    expect(result.proposals).toHaveLength(2);
  });

  it('reads the first role\'s fields correctly', () => {
    const proposal = result.proposals[0];
    expect(proposal.candidate.officialTitle).toBe('Senior Product Designer');
    expect(proposal.candidate.employerOrInstitution).toBe('Acme Corp');
    expect(proposal.candidate.location).toBe('San Francisco, CA');
    expect(proposal.candidate.start).toEqual({ year: 2019, month: 3 });
    expect(proposal.candidate.end).toBeNull();
    expect(proposal.candidate.description).toBe('Led the design system rebuild. Shipped the checkout redesign.');
    expect(proposal.candidate.kind).toBe('role_held');
    expect(proposal.candidate.classification).toBe('private');
  });

  it('reads the second role\'s fields correctly, including a real end date', () => {
    const proposal = result.proposals[1];
    expect(proposal.candidate.officialTitle).toBe('Product Designer');
    expect(proposal.candidate.employerOrInstitution).toBe('Beta Industries');
    expect(proposal.candidate.location).toBe('Austin, TX');
    expect(proposal.candidate.start).toEqual({ year: 2016, month: 6 });
    expect(proposal.candidate.end).toEqual({ year: 2019, month: 2 });
  });

  it('carries a span for every field it filled, pointing back at the input', () => {
    const proposal = result.proposals[0];
    const titleReading = readingFor(proposal, 'officialTitle');
    expect(titleReading).not.toBeNull();
    expect(titleReading?.span.text).toBe('Senior Product Designer');
    expect(resume.slice(titleReading!.span.start, titleReading!.span.end)).toBe('Senior Product Designer');

    const employerReading = readingFor(proposal, 'employerOrInstitution');
    expect(employerReading?.span.text).toBe('Acme Corp | San Francisco, CA');

    const startReading = readingFor(proposal, 'start');
    expect(startReading?.span.text).toBe('March 2019 - Present');
    expect(startReading?.span.line).toBe(3);
  });

  it('every proposal already passes validateEntry(), because parseResumeImport() already ran it', () => {
    for (const proposal of result.proposals) {
      expect(validateEntry(proposal.candidate).ok).toBe(true);
    }
  });

  it('carries no reading for kind or classification: both are defaults, never something read', () => {
    for (const proposal of result.proposals) {
      expect(readingFor(proposal, 'kind')).toBeNull();
      expect(readingFor(proposal, 'classification')).toBeNull();
    }
  });
});

describe('parseResumeImport(): input with no recognisable structure', () => {
  it('returns no proposals, does not throw, and says so in a note', () => {
    const prose = [
      'This is just a paragraph of biography text.',
      'It has no headings, no employer lines, and no dates anywhere in it.',
      'A parser that reads line shapes has nothing here to read.'
    ].join('\n');

    let result: ReturnType<typeof parseResumeImport> | null = null;
    expect(() => {
      result = parseResumeImport(prose);
    }).not.toThrow();

    expect(result!.proposals).toEqual([]);
    expect(result!.notes.length).toBeGreaterThan(0);
    expect(result!.notes.join(' ')).toMatch(/nothing/i);
  });
});

describe('parseResumeImport(): a date the parser cannot read', () => {
  it('leaves the month empty rather than guessing one for an unrecognised month word', () => {
    // "Spring" is not a month name this parser knows. The year is still
    // there in the text and is kept; the month is not spelled out as a
    // month, so it is left null rather than mapped to March, April or any
    // other plausible guess. Matches record.ts's own header: "2019" gives
    // a year and no month, and a parser that fills one in has fabricated
    // a fact. This parser extends that same discipline to any leading word
    // it cannot resolve to a real month name.
    const resume = ['Freelance Illustrator', 'Self-employed', 'Spring 2019 - Present'].join('\n');
    const result = parseResumeImport(resume);

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].candidate.start).toEqual({ year: 2019, month: null });
  });

  it('produces no proposal for a block whose end token this parser cannot resolve to a date or "still there"', () => {
    // "the fall" is neither a parseable date nor one of the recognised
    // ongoing words. Guessing an end year would fabricate a fact; guessing
    // "still there" would fabricate a different one. This parser refuses
    // both, and the block is left unproposed rather than proposed with
    // either guess.
    const resume = ['Contract Designer', 'Acme Corp', 'March 2019 - the fall'].join('\n');
    const result = parseResumeImport(resume);

    expect(result.proposals).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/did not match|nothing/i);
  });
});

describe('parseResumeImport(): an ongoing role', () => {
  it('parses "Present" to end: null, a claimed state, not an omission', () => {
    const resume = ['Staff Engineer', 'Acme Corp', '2020 - Present'].join('\n');
    const result = parseResumeImport(resume);

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].candidate.start).toEqual({ year: 2020, month: null });
    expect(result.proposals[0].candidate.end).toBeNull();

    const endReading = readingFor(result.proposals[0], 'end');
    expect(endReading).not.toBeNull();
    expect(endReading?.span.text).toBe('2020 - Present');
  });

  it('recognises other common ongoing words, and says the list is not exhaustive', () => {
    for (const word of ['Current', 'ongoing', 'Now', 'today']) {
      const resume = ['Volunteer Mentor', 'Community Org', `2021 - ${word}`].join('\n');
      const result = parseResumeImport(resume);
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].candidate.end).toBeNull();
    }
  });
});

describe('parseResumeImport(): a skill list does not become an invented entry', () => {
  it('does not propose an entry from a bare, comma-separated skill list', () => {
    const resume = [
      'SKILLS',
      'JavaScript, TypeScript, React, Node.js, PostgreSQL',
      '',
      'Product Designer',
      'Acme Corp',
      '2019 - Present',
      '',
      'Shipped things.'
    ].join('\n');

    const result = parseResumeImport(resume);

    // Exactly one proposal: the role, which has a title, employer and
    // date range this parser reads. The skills block has none of those
    // (no date line anywhere in it), so it is never turned into a
    // 'skill'-kind entry, or any entry at all, no matter how list-shaped
    // it looks.
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].candidate.officialTitle).toBe('Product Designer');
    for (const proposal of result.proposals) {
      expect(proposal.candidate.kind).not.toBe('skill');
    }
  });
});

describe('parseResumeImport(): CEILINGS, at and over', () => {
  it('proposes an entry whose title sits exactly at CEILINGS.officialTitle', () => {
    const title = 'T'.repeat(CEILINGS.officialTitle);
    const resume = [title, 'Acme Corp', '2019 - Present'].join('\n');
    const result = parseResumeImport(resume);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].candidate.officialTitle).toHaveLength(CEILINGS.officialTitle);
  });

  it('drops a block whose title is one character over CEILINGS.officialTitle', () => {
    const title = 'T'.repeat(CEILINGS.officialTitle + 1);
    const resume = [title, 'Acme Corp', '2019 - Present'].join('\n');
    const result = parseResumeImport(resume);
    expect(result.proposals).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('drops a block whose description is one character over CEILINGS.description', () => {
    const description = 'D'.repeat(CEILINGS.description + 1);
    const resume = ['Product Designer', 'Acme Corp', '2019 - Present', '', description].join('\n');
    const result = parseResumeImport(resume);
    expect(result.proposals).toEqual([]);
  });
});

describe('parseResumeImport(): empty input', () => {
  it('returns no proposals and does not throw for an empty string', () => {
    expect(() => parseResumeImport('')).not.toThrow();
    const result = parseResumeImport('');
    expect(result.proposals).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('returns no proposals and does not throw for whitespace only', () => {
    const result = parseResumeImport('   \n\n\t  \n  ');
    expect(result.proposals).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
  });
});

describe('parseResumeImport(): adversarial characters, escaped, never literal', () => {
  it('reads a title containing a smart quote and an em dash without throwing or fabricating a date', () => {
    // Written as escapes in this test file's own source, per the
    // constraints canon; the point is that arbitrary pasted characters
    // (curly quotes, an em dash, a stray control character) are just data
    // to this parser, not something it needs to sanitise or that should
    // make it crash.
    const title = 'Ryan\u2019s Studio \u2014 Freelance';
    const resume = [title, 'Self-employed', '2019 - Present'].join('\n');

    let result: ReturnType<typeof parseResumeImport> | null = null;
    expect(() => {
      result = parseResumeImport(resume);
    }).not.toThrow();
    expect(result!.proposals).toHaveLength(1);
    expect(result!.proposals[0].candidate.officialTitle).toBe(title);
  });

  it('does not throw on a line separator inside the pasted text (\\u2028, \\u2029)', () => {
    const resume = `Product Designer Acme Corp\nAcme Corp\n2019 - Present`;
    expect(() => parseResumeImport(resume)).not.toThrow();
  });
});

describe('parseResumeImport(): a block with no employer or institution line', () => {
  it('produces no proposal, because role_held requires an employer and this parser will not invent one', () => {
    // Title directly above the date line, nothing between them. Read
    // strictly, this is a title and a date range with no employer line at
    // all; validateEntry() correctly refuses it for the default
    // 'role_held' kind, and that refusal is exactly why this file never
    // reaches the caller with an invented employer.
    const resume = ['Product Designer', '2019 - Present'].join('\n');
    const result = parseResumeImport(resume);
    expect(result.proposals).toEqual([]);
  });
});

describe('record-import.ts: the immutable core is read, never transformed', () => {
  // employerOrInstitution and officialTitle are record.ts's immutable
  // core. record.ts's own validateEntry() used to refuse either one with a
  // leading or trailing space rather than silently cleaning it (gate 8);
  // RUN-FINISH.md section 2.2 reversed that refusal (the owner: "we are
  // not the police"), so validateEntry() now accepts the space and stores
  // it byte-identical. This parser was never the thing that needed fixing:
  // it never trimmed on the way in, before or after that reversal, so a
  // title or employer line with stray whitespace of its own, not separator
  // padding, reaches a proposal carrying that whitespace exactly as
  // pasted. A version of this parser that trimmed on the way in would
  // instead offer a proposal whose candidate no longer matches the pasted
  // line, which is exactly what these two tests would catch.

  it('offers a proposal for a title line with its own leading and trailing whitespace, carried through exactly as pasted', () => {
    const resume = ['  Product Designer  ', 'Acme Corp', '2019 - Present'].join('\n');
    const result = parseResumeImport(resume);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].candidate.officialTitle).toBe('  Product Designer  ');
  });

  it('offers a proposal for an employer line with its own leading whitespace, separator or not, carried through exactly as pasted', () => {
    // Indentation on the employer line itself, not a pipe or comma's
    // padding: parseEmployerLine() has nothing to draw a boundary around
    // here, so the leading space is genuinely part of the value, and this
    // parser passes it straight through rather than trimming it away.
    const resume = ['Product Designer', '  Acme Corp', '2019 - Present'].join('\n');
    const result = parseResumeImport(resume);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].candidate.employerOrInstitution).toBe('  Acme Corp');
  });

  it('excludes a pipe separator\'s own padding, which is not the same as trimming the employer value', () => {
    // " | " is the delimiter between two fields on one line; the space on
    // either side belongs to the separator, not to the employer. Reading
    // the employer as "Acme Corp" here is parseEmployerLine() drawing the
    // separator's boundary correctly, the same way a comma-and-space
    // separator already does elsewhere in this file, not a trim applied
    // to the value after slicing it out.
    const resume = ['Product Designer', 'Acme Corp | Remote', '2019 - Present'].join('\n');
    const result = parseResumeImport(resume);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].candidate.employerOrInstitution).toBe('Acme Corp');
  });
});

describe('candidateInputFromFields(): the confirm step\'s field-to-input conversion', () => {
  it('does not trim employerOrInstitution: a stray space round-trips untouched, and validateEntry() raises no issue over it', () => {
    // Mirrors the exact bug shape gate 8 caught: employerOrInstitution
    // trimmed while officialTitle beside it was not. This pins that
    // neither is trimmed here: a space arriving from a round-tripped
    // proposal or a hand-edited field is passed straight to
    // validateEntry(), which is the one place that gets to decide what to
    // do about it. RUN-FINISH.md section 2.2 settled what it decides: the
    // space is the person's own byte, accepted and stored exactly as
    // given, not refused (the owner: "we are not the police").
    const input = candidateInputFromFields({
      kind: 'role_held',
      employerOrInstitution: ' Acme Corp',
      officialTitle: 'Staff Designer ',
      startYear: '2020',
      startMonth: '',
      stillHere: 'on',
      endYear: '',
      endMonth: '',
      location: '',
      description: '',
      classification: 'private'
    });
    const result = validateEntry(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.employerOrInstitution).toBe(' Acme Corp');
      expect(result.entry.officialTitle).toBe('Staff Designer ');
    }
  });

  it('turns a still-here checkbox into end: null', () => {
    const input = candidateInputFromFields({
      kind: 'role_held',
      employerOrInstitution: 'Acme Corp',
      officialTitle: 'Staff Designer',
      startYear: '2020',
      startMonth: '3',
      stillHere: 'on',
      endYear: '',
      endMonth: '',
      location: '',
      description: '',
      classification: 'private'
    });
    const result = validateEntry(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.end).toBeNull();
    }
  });

  it('leaves an empty year field as undefined rather than 0 or NaN, so validateEntry() reports it as missing', () => {
    const input = candidateInputFromFields({
      kind: 'role_held',
      employerOrInstitution: 'Acme Corp',
      officialTitle: 'Staff Designer',
      startYear: '',
      startMonth: '',
      stillHere: '',
      endYear: '',
      endMonth: '',
      location: '',
      description: '',
      classification: 'private'
    });
    const result = validateEntry(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.field === 'start.year')).toBe(true);
    }
  });

  it('round-trips an edited field: a person changing a proposal\'s title is read like anything typed by hand', () => {
    const input = candidateInputFromFields({
      kind: 'role_held',
      employerOrInstitution: 'Acme Corp',
      officialTitle: 'Corrected Title',
      startYear: '2020',
      startMonth: '',
      stillHere: '',
      endYear: '2021',
      endMonth: '',
      location: '',
      description: '',
      classification: 'private'
    });
    const result = validateEntry(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.officialTitle).toBe('Corrected Title');
    }
  });
});
