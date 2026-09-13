import { describe, expect, it } from 'vitest';
import type { Job } from './data';
import type { Target } from './tailor';
import { extractLetterTarget } from './posting-requirements';

// posting-requirements.ts reduces a posting to the requirement lines a cover
// letter should answer, scored by how well the person's own record can answer
// them. These tests pin that it lifts requirement lines and not benefits or
// legal boilerplate, keeps the employer's own order, detects the register that
// picks the salutation, and degrades honestly to an empty list when a posting
// carries no description.

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    slug: 'acme-staff-designer',
    company: 'Acme Corp',
    title: 'Staff Product Designer',
    description_html: '',
    ...overrides
  } as Job;
}

function posting(overrides: Partial<Job> = {}): Target {
  return { kind: 'verified_posting', job: job(overrides) };
}

// The person's own words, as tailor.ts would build them from the record.
const recordVocabulary = new Set(['checkout', 'design', 'product', 'figma', 'shipped', 'portfolio', 'systems']);

const DESCRIPTION = `
  <h3>Requirements</h3>
  <ul>
    <li>You have shipped a checkout flow end to end.</li>
    <li>Five years of product design experience.</li>
    <li>Strong Figma skills and a portfolio of shipped work.</li>
  </ul>
  <h3>Benefits</h3>
  <ul>
    <li>We offer a competitive salary and full health insurance.</li>
    <li>Unlimited paid time off and a 401k match.</li>
  </ul>
  <p>We are an equal opportunity employer and value a diverse team.</p>
`;

describe('extractLetterTarget(): the requirement lines a letter should answer', () => {
  it('lifts three to five requirement lines and none of the benefits or legal lines', () => {
    const result = extractLetterTarget(posting({ description_html: DESCRIPTION }), recordVocabulary);
    expect(result.requirements.length).toBeGreaterThanOrEqual(3);
    expect(result.requirements.length).toBeLessThanOrEqual(5);

    const joined = result.requirements.join('\n');
    expect(joined).toContain('checkout flow end to end');
    expect(joined).toContain('product design experience');
    expect(joined).toContain('Figma');

    // Benefits, pay, and legal boilerplate never become a requirement to answer.
    for (const excluded of ['salary', 'insurance', 'paid time off', '401k', 'equal opportunity']) {
      expect(joined.toLowerCase()).not.toContain(excluded);
    }
  });

  it('keeps the employer\'s own order, not a re-rank by score', () => {
    const result = extractLetterTarget(posting({ description_html: DESCRIPTION }), recordVocabulary);
    const checkoutAt = result.requirements.findIndex((r) => r.includes('checkout'));
    const figmaAt = result.requirements.findIndex((r) => r.includes('Figma'));
    expect(checkoutAt).toBeGreaterThanOrEqual(0);
    expect(figmaAt).toBeGreaterThan(checkoutAt);
  });

  it('carries the posting\'s own company and title through verbatim', () => {
    const result = extractLetterTarget(posting({ company: 'Northwind', title: 'Staff Designer', description_html: DESCRIPTION }), recordVocabulary);
    expect(result.company).toBe('Northwind');
    expect(result.title).toBe('Staff Designer');
  });

  it('reads a design role as tech register and a non-tech role as formal', () => {
    const design = extractLetterTarget(posting({ title: 'Staff Product Designer', description_html: DESCRIPTION }), recordVocabulary);
    expect(design.register).toBe('tech');

    const clinic = extractLetterTarget(
      posting({ company: 'City Clinic', title: 'Registered Nurse', description_html: '<p>Care for patients on the ward.</p>' }),
      new Set<string>()
    );
    expect(clinic.register).toBe('formal');
  });

  it('returns no requirements for a posting with no description, rather than inventing them', () => {
    const result = extractLetterTarget(posting({ description_html: '' }), recordVocabulary);
    expect(result.requirements).toEqual([]);
  });

  it('a free-text target names no company or title and stays formal', () => {
    const result = extractLetterTarget({ kind: 'free_text', text: 'A remote design role at a small studio.' }, recordVocabulary);
    expect(result.company).toBe('');
    expect(result.title).toBeNull();
    expect(result.register).toBe('formal');
  });

  it('caps a very long requirement line at a readable length', () => {
    // Under the 45-word ceiling but over 300 characters: long words, few of
    // them, so it survives as a candidate and exercises the length cap.
    const longLine = `<h3>Requirements</h3><ul><li>You have ${'developing '.repeat(38)}systems.</li></ul>`;
    const result = extractLetterTarget(posting({ description_html: longLine }), recordVocabulary);
    expect(result.requirements.length).toBe(1);
    expect(result.requirements[0].length).toBeLessThanOrEqual(300);
  });
});
