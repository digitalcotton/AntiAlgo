import { describe, expect, it } from 'vitest';
import { DESK_WINDOW_DAYS, inDeskWindow } from './desk-home';

describe('inDeskWindow(): the Desk lanes show only roles first seen in the last 14 days', () => {
  it('keeps day 0 through day 14 and drops everything older or unknown', () => {
    expect(DESK_WINDOW_DAYS).toBe(14);
    expect(inDeskWindow(0)).toBe(true);
    expect(inDeskWindow(14)).toBe(true);
    expect(inDeskWindow(15)).toBe(false);
    expect(inDeskWindow(40)).toBe(false);
    expect(inDeskWindow(-1)).toBe(false);
    expect(inDeskWindow(null)).toBe(false);
  });
});
