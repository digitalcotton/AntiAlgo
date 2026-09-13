/**
 * draft-job.test.ts: the drafting pipeline's slug lookup knows both job
 * populations.
 *
 * The bug this locks down: every leg of the draft resolved a slug through
 * jobBySlug() alone, which reads the curated jobs.json set, so a reader on a
 * tracked /board posting pressed the button and was bounced to the index. These
 * assert the three answers that matter, including the one that must stay a
 * refusal: an unknown slug is still null, because a draft aimed at a posting
 * nobody has a record of is the thing this lookup exists to prevent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jobBySlug = vi.fn();
const isConfigured = vi.fn();
const getBoardJobBySlug = vi.fn();
const boardRowToJob = vi.fn();

vi.mock('./data', () => ({ jobBySlug }));
vi.mock('./db', () => ({ isConfigured }));
vi.mock('./job-store', () => ({ getBoardJobBySlug }));
vi.mock('./board-jobs', () => ({ boardRowToJob }));
const getPostingFetchByApplication = vi.fn();
vi.mock('./posting-fetch-store', () => ({ getPostingFetchByApplication }));

const { draftableJobBySlug } = await import('./draft-job');

describe('draftableJobBySlug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobBySlug.mockReturnValue(null);
    isConfigured.mockReturnValue(true);
    getBoardJobBySlug.mockResolvedValue(null);
  });

  it('returns the verified posting without touching the database', async () => {
    const verified = { slug: 'acme-product-designer' };
    jobBySlug.mockReturnValue(verified);

    await expect(draftableJobBySlug('acme-product-designer')).resolves.toBe(verified);
    // The curated set is in memory; a hit there must not open a connection.
    expect(getBoardJobBySlug).not.toHaveBeenCalled();
  });

  it('falls back to the tracked board when the curated set has no such slug', async () => {
    const row = { id: 'ashby|123', slug: 'openai-software-engineer-zhbwdh' };
    const mapped = { slug: 'openai-software-engineer-zhbwdh' };
    getBoardJobBySlug.mockResolvedValue(row);
    boardRowToJob.mockReturnValue(mapped);

    await expect(draftableJobBySlug('openai-software-engineer-zhbwdh')).resolves.toBe(mapped);
    expect(getBoardJobBySlug).toHaveBeenCalledWith('openai-software-engineer-zhbwdh');
    expect(boardRowToJob).toHaveBeenCalledWith(row);
  });

  it('returns null for a slug in neither population', async () => {
    await expect(draftableJobBySlug('nothing-by-this-name')).resolves.toBeNull();
  });

  it('returns null for an empty slug without asking either source', async () => {
    await expect(draftableJobBySlug('   ')).resolves.toBeNull();
    expect(jobBySlug).not.toHaveBeenCalled();
    expect(getBoardJobBySlug).not.toHaveBeenCalled();
  });

  it('does not reach for the store when it is not configured', async () => {
    // A missing connection is not a missing posting, and must not read as one.
    isConfigured.mockReturnValue(false);

    await expect(draftableJobBySlug('openai-software-engineer-zhbwdh')).resolves.toBeNull();
    expect(getBoardJobBySlug).not.toHaveBeenCalled();
  });
});

describe('draftableJobBySlug, the added population (2026-09-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobBySlug.mockReturnValue(null);
    isConfigured.mockReturnValue(true);
    getBoardJobBySlug.mockResolvedValue(null);
  });
  it('needs the viewer: an added slug with no user id is nothing', async () => {
    await expect(draftableJobBySlug('added-42')).resolves.toBeNull();
    expect(getBoardJobBySlug).not.toHaveBeenCalled();
    expect(jobBySlug).not.toHaveBeenCalled();
  });
  it('resolves an owner-scoped ready row and never touches the other populations', async () => {
    const { getPostingFetchByApplication } = await import('./posting-fetch-store');
    (getPostingFetchByApplication as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'x', applicationId: 42, url: 'https://jobs.example.com/a', urlKey: 'https://jobs.example.com/a',
      status: 'ready', origin: 'machine', sourceKind: 'page', title: 'Designer', company: 'Acme',
      descriptionHtml: '<p>Hi</p>', finalUrl: null, httpStatus: 200, failureCode: null,
      fetchedAt: new Date('2026-09-10T00:00:00Z'), claimedAt: null, completedAt: null, createdAt: new Date('2026-09-10T00:00:00Z')
    });
    const job = await draftableJobBySlug('added-42', 'user_1');
    expect(job?.slug).toBe('added-42');
    expect(job?.company).toBe('Acme');
    expect(getPostingFetchByApplication).toHaveBeenCalledWith('user_1', 42);
    expect(jobBySlug).not.toHaveBeenCalled();
  });
  it('a pending row is not a draftable job yet', async () => {
    const { getPostingFetchByApplication } = await import('./posting-fetch-store');
    (getPostingFetchByApplication as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'x', applicationId: 42, url: 'https://jobs.example.com/a', urlKey: 'https://jobs.example.com/a',
      status: 'pending', origin: null, sourceKind: null, title: null, company: null, descriptionHtml: null,
      finalUrl: null, httpStatus: null, failureCode: null, fetchedAt: null, claimedAt: null, completedAt: null, createdAt: new Date()
    });
    await expect(draftableJobBySlug('added-42', 'user_1')).resolves.toBeNull();
  });
});
