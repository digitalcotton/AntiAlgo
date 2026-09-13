import { describe, expect, it } from 'vitest';
import type { LetterStyleResult, LockedLetter } from './provider';
import { verifyLetterResult } from './letter-verify';

// letter-verify.ts is the fact checker for a model-written cover letter. These
// tests pin the covenant made mechanical: a number or a named thing that is not
// in the record, the reason, or the posting is rejected, and a first-person
// claim may never borrow a fact only the posting states. A rejected letter is
// how the generative path falls back to the deterministic one; false rejects
// are safe, false accepts are the failure this suite exists to prevent.

function lockedLetter(overrides: Partial<LockedLetter> = {}): LockedLetter {
  return {
    document: 'cover_letter',
    slots: [
      { role: 'opener', sourcePrfIds: [], fragments: [] },
      { role: 'proof', sourcePrfIds: ['PRF-0001'], fragments: ['Staff Designer at Acme Corp, March 2021 to Present', 'Led the checkout redesign that lifted conversion 12 percent.'] },
      { role: 'fit', sourcePrfIds: ['PRF-0002', 'PRF-0003'], fragments: ['Product Designer at Beta, January 2019 to February 2021', 'Ran the design system.', 'Figma'] },
      { role: 'close', sourcePrfIds: [], fragments: [] }
    ],
    target: {
      company: 'OpenAI',
      title: 'Product Designer',
      requirements: ['You have shipped a checkout flow end to end.', 'Experience with Figma and design systems.'],
      register: 'tech'
    },
    reason: 'I admire your work on creative tools.',
    ...overrides
  };
}

// A good letter: every number and named thing traces to the lock, the reason
// anchors the opener, the company is named, and it clears the length floor.
const GOOD: LetterStyleResult = {
  opener: 'I am applying for the Product Designer role at OpenAI. I admire your work on creative tools.',
  proof:
    'At Acme Corp I led the checkout redesign, and it lifted conversion 12 percent over the prior version. Your posting asks for someone who has shipped a checkout flow end to end, and that is the work I owned there, from the first sketch through launch and the weeks of tuning after it. I ran the tests, read the session recordings, and rewrote the error states until the page stopped losing people.',
  fit:
    'At Beta I ran the design system and I work daily in Figma. That systems focus is close to how your team builds its own tools. I like small groups that ship and then listen, and I would bring the same habit of honest, testable steps to the role. I care about clear type and fast pages, and I write copy a reader can actually follow.',
  close:
    'The resume with this letter carries the full record. I would welcome a short call to walk through where I could help first, and to hear how you are thinking about the year ahead.'
};

const OPTS = { companyName: 'OpenAI' };

function reasonOf(result: LetterStyleResult): string {
  const verdict = verifyLetterResult(lockedLetter(), result, OPTS);
  return verdict.ok ? '' : verdict.reason;
}

describe('verifyLetterResult(): a good letter passes', () => {
  it('accepts a letter whose every fact traces to the lock', () => {
    const verdict = verifyLetterResult(lockedLetter(), GOOD, OPTS);
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
  });
});

describe('verifyLetterResult(): fabricated facts are rejected', () => {
  it('rejects a number that is nowhere in the record, reason, or posting', () => {
    const bad = { ...GOOD, proof: GOOD.proof.replace('12 percent', '40 percent') };
    expect(reasonOf(bad)).toMatch(/number/i);
  });

  it('rejects an entity that is nowhere in the corpus', () => {
    const bad = { ...GOOD, proof: 'At Acme Corp I shipped a service on Kubernetes for the checkout team.' };
    expect(reasonOf(bad)).toMatch(/kubernetes/i);
  });

  it('rejects a first-person claim built on a requirement only the posting states', () => {
    // Kubernetes is named only in the posting requirement, never in the record.
    // Naming it is fine; claiming "I have used Kubernetes" is not.
    // Keep the default record (which holds the 12 percent proof), and put
    // Kubernetes only in the posting; the bad fit then claims it in first person.
    const locked = lockedLetter({
      target: { company: 'OpenAI', title: 'Product Designer', requirements: ['Experience with Kubernetes in production.'], register: 'tech' }
    });
    const bad: LetterStyleResult = {
      ...GOOD,
      fit: 'At Beta I ran the design system and I have used Kubernetes across every project I touched.'
    };
    const verdict = verifyLetterResult(locked, bad, OPTS);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toMatch(/kubernetes/i);
  });

  it('rejects a first-person number that only the posting states', () => {
    const locked = lockedLetter({
      target: { company: 'OpenAI', title: 'Product Designer', requirements: ['We are hiring 5 designers this year.'], register: 'tech' }
    });
    const bad: LetterStyleResult = { ...GOOD, fit: 'At Beta I ran the design system, and I have led 5 designers of my own.' };
    const verdict = verifyLetterResult(locked, bad, OPTS);
    expect(verdict.ok).toBe(false);
  });

  it('allows a target-only number when it is the posting\'s statement, not a personal claim', () => {
    const locked = lockedLetter({
      target: { company: 'OpenAI', title: 'Product Designer', requirements: ['You are hiring 5 designers this year.'], register: 'tech' }
    });
    const good: LetterStyleResult = {
      ...GOOD,
      // The number 5 rides in a sentence that is the posting's statement, with
      // no first-person verb; the first-person sentence beside it carries none.
      fit: 'At Beta I ran the design system and I work daily in Figma. Your posting says you are hiring 5 designers this year. That scale is where I do my best work.'
    };
    const verdict = verifyLetterResult(locked, good, OPTS);
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
  });
});

describe('verifyLetterResult(): the mechanical red lines', () => {
  it('rejects a letter that never names the company', () => {
    const bad = { ...GOOD, opener: 'I am applying for the Product Designer role. I admire your work on creative tools.' };
    expect(reasonOf(bad)).toMatch(/company/i);
  });

  it('accepts an opener that carries the reason\'s meaning without copying it verbatim', () => {
    // The reason is a rough note the model cleans up; the verifier must NOT
    // require it byte-for-byte (that would reject the cleaned-up opener and ship
    // the person's typos). Fact-safety still holds: any fact the opener draws
    // from the note traces to the reason corpus (C1/C3), and an opener that
    // omits the note entirely is a quality miss, not a fabrication, so it passes.
    const paraphrased = { ...GOOD, opener: 'I am applying for the Product Designer role at OpenAI. Your work on creative tools is why I am here.' };
    const verdict = verifyLetterResult(lockedLetter(), paraphrased, OPTS);
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
  });

  it('lets a reason fact appear anywhere, but a genuine fabrication still fails', () => {
    // The reason is the person's own claim (a 3.3 exception), so a fact it
    // states is permitted in any paragraph, not the opener alone. A number that
    // is in NEITHER the record NOR the reason NOR the posting is still a
    // fabrication and still fails.
    const locked = lockedLetter({ reason: 'I have wanted this since my first design job 15 years ago.' });
    const reasonInProof = { ...GOOD, proof: GOOD.proof + ' I have carried this craft for 15 years.' };
    expect(verifyLetterResult(locked, reasonInProof, OPTS).ok).toBe(true);
    const fabricated = { ...GOOD, proof: GOOD.proof + ' I have carried this craft for 99 years.' };
    expect(verifyLetterResult(locked, fabricated, OPTS).ok).toBe(false);
  });

  it('rejects a leaked PRF id or Source line', () => {
    const bad = { ...GOOD, proof: GOOD.proof + ' Source: PRF-0001.' };
    expect(reasonOf(bad)).toMatch(/prf|source/i);
  });

  it('rejects an AI disclosure', () => {
    const bad = { ...GOOD, close: 'This letter was generated by a language model on my behalf.' };
    expect(reasonOf(bad)).toMatch(/tool wrote it/i);
  });

  // The verifier's fact allowlist arrives as opts.fullRecordText (the whole
  // record), the same wiring runLetterAttempt uses; a brand the record states
  // is traced against it.
  const optsWith = (record: string) => ({ companyName: 'OpenAI', fullRecordText: record });
  const AI_RECORD = 'AI product designer who shipped a ChatGPT-style platform for enterprise support teams.';

  it('still rejects each disclosure phrase, whatever the corpus holds', () => {
    for (const close of [
      'As an AI, I drafted this on the applicant\'s behalf.',
      'I am a language model writing on their behalf.',
      'This letter was written by an AI assistant.'
    ]) {
      const verdict = verifyLetterResult(lockedLetter(), { ...GOOD, close }, optsWith(AI_RECORD));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/tool wrote it/i);
    }
  });

  it('does not misread "as an AI product designer" as a disclosure', () => {
    // The record calls the person an AI product designer, so "AI" traces, and
    // "as an ai product designer" is ordinary English, not a confession.
    const fit = `${GOOD.fit} As an AI product designer I care about the same problems.`;
    const verdict = verifyLetterResult(lockedLetter(), { ...GOOD, fit }, optsWith(AI_RECORD));
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
  });

  it('accepts a tool brand name the record itself states', () => {
    // The person shipped a ChatGPT-style platform; naming it is a fact, not a
    // confession that a tool wrote the letter.
    const proof = `${GOOD.proof} That platform was ChatGPT-style, built for support teams.`;
    const verdict = verifyLetterResult(lockedLetter(), { ...GOOD, proof }, optsWith(AI_RECORD));
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
  });

  it('rejects a lowercase tool brand name nowhere in the corpus (which C3 would miss)', () => {
    // C3 only traces capitalized entities, so a lowercase "chatgpt" slips past
    // it; C10b is what catches an invented tool named in lower case.
    const bad = { ...GOOD, proof: `${GOOD.proof} I built that with chatgpt beside me.` };
    const reason = reasonOf(bad);
    expect(reason).toMatch(/chatgpt/i);
    expect(reason).toMatch(/AI tool/i);
  });

  it('names the target company even when it is an AI lab', () => {
    // OpenAI is the company on the lock; the letter naming it must pass, not
    // read as a stray tool name.
    const verdict = verifyLetterResult(lockedLetter(), GOOD, OPTS);
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
  });

  it('repairs an em dash instead of rejecting the letter', () => {
    // A dash is losslessly fixable, so a truthful letter is never discarded over
    // one: it is recast (per the house rule) and the letter passes, and the
    // shipped paragraph carries no dash.
    const emDash = String.fromCodePoint(0x2014);
    const withDash = { ...GOOD, proof: GOOD.proof.replace('12 percent', `12 percent${emDash}the best result on the team`) };
    const verdict = verifyLetterResult(lockedLetter(), withDash, OPTS);
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
    if (verdict.ok) expect(verdict.paragraphs.proof).not.toContain(emDash);
  });

  it('rejects a missing or empty paragraph', () => {
    const bad = { ...GOOD, fit: '' };
    expect(reasonOf(bad)).toMatch(/empty/i);
  });

  it('rejects an unexpected extra paragraph key', () => {
    const bad = { ...GOOD, postscript: 'One more thing.' } as unknown as LetterStyleResult;
    expect(reasonOf(bad)).toMatch(/unexpected/i);
  });

  it('rejects a letter far under the length floor', () => {
    const bad: LetterStyleResult = {
      opener: 'I want the Product Designer role at OpenAI. I admire your work on creative tools.',
      proof: 'At Acme Corp I did the checkout work.',
      fit: 'At Beta I ran the design system.',
      close: 'Thank you.'
    };
    expect(reasonOf(bad)).toMatch(/length/i);
  });
});

describe('verifyLetterResult(): the fuzzy, full-record fact model', () => {
  it('accepts the model cleaning "south east" into "Southeast" in the opener', () => {
    const locked = lockedLetter({ reason: 'i wan the challenge and i worked in critical systems in the south east' });
    const good = { ...GOOD, opener: 'I am applying for the Product Designer role at OpenAI. I want the challenge, and I have worked on critical systems in the Southeast.' };
    const verdict = verifyLetterResult(locked, good, OPTS);
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
  });

  it('folds spacing and pluralization anywhere: a record "system" matches "systems"', () => {
    // The fit slot's fragment says "design system" (singular); the proof names
    // "Design Systems" (capitalized plural). The dense/plural fold must accept
    // it without a reason relaxation, proving the fold works beyond the opener.
    const good = { ...GOOD, proof: `${GOOD.proof} At Acme Corp I also owned the Design Systems that tie the product together.` };
    const verdict = verifyLetterResult(lockedLetter(), good, OPTS);
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
  });

  it('trusts a fact in the WHOLE record, not just the two selected entries', () => {
    // Providence is a real record entry the letter did not select for proof/fit.
    // Named in a body paragraph it must pass with the full-record allowlist, and
    // fail without it (the old, selected-slots-only corpus).
    const locked = lockedLetter();
    const namesProvidence = { ...GOOD, fit: `${GOOD.fit} The same care shows in my oncology work at Providence.` };
    expect(verifyLetterResult(locked, namesProvidence, { companyName: 'OpenAI' }).ok).toBe(false);
    const withFullRecord = { companyName: 'OpenAI', fullRecordText: 'Lead Product Designer, Oncology and Enterprise Healthcare. Providence. Cut oncology onboarding time.' };
    expect(verifyLetterResult(locked, namesProvidence, withFullRecord).ok, 'should pass with full record').toBe(true);
  });

  it('accepts "OpenAI" when the verified company is "OpenAI, Inc."', () => {
    const verdict = verifyLetterResult(lockedLetter(), GOOD, { companyName: 'OpenAI, Inc.' });
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
  });
});
