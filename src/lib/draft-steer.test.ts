import { describe, expect, it } from 'vitest';
import { parseSteer, steerGuidance, STEER_NOTE_MAX } from './draft-steer';

describe('parseSteer', () => {
  it('keeps only allowlisted chips, deduped and in order, and trims the note', () => {
    const s = parseSteer(['shorter', 'evil', 'plainer', 'shorter'], '  make it punchy  ');
    expect(s).not.toBeNull();
    expect(s!.chips).toEqual(['shorter', 'plainer']);
    expect(s!.note).toBe('make it punchy');
  });

  it('caps a note longer than STEER_NOTE_MAX', () => {
    const s = parseSteer([], 'x'.repeat(STEER_NOTE_MAX + 500));
    expect(s!.note!.length).toBe(STEER_NOTE_MAX);
  });

  it('returns null when there is nothing to steer', () => {
    expect(parseSteer([], '')).toBeNull();
    expect(parseSteer(['not-a-chip'], '   ')).toBeNull();
  });
});

describe('steerGuidance', () => {
  it('turns chips and a note into plain guidance', () => {
    const g = steerGuidance({ chips: ['shorter', 'technical'], note: 'lead with Codex' });
    expect(g).toContain('shorter');
    expect(g).toContain('technical');
    expect(g).toContain('lead with Codex');
  });

  it('is empty for an empty steer', () => {
    expect(steerGuidance({ chips: [], note: null })).toBe('');
  });
});
