import { describe, expect, it } from 'vitest';
import type { ProfileEntry } from './record';
import type { LetterStyleResult, LetterTarget } from './provider';
import {
  buildLetterParagraphs,
  coreSentence,
  createParagraph,
  deterministicLetter,
  lockLetter,
  summarizeLetterProvenance,
  type LetterSelection
} from './cover-letter';

// cover-letter.ts is the engine side of a cover letter: it locks the entries
// tailor.ts selected into a LockedLetter, mints a provider's four styled
// strings into branded paragraphs whose provenance is read off the lock, and
// composes the honest deterministic letter when no model wrote one. These
// tests pin the shape and the provenance discipline, the letter counterpart of
// tailor.test.ts's bullet-provenance tests. The prose verifier is a later
// phase (letter-verify.ts) and is tested there.

function entry(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    prfId: 'PRF-0001',
    kind: 'role_held',
    employerOrInstitution: 'Acme Corp',
    officialTitle: 'Staff Designer',
    start: { year: 2021, month: 3 },
    end: null,
    location: 'Remote',
    description: 'Led the checkout redesign.\nCut page weight in half.',
    classification: 'private',
    provenance: 'you_told_us',
    artifacts: [],
    ...overrides
  };
}

function target(overrides: Partial<LetterTarget> = {}): LetterTarget {
  return {
    company: 'Acme Corp',
    title: 'Staff Designer',
    requirements: ['You have shipped a checkout flow end to end.'],
    register: 'tech',
    ...overrides
  };
}

function selection(overrides: Partial<LetterSelection> = {}): LetterSelection {
  return { proof: entry(), fit: null, skills: [], ...overrides };
}

describe('coreSentence(): the immutable core as one line', () => {
  it('names the title, the employer, and the date range', () => {
    expect(coreSentence(entry())).toBe('Staff Designer at Acme Corp, March 2021 to Present');
  });

  it('drops the "at <employer>" clause when the entry names no organization', () => {
    const skill = entry({ kind: 'skill', employerOrInstitution: null, officialTitle: 'Python', end: { year: 2024, month: 6 } });
    expect(coreSentence(skill)).toBe('Python, March 2021 to June 2024');
  });
});

describe('lockLetter(): exactly four slots, in role order, ids only where a fact is cited', () => {
  it('locks proof and fit with their ids, and leaves opener and close empty', () => {
    const fit = entry({ prfId: 'PRF-0002', officialTitle: 'Product Designer', description: 'Ran the design system.' });
    const skill = entry({ prfId: 'PRF-0003', kind: 'skill', employerOrInstitution: null, officialTitle: 'Figma', description: '' });
    const locked = lockLetter(selection({ proof: entry(), fit, skills: [skill] }), target(), 'I admire the craft.');

    expect(locked.slots.map((s) => s.role)).toEqual(['opener', 'proof', 'fit', 'close']);
    expect(locked.slots[0].sourcePrfIds).toEqual([]);
    expect(locked.slots[3].sourcePrfIds).toEqual([]);
    expect(locked.slots[1].sourcePrfIds).toEqual(['PRF-0001']);
    // The fit paragraph cites its own entry and the skills that ride on it.
    expect(locked.slots[2].sourcePrfIds).toEqual(['PRF-0002', 'PRF-0003']);
    // The skill's label rides in the fit fragments; a skill with no description
    // contributes only its officialTitle.
    expect(locked.slots[2].fragments).toContain('Figma');
    expect(locked.reason).toBe('I admire the craft.');
  });

  it('still yields a proof slot with no ids when the record has no evidence entry', () => {
    const locked = lockLetter(selection({ proof: null }), target(), null);
    expect(locked.slots[1]).toEqual({ role: 'proof', sourcePrfIds: [], fragments: [] });
  });
});

describe('deterministicLetter(): honest, from the locked facts only', () => {
  it('opens on the role and company only, never pasting the person\'s rough note', () => {
    // The deterministic path has no model to clean up the note, so it omits it
    // rather than ship its typos; a model opener carries the note's meaning
    // instead (COVER_SYSTEM_MESSAGE). Even a note with a misspelling must not
    // reach the opener here.
    const locked = lockLetter(selection(), target(), 'i wan the challenge and i work on oncology fro providence');
    const result = deterministicLetter(locked);
    expect(result.opener).toBe('I am applying for the Staff Designer role at Acme Corp.');
    expect(result.opener).not.toContain('wan');
    expect(result.opener).not.toContain('fro');
  });

  it('opens on the role and company when no note was given, claiming none', () => {
    const result = deterministicLetter(lockLetter(selection(), target(), null));
    expect(result.opener).toBe('I am applying for the Staff Designer role at Acme Corp.');
  });

  it('writes a proof paragraph from the core sentence and its description lines', () => {
    const result = deterministicLetter(lockLetter(selection(), target(), null));
    expect(result.proof).toBe('Staff Designer at Acme Corp, March 2021 to Present. Led the checkout redesign. Cut page weight in half.');
  });

  it('leaves proof empty when the evidence entry has no description line', () => {
    const bare = entry({ description: '' });
    const result = deterministicLetter(lockLetter(selection({ proof: bare }), target(), null));
    expect(result.proof).toBe('');
    expect(result.fit).toBe('');
  });

  it('opens on the posting when there is no company to name (free text)', () => {
    const result = deterministicLetter(lockLetter(selection(), target({ company: '', title: null }), null));
    expect(result.opener).toBe('I am applying for the role in your posting.');
  });

  it('is a pure function of the lock: called twice, byte-identical', () => {
    const locked = lockLetter(selection(), target(), 'Reason.');
    expect(JSON.stringify(deterministicLetter(locked))).toBe(JSON.stringify(deterministicLetter(locked)));
  });
});

describe('createParagraph(): unconstructible without resolving its ids', () => {
  const known = new Set(['PRF-0001', 'PRF-0002']);

  it('mints an opener with no ids', () => {
    const p = createParagraph('opener', 'Hello.', [], known);
    expect(p.role).toBe('opener');
    expect(p.sourcePrfIds).toEqual([]);
  });

  it('throws when a proof paragraph carries no source ids', () => {
    expect(() => createParagraph('proof', 'A claim.', [], known)).toThrow(/no source PRF ids/);
  });

  it('throws when a cited id is not in the record', () => {
    expect(() => createParagraph('proof', 'A claim.', ['PRF-9999'], known)).toThrow(/not in the record/);
  });
});

describe('buildLetterParagraphs(): provenance read off the lock, empties skipped', () => {
  const known = new Set(['PRF-0001', 'PRF-0002']);

  it('skips an empty role and takes ids straight off the lock, never the styled result', () => {
    const fit = entry({ prfId: 'PRF-0002', description: 'Ran the design system.' });
    const locked = lockLetter(selection({ proof: entry(), fit }), target(), 'Reason.');
    const styled: LetterStyleResult = { opener: 'Opener.', proof: 'Proof prose.', fit: '', close: 'Close.' };

    const paragraphs = buildLetterParagraphs(styled, locked, known);
    // fit was empty in the styled result, so no fit paragraph.
    expect(paragraphs.map((p) => p.role)).toEqual(['opener', 'proof', 'close']);
    const proof = paragraphs.find((p) => p.role === 'proof');
    expect(proof?.sourcePrfIds).toEqual(['PRF-0001']);
  });

  it('never mints a proof paragraph when the slot cites nothing, even if the model wrote one', () => {
    const locked = lockLetter(selection({ proof: null }), target(), null);
    const styled: LetterStyleResult = { opener: 'Opener.', proof: 'The model fabricated a proof.', fit: '', close: 'Close.' };
    const paragraphs = buildLetterParagraphs(styled, locked, known);
    expect(paragraphs.some((p) => p.role === 'proof')).toBe(false);
  });
});

describe('summarizeLetterProvenance(): counts only fact-bearing paragraphs', () => {
  it('counts proof and fit, never opener or close', () => {
    const known = new Set(['PRF-0001', 'PRF-0002']);
    const fit = entry({ prfId: 'PRF-0002', description: 'Ran the design system.' });
    const locked = lockLetter(selection({ proof: entry(), fit }), target(), 'Reason.');
    const styled: LetterStyleResult = { opener: 'Opener.', proof: 'Proof.', fit: 'Fit.', close: 'Close.' };
    const paragraphs = buildLetterParagraphs(styled, locked, known);

    const provenance = summarizeLetterProvenance(paragraphs);
    expect(provenance.bulletCount).toBe(2);
    expect(provenance.citedPrfIds).toEqual(['PRF-0001', 'PRF-0002']);
  });
});
