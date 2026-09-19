import { describe, expect, it } from 'vitest';
import {
  coreMatches,
  coreOf,
  nextPrfId,
  visibleTo,
  validateEntry,
  CLASSIFICATIONS,
  CEILINGS,
  type ProfileEntry,
  type ImmutableCore
} from './record';

// record.ts is the pure core of the Profile Record: no database, no I/O,
// same inputs always the same answer. These tests pin the contracts that
// matter most: the immutable core's comparison really is byte-identical
// (not case-insensitive, not trimmed, not normalised), the id sequence
// never reuses a number, the visibility rule denies everyone but the owner
// in this run, and validation bounds every string to the ceilings the
// database also enforces.

// Every hostile character below is a code point, never a literal: gate 3
// (test/gates/copy.mjs) hard fails on an unusual character appearing
// literally anywhere in this repository's own source, and hygiene.test.ts
// already uses this same helper for the same reason.
function cp(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

function core(overrides: Partial<ImmutableCore> = {}): ImmutableCore {
  return {
    employerOrInstitution: 'Acme Corp',
    officialTitle: 'Staff Designer',
    start: { year: 2020, month: 3 },
    end: null,
    ...overrides
  };
}

describe('coreMatches(): byte-identical, not forgiving', () => {
  it('matches two identical cores', () => {
    expect(coreMatches(core(), core())).toBe(true);
  });

  it('returns false for a trailing space', () => {
    expect(coreMatches(core(), core({ officialTitle: 'Staff Designer ' }))).toBe(false);
  });

  it('returns false for a changed case', () => {
    expect(coreMatches(core(), core({ officialTitle: 'staff designer' }))).toBe(false);
  });

  it('returns false for a smart quote swapped for a straight one', () => {
    expect(
      coreMatches(
        // Written as an escape, not as the character. The copy gate hard fails
        // on a curly quote anywhere this repository authors, and it is right to:
        // the character has no business in source. The escape produces the same
        // string at runtime, so the assertion is unchanged and the file stays
        // clean. Naming the codepoint beside it is the point of the test.
        core({ officialTitle: 'Ryan\u2019s Studio' }),
        core({ officialTitle: "Ryan's Studio" })
      )
    ).toBe(false);
  });

  it('returns false for an em dash swapped for a hyphen', () => {
    expect(
      coreMatches(
        // Same reason as the curly quote above: the escape, never the character.
        core({ employerOrInstitution: 'Acme\u2014Corp' }),
        core({ employerOrInstitution: 'Acme-Corp' })
      )
    ).toBe(false);
  });

  it('returns false when the dates differ only by month', () => {
    expect(coreMatches(core({ start: { year: 2020, month: 3 } }), core({ start: { year: 2020, month: 4 } }))).toBe(
      false
    );
  });

  it('returns false when one end is "still there" and the other is not', () => {
    expect(coreMatches(core({ end: null }), core({ end: { year: 2022, month: 1 } }))).toBe(false);
  });

  it('coreOf() pulls exactly the four core fields off a full entry', () => {
    const entry: ProfileEntry = {
      prfId: 'PRF-0001',
      kind: 'role_held',
      employerOrInstitution: 'Acme Corp',
      officialTitle: 'Staff Designer',
      start: { year: 2020, month: 3 },
      end: null,
      location: 'Remote',
      description: 'Led the design system.',
      classification: 'private',
      provenance: 'you_told_us',
      artifacts: []
    };
    expect(coreOf(entry)).toEqual(core());
  });
});

describe('nextPrfId(): never reuses a number', () => {
  it('handles an empty record', () => {
    expect(nextPrfId([])).toBe('PRF-0001');
  });

  it('increments from a single id', () => {
    expect(nextPrfId(['PRF-0001'])).toBe('PRF-0002');
  });

  it('does not fill a gap in the sequence', () => {
    expect(nextPrfId(['PRF-0001', 'PRF-0003'])).toBe('PRF-0004');
  });

  it('is indifferent to the order the ids are given in', () => {
    expect(nextPrfId(['PRF-0005', 'PRF-0001', 'PRF-0003'])).toBe('PRF-0006');
  });

  it('does not reuse a number after the highest id is deleted', () => {
    // Simulates the sequence over time: 0001, 0002, 0003 were all issued.
    const everIssued = ['PRF-0001', 'PRF-0002', 'PRF-0003'];
    expect(nextPrfId(everIssued)).toBe('PRF-0004');

    // PRF-0003, the highest id, is now deleted. Per nextPrfId()'s documented
    // contract, `existing` must still be every id ever issued, not merely
    // the ids of entries that are still around. Called correctly, with the
    // deleted id kept in the history, the next id is still 0004: 0003 is
    // gone for good and is never handed out a second time.
    expect(nextPrfId(everIssued)).toBe('PRF-0004');
    expect(nextPrfId(everIssued)).not.toBe('PRF-0003');

    // Contrast with a caller that violates the contract: if the deleted id
    // is dropped from the list instead of kept, max()+1 has no way to know
    // 0003 was ever issued and would hand it straight back out. This is not
    // a case nextPrfId() can guard against by itself (it has no memory
    // between calls and no database to check); it exists to make the
    // contract's stakes concrete, not to assert a fix for it.
    const wronglyTruncated = ['PRF-0001', 'PRF-0002'];
    expect(nextPrfId(wronglyTruncated)).toBe('PRF-0003');
  });
});

describe('visibleTo(): the per-entry visibility rule', () => {
  it('the owner always sees their own entry, regardless of classification', () => {
    for (const classification of CLASSIFICATIONS) {
      expect(visibleTo({ classification }, 'owner')).toBe(true);
    }
  });

  it('denies a private entry to a non-owner', () => {
    expect(visibleTo({ classification: 'private' }, 'other')).toBe(false);
  });

  it('denies every classification value to a non-owner in this run (amendment 6)', () => {
    // Enumerated explicitly, one assertion per value, so a new value added
    // to CLASSIFICATIONS without updating this test (and without a matching
    // case in visibleTo()'s own switch, which fails to compile) is caught
    // here rather than silently defaulting to "visible".
    expect(CLASSIFICATIONS).toEqual(['public', 'unlisted', 'private']);
    for (const classification of CLASSIFICATIONS) {
      expect(visibleTo({ classification }, 'other')).toBe(false);
    }
  });
});

describe('validateEntry(): untrusted input, never throws', () => {
  function validInput(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'project',
      employerOrInstitution: null,
      officialTitle: 'Design System Overhaul',
      start: { year: 2021, month: 6 },
      end: { year: 2022, month: 1 },
      location: 'Remote',
      description: 'Rebuilt the token pipeline.',
      classification: 'unlisted',
      artifacts: [],
      ...overrides
    };
  }

  it('accepts a fully valid entry', () => {
    const result = validateEntry(validInput());
    expect(result.ok).toBe(true);
  });

  it('never throws on garbage input', () => {
    expect(() => validateEntry(null)).not.toThrow();
    expect(() => validateEntry(undefined)).not.toThrow();
    expect(() => validateEntry('not an object')).not.toThrow();
    expect(() => validateEntry(42)).not.toThrow();
    expect(() => validateEntry([])).not.toThrow();
    expect(() => validateEntry({})).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    const result = validateEntry(validInput({ kind: 'hobby' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.field === 'kind')).toBe(true);
    }
  });

  it('requires employerOrInstitution for role_held', () => {
    const result = validateEntry(validInput({ kind: 'role_held', employerOrInstitution: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.field === 'employerOrInstitution')).toBe(true);
    }
  });

  it('requires employerOrInstitution for education', () => {
    const result = validateEntry(validInput({ kind: 'education', employerOrInstitution: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.field === 'employerOrInstitution')).toBe(true);
    }
  });

  it('does not require employerOrInstitution for a skill', () => {
    const result = validateEntry(validInput({ kind: 'skill', employerOrInstitution: null }));
    expect(result.ok).toBe(true);
  });

  it('treats an absent end as valid ("still there"), not an error', () => {
    const result = validateEntry(validInput({ end: null }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.end).toBeNull();
    }
  });

  it('rejects an end year before the start year', () => {
    const result = validateEntry(
      validInput({ start: { year: 2022, month: 1 }, end: { year: 2020, month: 1 } })
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a month out of range', () => {
    const result = validateEntry(validInput({ start: { year: 2021, month: 13 } }));
    expect(result.ok).toBe(false);
  });

  it('rejects an unrecognised classification', () => {
    const result = validateEntry(validInput({ classification: 'secret' }));
    expect(result.ok).toBe(false);
  });

  it('validates a well-formed artifact', () => {
    const result = validateEntry(
      validInput({ artifacts: [{ kind: 'repo', url: 'https://github.com/example/example', label: 'Source' }] })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.artifacts).toHaveLength(1);
    }
  });

  it('rejects an artifact with an unknown kind', () => {
    const result = validateEntry(validInput({ artifacts: [{ kind: 'tweet', url: 'https://example.com' }] }));
    expect(result.ok).toBe(false);
  });

  describe('length ceilings: one character over rejects, exactly at it accepts', () => {
    it('officialTitle', () => {
      const atCeiling = 'x'.repeat(CEILINGS.officialTitle);
      const overCeiling = 'x'.repeat(CEILINGS.officialTitle + 1);
      expect(validateEntry(validInput({ officialTitle: atCeiling })).ok).toBe(true);
      expect(validateEntry(validInput({ officialTitle: overCeiling })).ok).toBe(false);
    });

    it('employerOrInstitution', () => {
      const atCeiling = 'x'.repeat(CEILINGS.employerOrInstitution);
      const overCeiling = 'x'.repeat(CEILINGS.employerOrInstitution + 1);
      expect(
        validateEntry(validInput({ kind: 'role_held', employerOrInstitution: atCeiling })).ok
      ).toBe(true);
      expect(
        validateEntry(validInput({ kind: 'role_held', employerOrInstitution: overCeiling })).ok
      ).toBe(false);
    });

    it('location', () => {
      const atCeiling = 'x'.repeat(CEILINGS.location);
      const overCeiling = 'x'.repeat(CEILINGS.location + 1);
      expect(validateEntry(validInput({ location: atCeiling })).ok).toBe(true);
      expect(validateEntry(validInput({ location: overCeiling })).ok).toBe(false);
    });

    it('description', () => {
      const atCeiling = 'x'.repeat(CEILINGS.description);
      const overCeiling = 'x'.repeat(CEILINGS.description + 1);
      expect(validateEntry(validInput({ description: atCeiling })).ok).toBe(true);
      expect(validateEntry(validInput({ description: overCeiling })).ok).toBe(false);
    });

    it('artifact url', () => {
      const atCeiling = 'https://example.com/' + 'x'.repeat(CEILINGS.artifactUrl - 'https://example.com/'.length);
      const overCeiling = atCeiling + 'x';
      expect(atCeiling.length).toBe(CEILINGS.artifactUrl);
      expect(
        validateEntry(validInput({ artifacts: [{ kind: 'live_url', url: atCeiling, label: null }] })).ok
      ).toBe(true);
      expect(
        validateEntry(validInput({ artifacts: [{ kind: 'live_url', url: overCeiling, label: null }] })).ok
      ).toBe(false);
    });

    it('artifact label', () => {
      const atCeiling = 'x'.repeat(CEILINGS.artifactLabel);
      const overCeiling = 'x'.repeat(CEILINGS.artifactLabel + 1);
      expect(
        validateEntry(
          validInput({ artifacts: [{ kind: 'live_url', url: 'https://example.com', label: atCeiling }] })
        ).ok
      ).toBe(true);
      expect(
        validateEntry(
          validInput({ artifacts: [{ kind: 'live_url', url: 'https://example.com', label: overCeiling }] })
        ).ok
      ).toBe(false);
    });
  });
});

/* -------------------------------------------------------------------------
   A core field is stored exactly as typed: no scan, no warning, no
   refusal, for a leading or trailing space or for a hidden character
   either. This reverses the rule record.ts used to enforce (see
   validateEntry()'s own comment on why); RUN-FINISH.md section 2.2, the
   owner's own words: "we are not the police. we will not create phantom
   text like this. if people find a way to trick the system, great."
   ------------------------------------------------------------------------- */

describe('validateEntry(): a core field carrying whitespace or a hidden character is accepted, byte-identical, unwarned', () => {
  function validInput(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'role_held',
      employerOrInstitution: 'Acme Corp',
      officialTitle: 'Staff Designer',
      start: { year: 2020, month: 3 },
      end: null,
      location: 'Remote',
      description: 'Led the checkout redesign.',
      classification: 'private',
      artifacts: [],
      ...overrides
    };
  }

  it('accepts a leading and trailing space on officialTitle, stored byte-identical', () => {
    const value = '  Staff Designer  ';
    const result = validateEntry(validInput({ officialTitle: value }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.officialTitle).toBe(value);
    }
  });

  it('accepts a leading and trailing space on employerOrInstitution, stored byte-identical', () => {
    const value = '  Acme Corp  ';
    const result = validateEntry(validInput({ employerOrInstitution: value }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.employerOrInstitution).toBe(value);
    }
  });

  it('accepts a zero-width space inside officialTitle, stored byte-identical, no issue raised', () => {
    const value = 'Staff' + cp(0x200b) + ' Designer';
    const result = validateEntry(validInput({ officialTitle: value }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.officialTitle).toBe(value);
    }
  });

  it('accepts a bidirectional override inside employerOrInstitution, stored byte-identical, no issue raised', () => {
    const value = 'Acme' + cp(0x202e) + 'omeD' + cp(0x202c) + ' Corp';
    const result = validateEntry(validInput({ employerOrInstitution: value }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.employerOrInstitution).toBe(value);
    }
  });

  it('accepts a Unicode tag character inside officialTitle, stored byte-identical', () => {
    const value = 'Staff Designer' + cp(0xe0068);
    const result = validateEntry(validInput({ officialTitle: value }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.officialTitle).toBe(value);
    }
  });

  it('accepts a stray control character inside employerOrInstitution, stored byte-identical', () => {
    const value = 'Acme' + cp(0x0000) + ' Corp';
    const result = validateEntry(validInput({ employerOrInstitution: value }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.employerOrInstitution).toBe(value);
    }
  });

  it('accepts both fields carrying a hidden character at once, neither one warned about', () => {
    const employer = 'Acme' + cp(0x200b) + ' Corp';
    const title = 'Staff' + cp(0x200b) + ' Designer';
    const result = validateEntry(validInput({ employerOrInstitution: employer, officialTitle: title }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.employerOrInstitution).toBe(employer);
      expect(result.entry.officialTitle).toBe(title);
    }
  });

  it('still accepts ordinary text, including non-ASCII and accented letters, on both core fields', () => {
    // Written as \u escapes for the same reason as everywhere else in this
    // file: the copy gate hard fails on the literal character in source.
    // employerOrInstitution carries a decomposed accent (a plain "e" plus a
    // combining acute) and a smart quote; officialTitle carries an em dash
    // and a precomposed umlaut.
    const result = validateEntry(
      validInput({
        employerOrInstitution: 'Ren\u0065\u0301\u2019s Caf\u0065\u0301',
        officialTitle: 'Staff Designer \u2014 D\u00fcsseldorf'
      })
    );
    expect(result.ok).toBe(true);
  });

  it('still accepts a plain, unaccented officialTitle and employerOrInstitution', () => {
    expect(validateEntry(validInput()).ok).toBe(true);
  });
});

describe('validateEntry(): a start date is optional for a skill, an artifact and a recognition (db/204)', () => {
  function undatedInput(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'skill',
      employerOrInstitution: null,
      officialTitle: 'Figma',
      start: null,
      end: null,
      location: null,
      description: '',
      classification: 'private',
      artifacts: [],
      ...overrides
    };
  }

  it('accepts a skill with no start at all, and the entry carries start null', () => {
    const result = validateEntry(undatedInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.start).toBeNull();
  });

  it('reads the blank shape a form posts ({ year: undefined, month: null }) as no start, not as a bad year', () => {
    const result = validateEntry(undatedInput({ start: { year: undefined, month: null } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.start).toBeNull();
  });

  it('accepts an artifact and a recognition with no start too', () => {
    expect(validateEntry(undatedInput({ kind: 'artifact' })).ok).toBe(true);
    expect(validateEntry(undatedInput({ kind: 'recognition', employerOrInstitution: 'Scrum Alliance' })).ok).toBe(true);
  });

  it('still requires a start for role_held, education and project, on the start.year field', () => {
    for (const kind of ['role_held', 'education', 'project']) {
      const result = validateEntry(undatedInput({ kind, employerOrInstitution: 'Acme Corp' }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.some((i) => i.field === 'start.year')).toBe(true);
    }
  });

  it('refuses a start month with no start year: a month of an unstated year identifies nothing', () => {
    const result = validateEntry(undatedInput({ start: { year: undefined, month: 3 } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.field === 'start.year')).toBe(true);
  });

  it('refuses an end with no start: not a range the record can print', () => {
    const result = validateEntry(undatedInput({ end: { year: 2022, month: 1 } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.field === 'end')).toBe(true);
  });

  it('still validates a dated skill exactly as before', () => {
    const result = validateEntry(undatedInput({ start: { year: 2021, month: 6 } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.start).toEqual({ year: 2021, month: 6 });
  });
});
