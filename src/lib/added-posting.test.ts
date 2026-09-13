/**
 * added-posting.test.ts: the slug helpers and the five fields the engine reads.
 */
import { describe, expect, it } from 'vitest';
import {
  addedApplicationId,
  addedPostingToJob,
  addedSlugFor,
  hostnameOf,
  isAddedDetailPath,
  isAddedSlug,
  postingSource,
  readThrough,
  readTook
} from './added-posting';
import type { StoredPostingFetch } from './posting-fetch-store';

const ROW: StoredPostingFetch = {
  id: '0f4e2b6a-1b2c-4d5e-8f90-1234567890ab',
  applicationId: 42,
  url: 'https://www.brex.com/careers/8782440002?gh_jid=8782440002',
  urlKey: 'https://www.brex.com/careers/8782440002?gh_jid=8782440002',
  status: 'ready',
  origin: 'machine',
  sourceKind: 'greenhouse',
  title: 'Senior Brand Designer',
  company: 'Brex',
  descriptionHtml: '<p>Brex is hiring.</p>',
  finalUrl: null,
  httpStatus: 200,
  failureCode: null,
  fetchedAt: new Date('2026-09-10T10:00:00.000Z'),
  claimedAt: new Date('2026-09-10T09:59:59.000Z'),
  completedAt: new Date('2026-09-10T10:00:01.000Z'),
  createdAt: new Date('2026-09-10T09:59:58.000Z'),
  machineNotes: {}
};

describe('the added slug', () => {
  it('round-trips an application id and rejects everything else', () => {
    expect(addedSlugFor(42)).toBe('added-42');
    expect(isAddedSlug('added-42')).toBe(true);
    expect(isAddedSlug('acme-designer')).toBe(false);
    expect(addedApplicationId('added-42')).toBe(42);
    expect(addedApplicationId('added-0')).toBeNull();
    expect(addedApplicationId('added-abc')).toBeNull();
    expect(addedApplicationId('acme-designer')).toBeNull();
  });
});

describe('addedPostingToJob', () => {
  it('carries the five fields the engine reads, keyed by the added slug', () => {
    const job = addedPostingToJob(ROW);
    expect(job.id).toBe('added-42');
    expect(job.slug).toBe('added-42');
    expect(job.title).toBe('Senior Brand Designer');
    expect(job.company).toBe('Brex');
    expect(job.description_html).toBe('<p>Brex is hiring.</p>');
    expect(job.source_system).toBe('custom');
    expect(job.apply_url).toBe(ROW.url);
    expect(job.last_verified).toBe('2026-09-10T10:00:00.000Z');
    expect(job.status).toBe('live');
  });
  it('names the host when the page gave no company', () => {
    expect(addedPostingToJob({ ...ROW, company: null }).company).toBe('brex.com');
    expect(hostnameOf('nope')).toBe('the company site');
  });
});

describe('isAddedDetailPath', () => {
  it('matches the exact added shape and nothing else under /board', () => {
    expect(isAddedDetailPath('/board/added-12')).toBe(true);
    expect(isAddedDetailPath('/board/added-0')).toBe(false);
    expect(isAddedDetailPath('/board/added-12/')).toBe(false);
    expect(isAddedDetailPath('/board/acme-designer-abc123')).toBe(false);
    expect(isAddedDetailPath('/board')).toBe(false);
  });
});

describe('postingSource', () => {
  it.each([
    ['https://boards.greenhouse.io/acme/jobs/123', 'greenhouse'],
    ['https://job-boards.eu.greenhouse.io/acme/jobs/123', 'greenhouse'],
    ['https://www.brex.com/careers/8782440002?gh_jid=8782440002', 'greenhouse'],
    ['https://jobs.ashbyhq.com/writer/1234-abcd', 'ashby'],
    ['https://jobs.lever.co/acme/1234-abcd', 'lever'],
    ['https://apply.workable.com/acme/j/ABCDEF1234/', 'workable'],
    ['https://ats.rippling.com/acme/jobs/1234-abcd', 'rippling'],
    ['https://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote/Designer_R123', 'workday'],
    ['https://explore.jobs.netflix.net/careers/job/790298014263-ai-engineer?domain=netflix.com', 'eightfold']
  ])('%s lives on %s', (url, ats) => {
    expect(postingSource(url)?.ats).toBe(ats);
  });
  it('a plain careers page, or a URL that is not one, has no board', () => {
    expect(postingSource('https://www.amazon.jobs/en/jobs/123/designer')).toBeNull();
    expect(postingSource('https://boards.greenhouse.io/acme')).toBeNull();
    expect(postingSource('nope')).toBeNull();
  });
  it('labels the system the way the page prints it', () => {
    expect(postingSource('https://jobs.ashbyhq.com/writer/1234')?.label).toBe('Ashby');
  });
});

describe('readThrough', () => {
  it('names the board for a board kind and the page for the page kinds', () => {
    expect(readThrough(ROW)).toBe('Greenhouse\'s board');
    expect(readThrough({ ...ROW, sourceKind: 'jsonld' })).toBe('the page\'s own structured data');
    expect(readThrough({ ...ROW, sourceKind: 'page' })).toBe('the page itself');
    expect(readThrough({ ...ROW, sourceKind: 'browser' })).toBe('a rendered copy of the page');
  });
  it('an Eightfold read is reported as a page read by the mini and named from the URL', () => {
    expect(
      readThrough({ sourceKind: 'page', url: 'https://explore.jobs.netflix.net/careers/job/790298014263-x?domain=netflix.com' })
    ).toBe('Eightfold\'s board');
  });
  it('is silent for a pasted row and an unsettled one', () => {
    expect(readThrough({ ...ROW, sourceKind: 'pasted' })).toBeNull();
    expect(readThrough({ ...ROW, sourceKind: null })).toBeNull();
  });
});

describe('readTook', () => {
  const at = (claimed: string, completed: string) => ({ claimedAt: new Date(claimed), completedAt: new Date(completed) });
  it('says it in words, never a number', () => {
    expect(readTook(at('2026-09-10T10:00:00Z', '2026-09-10T10:00:01.200Z'))).toBe('in a moment');
    expect(readTook(at('2026-09-10T10:00:00Z', '2026-09-10T10:00:12Z'))).toBe('in a few seconds');
    expect(readTook(at('2026-09-10T10:00:00Z', '2026-09-10T10:00:45Z'))).toBe('in under a minute');
    expect(readTook(at('2026-09-10T10:00:00Z', '2026-09-10T10:03:00Z'))).toBe('in a few minutes');
    expect(readTook({ claimedAt: null, completedAt: new Date() })).toBeNull();
  });
});
