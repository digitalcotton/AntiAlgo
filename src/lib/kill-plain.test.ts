import { describe, expect, it } from 'vitest';
import { plainKillSegments } from './kill-plain';
import type { Kill } from './data';

const base: Kill = {
  company: 'Brex', title: 'Staff Brand Designer', reason: 'repost-churn: ...', first_published: '2026-09-03',
  killed_on: '2026-09-11', duration_open_days: null, duration_provenance: 'observed_by_us', kill_rule: 'repost_churn'
};
const text = (segs: ReturnType<typeof plainKillSegments>) => (segs ?? []).map((s) => ('text' in s ? s.text : s.figure)).join('');

describe('plainKillSegments', () => {
  it('says nothing without evidence, and never reads the prose', () => {
    expect(plainKillSegments(base)).toBeNull();
    expect(plainKillSegments({ ...base, evidence: {} })).toBeNull();
  });
  it('repost churn: the gap, the link, the new date', () => {
    const segs = plainKillSegments({ ...base, evidence: { gap_days: 8, identifier: 'new', current_published: '2026-09-03' } });
    expect(text(segs)).toBe('Brex took this role down and put the identical text back up 8 days later, under a new link, dated Sep 3, 2026.');
    expect(segs).toContainEqual({ figure: '8' });
    expect(text(plainKillSegments({ ...base, evidence: { gap_days: 1, identifier: 'reused' } }))).toBe(
      'Brex took this role down and put the identical text back up 1 day later, at the same link.'
    );
  });
  it('touched, not refreshed: only the date moved', () => {
    const segs = plainKillSegments({ ...base, kill_rule: 'touched_not_refreshed', evidence: { published_was: '2026-09-03', published_now: '2026-09-09', days_moved: 6 } });
    expect(text(segs)).toBe('Brex moved only the date on this posting, from Sep 3, 2026 to Sep 9, 2026, 6 days forward. Every other field stayed exactly as it was.');
  });
  it('misrepresented, zombie, phantom', () => {
    expect(text(plainKillSegments({ ...base, kill_rule: 'misrepresented', evidence: { location_as_printed: 'India - Remote' } }))).toBe(
      "Brex lists this role as India - Remote, and the posting's own text requires the office."
    );
    expect(text(plainKillSegments({ ...base, kill_rule: 'zombie', evidence: { days_past: 12, deadline: '2026-08-30' } }))).toBe(
      'Brex left this posting up 12 days past the closing date it printed itself, Aug 30, 2026.'
    );
    expect(text(plainKillSegments({ ...base, kill_rule: 'phantom', evidence: { http_status: 404 } }))).toBe(
      'The link Brex published for this role no longer works: it answered 404 on two separate requests.'
    );
  });
  it('carries no dashes', () => {
    const segs = plainKillSegments({ ...base, evidence: { gap_days: 8, identifier: 'new' } });
    expect(text(segs)).not.toMatch(/[\u2013\u2014]/);
  });
});
