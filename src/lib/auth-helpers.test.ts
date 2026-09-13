import { describe, expect, it } from 'vitest';
import { namesFrom, sanitiseName, sanitiseSource } from './auth';

describe('namesFrom', () => {
  it('prefers the two typed parts', () => {
    expect(namesFrom({ body: { first_name: ' Ryan ', last_name: 'Payne' } }, 'x y')).toEqual({ first: 'Ryan', last: 'Payne' });
  });
  it('falls back to splitting the single name', () => {
    expect(namesFrom({ body: {} }, 'Ryan Payne')).toEqual({ first: 'Ryan', last: 'Payne' });
    expect(namesFrom(undefined, 'Ryan')).toEqual({ first: 'Ryan', last: '' });
  });
});

describe('sanitiseName', () => {
  it('collapses whitespace and caps the length', () => {
    expect(sanitiseName('  a   b ')).toBe('a b');
    expect(sanitiseName('x'.repeat(200)).length).toBe(120);
  });
});

describe('sanitiseSource', () => {
  it('keeps only [a-z0-9_-] and defaults to direct', () => {
    expect(sanitiseSource('Start-Hero!')).toBe('start-hero');
    expect(sanitiseSource('')).toBe('direct');
    expect(sanitiseSource(null)).toBe('direct');
  });
});
