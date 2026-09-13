/**
 * names.test.ts: the name helpers from auth.ts.
 *
 * WHY THESE ARE TESTED AND THE HOOK AROUND THEM IS NOT. The account-creation
 * hook needs a database and a real signup, so it is proven by observation on a
 * deployment instead. These functions are pure, they handle the input a
 * stranger controls, and they are the difference between "Hi Ryan," and "Hi
 * null," in an outreach draft. Pure and attacker-facing is exactly what belongs
 * in a unit test.
 *
 * sanitiseNameForStorage() WAS ADDED ALONGSIDE src/pages/settings/
 * name.ts, THE SETTINGS-PAGE NAME EDIT. See that function's own comment in
 * auth.ts for the full reasoning; the short version is RUN-FINISH 2.1, quoted
 * there: "a person's name is stored verbatim... sanitise for safety, never
 * for taste." Its own describe block below is written specifically to prove
 * the half of that promise sanitiseName() does NOT keep (it collapses
 * whitespace and trims, correct for its own caller, namesFrom() at sign-up):
 * a leading or trailing space, and an interior run of more than one space,
 * both survive sanitiseNameForStorage() untouched.
 */
import { describe, expect, it } from 'vitest';
import { namesFrom, sanitiseName, sanitiseNameForStorage } from './auth';

describe('sanitiseName', () => {
  it('keeps an ordinary name unchanged', () => {
    expect(sanitiseName('Ryan')).toBe('Ryan');
  });

  it('flattens the newlines that make a name a header-injection shape', () => {
    expect(sanitiseName('Ryan\r\nBcc: someone@example.com')).toBe('Ryan Bcc: someone@example.com');
  });

  it('collapses runs of whitespace and trims the ends', () => {
    expect(sanitiseName('  van   der  Berg  ')).toBe('van der Berg');
  });

  it('caps at the length the database constraint allows', () => {
    expect(sanitiseName('a'.repeat(500))).toHaveLength(120);
  });

  it('turns nothing into an empty string rather than "null"', () => {
    expect(sanitiseName(null)).toBe('');
    expect(sanitiseName(undefined)).toBe('');
  });
});

describe('sanitiseNameForStorage: verbatim, safety only', () => {
  it('keeps an ordinary name unchanged', () => {
    expect(sanitiseNameForStorage('Ryan')).toBe('Ryan');
  });

  it('keeps a leading and trailing space, the exact case sanitiseName() strips', () => {
    expect(sanitiseNameForStorage('  Ryan  ')).toBe('  Ryan  ');
  });

  it('keeps an interior run of more than one space, the other case sanitiseName() collapses', () => {
    expect(sanitiseNameForStorage('van   der  Berg')).toBe('van   der  Berg');
  });

  it('still flattens the newlines that make a name a header-injection shape', () => {
    expect(sanitiseNameForStorage('Ryan\r\nBcc: someone@example.com')).toBe('Ryan  Bcc: someone@example.com');
  });

  it('still caps at the length the database constraint allows', () => {
    expect(sanitiseNameForStorage('a'.repeat(500))).toHaveLength(120);
  });

  it('caps length without touching a leading/trailing space still inside the limit', () => {
    const padded = ` ${'a'.repeat(118)} `;
    expect(sanitiseNameForStorage(padded)).toBe(padded);
  });

  it('turns nothing into an empty string rather than "null"', () => {
    expect(sanitiseNameForStorage(null)).toBe('');
    expect(sanitiseNameForStorage(undefined)).toBe('');
  });
});

describe('namesFrom', () => {
  it('prefers what the person typed over anything derived', () => {
    const context = { body: { first_name: 'Ryan', last_name: 'Payne' } };
    expect(namesFrom(context, 'Somebody Else')).toEqual({ first: 'Ryan', last: 'Payne' });
  });

  it('accepts the camelCase spelling too', () => {
    const context = { body: { firstName: 'Ada', lastName: 'Lovelace' } };
    expect(namesFrom(context, '')).toEqual({ first: 'Ada', last: 'Lovelace' });
  });

  it('keeps a multi-word surname whole when it was typed as one', () => {
    const context = { body: { first_name: 'Jan', last_name: 'van der Berg' } };
    expect(namesFrom(context, 'Jan van der Berg').last).toBe('van der Berg');
  });

  it('falls back to splitting the single name a non-form signup supplies', () => {
    expect(namesFrom({}, 'Ryan Payne')).toEqual({ first: 'Ryan', last: 'Payne' });
  });

  it('puts everything after the first word in the surname when splitting', () => {
    expect(namesFrom({}, 'Jan van der Berg')).toEqual({ first: 'Jan', last: 'van der Berg' });
  });

  it('leaves the surname empty rather than inventing one', () => {
    expect(namesFrom({}, 'Prince')).toEqual({ first: 'Prince', last: '' });
  });

  it('survives a request shape it does not recognise', () => {
    expect(namesFrom(undefined, undefined)).toEqual({ first: '', last: '' });
    expect(namesFrom(null, '')).toEqual({ first: '', last: '' });
  });

  it('does not treat a half-filled pair as absent', () => {
    expect(namesFrom({ body: { first_name: 'Cher' } }, 'Ignore Me')).toEqual({ first: 'Cher', last: '' });
  });
});
