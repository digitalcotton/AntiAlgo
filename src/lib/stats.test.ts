import { describe, expect, it } from 'vitest';
import { count, dayStamp, sweptStamp } from './stats';

describe('sweptStamp', () => {
  it("prints the index's own stamp format by slicing", () => {
    expect(sweptStamp('2026-09-13T07:32:47.000Z')).toBe('Sep 13, 2026, 07:32 UTC');
    expect(sweptStamp('2026-01-05T00:00:00Z')).toBe('Jan 5, 2026, 00:00 UTC');
  });
  it('returns an unreadable value unchanged rather than inventing a date', () => {
    expect(sweptStamp('last night')).toBe('last night');
  });
});

describe('dayStamp', () => {
  it('prints a calendar day', () => {
    expect(dayStamp('2026-09-13T07:32:47.000Z')).toBe('Sep 13, 2026');
  });
});

describe('count', () => {
  it('groups thousands', () => {
    expect(count(13320)).toBe('13,320');
    expect(count(80)).toBe('80');
  });
});
