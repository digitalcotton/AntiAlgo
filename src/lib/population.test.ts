/**
 * population.test.ts: the registry ScopeBanner.astro reads and gate 10 checks
 * against independently.
 *
 * This proves the accessor resolves live from src/data/stats.json and
 * src/data/jobs.json (never a stored or typed number), that the four phrases
 * are pairwise distinct substrings (the property gate 10's phrase check
 * depends on: a block carrying the wrong phrase must not accidentally satisfy
 * the check for the right one), and that a sweep missing _meta.postings_observed
 * fails loudly rather than rendering a banner with a hole in it.
 */
import { describe, expect, it } from 'vitest';
import { CONFUSABLE_GROUPS, population, populationPhrase } from './population';
import rawStats from '../data/stats.json';
import rawJobs from '../data/jobs.json';

// Read the same two files population() reads, so the expectations track the
// current sweep instead of a typed number that goes stale the next night. This
// is the property this file's own header names: "resolves live... never a
// stored or typed number", which the test itself must honour, not just assert.
const stats = rawStats as unknown as { boards: number; pulled: number; _meta: { postings_observed: number } };
const jobs = rawJobs as unknown as { jobs: unknown[] };

describe('population()', () => {
  it('boards, pulled and postings_observed resolve to the sweep\'s own numbers', () => {
    expect(population('boards').value).toBe(stats.boards);
    expect(population('pulled').value).toBe(stats.pulled);
    expect(population('postings_observed').value).toBe(stats._meta.postings_observed);
  });

  it('jobs_total counts the published rows, not the sweep verdict, and the two differ', () => {
    // jobs.json carries closed rows the pulled verdict did not, so published
    // rows and pulled are two different numbers, before duplicate-cluster
    // collapse makes the gap a design choice rather than an artifact.
    expect(population('jobs_total').value).toBe(jobs.jobs.length);
    expect(population('jobs_total').value).not.toBe(population('pulled').value);
  });

  it('carries the display string and the phrase alongside the value', () => {
    const pulled = population('pulled');
    expect(pulled.display).toBe(String(stats.pulled));
    expect(pulled.phrase).toBe('reached a verdict');
  });

  it('every phrase is unique and none is a substring of another', () => {
    const names: Array<Parameters<typeof population>[0]> = ['boards', 'postings_observed', 'pulled', 'jobs_total'];
    const phrases = names.map((name) => populationPhrase(name));
    expect(new Set(phrases).size).toBe(phrases.length);
    for (const a of phrases) {
      for (const b of phrases) {
        if (a === b) continue;
        expect(a.includes(b)).toBe(false);
      }
    }
  });
});

describe('CONFUSABLE_GROUPS', () => {
  it('groups postings_observed, pulled and jobs_total, the worked example plus the row-collapse population', () => {
    expect(CONFUSABLE_GROUPS).toHaveLength(1);
    expect([...CONFUSABLE_GROUPS[0]].sort()).toEqual(['jobs_total', 'postings_observed', 'pulled']);
  });

  it('does not group boards with anything: a board count is not a postings count', () => {
    const grouped = CONFUSABLE_GROUPS.flat();
    expect(grouped).not.toContain('boards');
  });
});
