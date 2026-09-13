import { describe, it, expect } from 'vitest';
import {
  classifyField,
  detectSituation,
  packFor,
  packGuidanceText,
  type CoverField
} from './cover-context';
import type { ProfileEntry } from './record';

/**
 * The context-pack layer (cover-context.ts): the field classifier, the
 * situation detector, and the pack table with the skill's intersection rules
 * (contexts.md section 1). Pure over the strings and record given.
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

describe('classifyField: a posting reads as one field', () => {
  const cases: readonly [string, CoverField][] = [
    ['Senior Software Engineer building our API platform', 'tech'],
    ['Registered Nurse, oncology unit, bedside patient care', 'healthcare'],
    ['Account Executive owning quota and pipeline', 'sales'],
    ['Brand Designer shaping our visual identity', 'creative'],
    ['Financial Analyst supporting the audit and consulting practice', 'corporate'],
    ['Warehouse Associate, morning shift', 'general']
  ];
  for (const [text, field] of cases) {
    it(`reads "${text}" as ${field}`, () => {
      expect(classifyField(text)).toBe(field);
    });
  }

  it('a federal posting outranks the field words it also contains', () => {
    // A federal nursing posting is federal: its mechanics dominate the letter,
    // so the federal pattern is tested before healthcare.
    expect(classifyField('USAJOBS announcement number 123: staff nurse, GS-11')).toBe('federal');
  });

  it('falls back to general when nothing reads clearly', () => {
    expect(classifyField('Join a growing team doing meaningful work')).toBe('general');
  });
});

describe('detectSituation: the person against the target', () => {
  it('reads an internal move when the record holds a role at the target company', () => {
    const record = [entry({ employerOrInstitution: 'Northwind' })];
    expect(detectSituation(record, 'tech', 'Northwind')).toBe('internal');
  });

  it('a credential ISSUED BY the target company is not an internal move', () => {
    // A recognition entry whose issuer (now the employer field) is the target
    // company must not read as "works there": earning an OpenAI certificate is
    // not being an OpenAI insider.
    const record = [
      entry({ kind: 'recognition', officialTitle: 'Certified Practitioner', employerOrInstitution: 'Northwind', description: '' })
    ];
    expect(detectSituation(record, 'tech', 'Northwind')).not.toBe('internal');
  });

  it('reads executive from a senior title', () => {
    const record = [entry({ officialTitle: 'VP of Engineering', employerOrInstitution: 'Elsewhere' })];
    expect(detectSituation(record, 'tech', 'Northwind')).toBe('executive');
  });

  it('reads new grad from recent education and a thin work record', () => {
    const record = [
      entry({ prfId: 'PRF-E1', kind: 'education', officialTitle: 'BS Computer Science', employerOrInstitution: 'State University', end: { year: 2026, month: 5 } })
    ];
    expect(detectSituation(record, 'tech', 'Northwind')).toBe('new_grad');
  });

  it('reads a career change when the record field differs from a non-general target', () => {
    const record = [
      entry({ officialTitle: 'Line Cook', employerOrInstitution: 'A Restaurant', description: 'Ran a busy kitchen section.' })
    ];
    // The record classifies as general here, so a plain cook is NOT auto-flagged
    // a changer (general never triggers it). A record with a clear prior field does.
    const nurse = [
      entry({ officialTitle: 'Registered Nurse', employerOrInstitution: 'A Hospital', description: 'Oncology bedside patient care.' })
    ];
    expect(detectSituation(nurse, 'tech', null)).toBe('career_changer');
    expect(detectSituation(record, 'tech', null)).toBe('standard');
  });

  it('reads standard when nothing special applies', () => {
    const record = [entry({ officialTitle: 'Software Engineer', employerOrInstitution: 'Elsewhere', description: 'Built backend services.' })];
    expect(detectSituation(record, 'tech', 'Northwind')).toBe('standard');
  });
});

describe('packFor: the intersection rules (contexts.md section 1)', () => {
  it('an internal letter takes the shorter cap', () => {
    const corporate = packFor('corporate', 'standard');
    const internal = packFor('corporate', 'internal');
    expect(internal.hardMax).toBeLessThan(corporate.hardMax);
    expect(internal.softMax).toBeLessThanOrEqual(200);
  });

  it('an executive letter uses its own tighter band', () => {
    const exec = packFor('corporate', 'executive');
    expect(exec.softMin).toBe(300);
    expect(exec.softMax).toBeLessThanOrEqual(380);
  });

  it('unions the field and situation moves: a career changer keeps its motive move', () => {
    const pack = packFor('corporate', 'career_changer');
    // The field's quantified-achievement move survives.
    expect(pack.mandatory.some((m) => /quantified/i.test(m))).toBe(true);
    // The situation's mandatory motive move is added, not dropped.
    expect(pack.mandatory.some((m) => /motive/i.test(m))).toBe(true);
    expect(pack.forbidden.some((f) => /unexplained/i.test(f))).toBe(true);
  });

  it('the register comes from the field, not the situation', () => {
    expect(packFor('tech', 'executive').warm).toBe(true);
    expect(packFor('corporate', 'standard').warm).toBe(false);
  });
});

describe('packGuidanceText: the house-rules block', () => {
  it('states the word band and carries a mandatory move', () => {
    const text = packGuidanceText(packFor('sales', 'standard'));
    expect(text).toMatch(/Aim for about \d+ to \d+ words/);
    expect(text).toContain('Must do:');
    expect(text).toMatch(/strongest number/i);
  });
});
