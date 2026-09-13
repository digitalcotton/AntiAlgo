import { describe, expect, it } from 'vitest';
import { SKILL_ALIASES, SKILL_ALIASES_VERSION, pairedFormFor } from './skill-aliases';

/**
 * skill-aliases.ts is the closed, curated set mirroring may draw on, and the one
 * decision function behind RESUME-RULES.md layer 2's "mirror once". These tests
 * pin the safety rules the table exists to enforce: a pairing fires only for a
 * skill the record holds, only when the posting uses the OTHER form, and never
 * from a substring match that would fire an acronym inside an ordinary word.
 */

describe('pairedFormFor(): pairs a held skill with the posting term, or nothing', () => {
  it('pairs the record long form with the posting short form', () => {
    expect(pairedFormFor('Kubernetes', 'We run everything on K8s in production.')).toBe('K8s');
  });

  it('pairs the record short form with the posting long form', () => {
    expect(pairedFormFor('K8s', 'Deep Kubernetes experience is required.')).toBe('Kubernetes');
  });

  it('adds nothing when the posting already uses the record\'s own form', () => {
    expect(pairedFormFor('Kubernetes', 'Kubernetes is central to this role.')).toBeNull();
  });

  it('adds nothing when the posting mentions neither form', () => {
    expect(pairedFormFor('Kubernetes', 'A design role with no infrastructure at all.')).toBeNull();
  });

  it('never pairs a skill that is not itself one side of a curated pair', () => {
    // The posting is full of pairable terms, but the record skill is not one of
    // them, so nothing is added: mirroring can only ever pair a skill the record
    // already holds.
    expect(pairedFormFor('Python', 'We use K8s, CI/CD, and an ATS heavily.')).toBeNull();
  });

  it('matches an acronym as its own token, not as a substring of another word', () => {
    // "flats" contains the letters of "ats" but not bounded, so the ATS pairing
    // must not fire; a real ATS mention does.
    expect(pairedFormFor('Applicant Tracking System', 'We manage flats and rentals.')).toBeNull();
    expect(pairedFormFor('Applicant Tracking System', 'Our ATS is Greenhouse.')).toBe('ATS');
  });

  it('handles a form that carries punctuation', () => {
    expect(pairedFormFor('Profit and Loss', 'You will own the P&L for the unit.')).toBe('P&L');
    expect(pairedFormFor('P&L', 'Responsible for profit and loss.')).toBe('Profit and Loss');
  });

  it('is case-insensitive on both the record form and the posting mention', () => {
    expect(pairedFormFor('kubernetes', 'we use k8s here')).toBe('K8s');
  });
});

describe('the alias table itself', () => {
  it('carries a version, so a change to what mirroring may say is a visible edit', () => {
    expect(SKILL_ALIASES_VERSION).toMatch(/^skill-aliases-v\d+$/);
  });

  it('holds no empty forms', () => {
    for (const pair of SKILL_ALIASES) {
      expect(pair.long.trim().length).toBeGreaterThan(0);
      expect(pair.short.trim().length).toBeGreaterThan(0);
    }
  });
});
