import { describe, it, expect } from 'vitest';
import { isAllowedReturn, returnTo } from './return-to';

describe('isAllowedReturn', () => {
  it('returns true for "/start"', () => {
    expect(isAllowedReturn('/start')).toBe(true);
  });

  it('returns true for "/start?step=4"', () => {
    expect(isAllowedReturn('/start?step=4')).toBe(true);
  });

  it('returns true for "/start?step=door"', () => {
    expect(isAllowedReturn('/start?step=door')).toBe(true);
  });

  it('returns true for "/start?step=4&saved=1"', () => {
    expect(isAllowedReturn('/start?step=4&saved=1')).toBe(true);
  });

  it('returns true for "/start?step=3&controls=1"', () => {
    expect(isAllowedReturn('/start?step=3&controls=1')).toBe(true);
  });

  it('returns false for a controls marker with any other value', () => {
    expect(isAllowedReturn('/start?step=3&controls=2')).toBe(false);
  });

  it('returns false for "/start?step=7"', () => {
    expect(isAllowedReturn('/start?step=7')).toBe(false);
  });

  it('returns false for "/starter"', () => {
    expect(isAllowedReturn('/starter')).toBe(false);
  });

  it('returns false for "https://evil.example/start"', () => {
    expect(isAllowedReturn('https://evil.example/start')).toBe(false);
  });

  it('returns false for "//evil.example"', () => {
    expect(isAllowedReturn('//evil.example')).toBe(false);
  });

  it('returns false for a non-string value', () => {
    expect(isAllowedReturn(123 as unknown as string)).toBe(false);
  });
});

describe('returnTo', () => {
  it('returns the fallback verbatim when the form has no return field', () => {
    const form = new FormData();
    expect(returnTo(form, '/default')).toBe('/default');
  });

  it('returns the fallback verbatim when the form has a refused return field', () => {
    const form = new FormData();
    form.append('return', '/starter');
    expect(returnTo(form, '/default')).toBe('/default');
  });

  it('returns the allowed return value when the form has an allowed return field', () => {
    const form = new FormData();
    form.append('return', '/start?step=4&saved=1');
    expect(returnTo(form, '/default')).toBe('/start?step=4&saved=1');
  });
});
