import { describe, expect, it } from 'vitest';
import { DESK_WINDOW_DAYS, headStartFor, inDeskWindow } from './desk-home';

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

describe('headStartFor(): four bands, so two roles past the curve are not one card', () => {
  it('reads the model where the model speaks', () => {
    expect(headStartFor(0)).toEqual({ label: 'inside the first 48 hours', aheadPct: 55, zone: '48h' });
    expect(headStartFor(2)).toEqual({ label: 'inside the first 48 hours', aheadPct: 55, zone: '48h' });
    expect(headStartFor(3)).toEqual({ label: 'inside the first 96 hours', aheadPct: 40, zone: '96h' });
    expect(headStartFor(4)).toEqual({ label: 'inside the first 96 hours', aheadPct: 40, zone: '96h' });
  });

  it('claims no percentage past 96 hours, where the model makes none', () => {
    for (const age of [5, 13, 14, 15, 270]) {
      expect(headStartFor(age)?.aheadPct).toBeNull();
    }
  });

  /* THE DEFECT THIS BAND WAS ADDED FOR. Before 2026-10-01 every age past four
     days returned the same reading, so the lane could print a five day old role
     and a 270 day old one as identical cards once the window stopped hiding the
     older one. The split is the window, because the window is what the bar
     draws: inside it the marker has a place to sit, past it the bar is out of
     track and the card says so. */
  it('splits at the window: inside the track, then off the end of it', () => {
    expect(headStartFor(DESK_WINDOW_DAYS)?.zone).toBe('later');
    expect(headStartFor(DESK_WINDOW_DAYS)?.label).toBe('past the first 96 hours');
    expect(headStartFor(DESK_WINDOW_DAYS + 1)?.zone).toBe('beyond');
    expect(headStartFor(DESK_WINDOW_DAYS + 1)?.label).toBe('past the 14 day head start');
    expect(headStartFor(270)?.zone).toBe('beyond');
    // The two that used to be one card.
    expect(headStartFor(5)).not.toEqual(headStartFor(270));
  });

  it('has no reading at all for an unknown or impossible age', () => {
    expect(headStartFor(null)).toBeNull();
    expect(headStartFor(-1)).toBeNull();
  });
});
