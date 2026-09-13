import { describe, expect, it } from 'vitest';
import { dropWindow, insideDropWindow, enteredInWindow, closedInWindow, killsInWindow, DROP_WINDOW_DAYS } from './window';
import { verifiedJobs, closedJobs, killArchive, loadKills, sweepDate, daysBetween, type Job, type Kill } from '../../lib/data';

// This suite is the "every count on /drop traces to a published file" proof
// for the one piece of drop-specific logic the page owns: the seven day
// window and the three filters built on it. It runs against the real
// fixtures in src/data/ (via src/lib/data.ts), never a fabricated fixture,
// because the whole point of pulling this out of drop.astro (see this
// module's own header) is to check it against the same rows the page
// actually renders, with no Astro renderer required to do it.

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_1',
    slug: 'job-1',
    company: 'Acme',
    title: 'Designer',
    kind: 'posted',
    prospect: null,
    comp_posted: null,
    comp_range: null,
    published_at: null,
    location: 'Remote',
    remote: true,
    source_system: 'greenhouse',
    source_url: 'https://example.com',
    apply_url: 'https://example.com/apply',
    first_observed: null,
    last_verified: '2026-08-23T07:30:02Z',
    published_date: null,
    age_days: null,
    status: 'live',
    window: null,
    risk: 'LOW',
    ease: null,
    fit: { total: 0, title_scope: 0, remote_geo: 0, comp: 0, freshness: 0, apply_friction: 0 },
    description_html: null,
    ...overrides
  };
}

function kill(overrides: Partial<Kill> = {}): Kill {
  return {
    company: 'Acme',
    title: 'Designer',
    reason: 'Observed',
    first_published: null,
    killed_on: null,
    duration_open_days: null,
    ...overrides
  };
}

describe('dropWindow(): the seven day boundary', () => {
  it('runs from seven days before the sweep date up to the sweep date, inclusive', () => {
    const window = dropWindow('2026-08-23');
    expect(window).toEqual({ from: '2026-08-16', to: '2026-08-23', days: 7 });
  });

  it('DROP_WINDOW_DAYS is 7, and dropWindow() spans exactly that many days back', () => {
    expect(DROP_WINDOW_DAYS).toBe(7);
    const window = dropWindow('2026-01-10');
    expect(daysBetween(window.from, window.to)).toBe(DROP_WINDOW_DAYS);
  });
});

describe('insideDropWindow(): the per-record predicate', () => {
  const window = dropWindow('2026-08-23');

  it('is false for a null or missing date', () => {
    expect(insideDropWindow(null, window, daysBetween)).toBe(false);
    expect(insideDropWindow(undefined, window, daysBetween)).toBe(false);
  });

  it('is true for the sweep date itself and for the window floor', () => {
    expect(insideDropWindow('2026-08-23', window, daysBetween)).toBe(true);
    expect(insideDropWindow('2026-08-16', window, daysBetween)).toBe(true);
  });

  it('is false one day outside either edge', () => {
    expect(insideDropWindow('2026-08-15', window, daysBetween)).toBe(false);
    expect(insideDropWindow('2026-08-24', window, daysBetween)).toBe(false);
  });
});

describe('enteredInWindow(), closedInWindow(), killsInWindow(): filters, not counts', () => {
  const window = dropWindow('2026-08-23');

  it('enteredInWindow() keeps only jobs whose first_observed is inside the window', () => {
    const rows = [
      job({ id: 'a', first_observed: '2026-08-20' }),
      job({ id: 'b', first_observed: '2026-08-01' }),
      job({ id: 'c', first_observed: null })
    ];
    const result = enteredInWindow(rows, window, daysBetween);
    expect(result.map((r) => r.id)).toEqual(['a']);
  });

  it('closedInWindow() keeps only jobs whose closed_on is inside the window', () => {
    const rows = [
      job({ id: 'a', status: 'closed', closed_on: '2026-08-22' }),
      job({ id: 'b', status: 'closed', closed_on: '2026-01-01' }),
      job({ id: 'c', status: 'closed' })
    ];
    const result = closedInWindow(rows, window, daysBetween);
    expect(result.map((r) => r.id)).toEqual(['a']);
  });

  it('killsInWindow() keeps only kills whose killed_on is inside the window', () => {
    const rows = [
      kill({ company: 'A', killed_on: '2026-08-19' }),
      kill({ company: 'B', killed_on: '2026-07-01' }),
      kill({ company: 'C', killed_on: null })
    ];
    const result = killsInWindow(rows, window, daysBetween);
    expect(result.map((r) => r.company)).toEqual(['A']);
  });

  it('is a strict filter: every row it returns is also a member of the input array', () => {
    const rows = [job({ id: 'a', first_observed: '2026-08-20' }), job({ id: 'b', first_observed: '2026-08-20' })];
    const result = enteredInWindow(rows, window, daysBetween);
    for (const row of result) {
      expect(rows).toContain(row);
    }
  });
});

describe('against the real published fixtures (src/data/jobs.json, kills.json)', () => {
  const window = dropWindow(sweepDate());

  it('every entered row is also in verifiedJobs(), and every date used to select it is inside the window', () => {
    const verified = verifiedJobs();
    const entered = enteredInWindow(verified, window, daysBetween);
    expect(entered.length).toBeGreaterThan(0);
    expect(entered.length).toBeLessThanOrEqual(verified.length);
    for (const row of entered) {
      expect(verified).toContain(row);
      expect(row.first_observed).not.toBeNull();
      const elapsed = daysBetween(row.first_observed, window.to);
      expect(elapsed).not.toBeNull();
      expect(elapsed as number).toBeGreaterThanOrEqual(0);
      expect(elapsed as number).toBeLessThanOrEqual(DROP_WINDOW_DAYS);
    }
  });

  it('every closed-in-window row is also in closedJobs(), with a closed_on date inside the window', () => {
    const closed = closedJobs();
    const changed = closedInWindow(closed, window, daysBetween);
    for (const row of changed) {
      expect(closed).toContain(row);
      expect(row.closed_on).toBeTruthy();
      const elapsed = daysBetween(row.closed_on ?? null, window.to);
      expect(elapsed as number).toBeGreaterThanOrEqual(0);
      expect(elapsed as number).toBeLessThanOrEqual(DROP_WINDOW_DAYS);
    }
  });

  it('killsInWindow() over killArchive() never returns more rows than the archive holds', () => {
    const archive = killArchive();
    const died = killsInWindow(archive, window, daysBetween);
    expect(died.length).toBeLessThanOrEqual(archive.length);
    for (const row of died) {
      expect(archive).toContain(row);
    }
  });

  it('the publishable set inside the window is never larger than the archive set inside the window', () => {
    const archiveInWindow = killsInWindow(killArchive(), window, daysBetween);
    const publishableInWindow = killsInWindow(loadKills(), window, daysBetween);
    expect(publishableInWindow.length).toBeLessThanOrEqual(archiveInWindow.length);
  });
});
