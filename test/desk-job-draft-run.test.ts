import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The run endpoint's contract, I/O mocked: a bad token is 401, a lost claim is a
// silent 202, and a claimed row whose job lookup then throws is settled 'failed'
// (not stranded 'pending') and answered 500. It lives under src/pages, which
// Astro builds as routes, so its test lives here in test/.

const { draftableJobBySlug, claimJobRender, failDraft, renderOneDocument, draftRunSecret, verifyRunToken, deferWork } =
  vi.hoisted(() => ({
    draftableJobBySlug: vi.fn(),
    claimJobRender: vi.fn(),
    failDraft: vi.fn(),
    renderOneDocument: vi.fn(),
    draftRunSecret: vi.fn(),
    verifyRunToken: vi.fn(),
    deferWork: vi.fn()
  }));

vi.mock('../src/lib/draft-job', () => ({ draftableJobBySlug }));
vi.mock('../src/lib/generated-render-store', () => ({ claimJobRender, failDraft }));
vi.mock('../src/lib/generation-preference-store', () => ({ renderOneDocument }));
vi.mock('../src/lib/draft-run-token', () => ({ draftRunSecret, verifyRunToken }));
vi.mock('../src/lib/defer-work', () => ({ deferWork }));

import { POST } from '../src/pages/desk/job-draft/[slug]/run';

const PAYLOAD = {
  v: 1 as const,
  renderId: 'r-1',
  userId: 'user_1',
  jobId: 'acme-staff-designer',
  kind: 'resume' as const,
  provider: 'anthropic' as const,
  reason: null,
  steer: null,
  exp: Date.now() + 60_000
};

function ctx(body: unknown, slug = 'acme-staff-designer') {
  const request = new Request('https://www.antialgo.ai/desk/job-draft/x/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { request, params: { slug } } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  draftRunSecret.mockReturnValue('a-secret');
  renderOneDocument.mockResolvedValue(undefined);
  failDraft.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('POST /desk/job-draft/[slug]/run', () => {
  it('an unverifiable token is 401 JSON, and nothing is claimed', async () => {
    verifyRunToken.mockReturnValue(null);

    const res = await POST(ctx({ token: 'bogus' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'unauthorized' });
    expect(claimJobRender).not.toHaveBeenCalled();
  });

  it('a row already claimed is a 202 with no job lookup and no render', async () => {
    verifyRunToken.mockReturnValue(PAYLOAD);
    claimJobRender.mockResolvedValue(false);

    const res = await POST(ctx({ token: 'good' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ reason: 'already-claimed' });
    expect(draftableJobBySlug).not.toHaveBeenCalled();
    expect(deferWork).not.toHaveBeenCalled();
  });

  it('a claimed row whose job lookup throws is failed, not stranded, and answered 500', async () => {
    verifyRunToken.mockReturnValue(PAYLOAD);
    claimJobRender.mockResolvedValue(true);
    draftableJobBySlug.mockRejectedValue(new Error('db blip'));

    const res = await POST(ctx({ token: 'good' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ reason: 'start-failed' });
    expect(failDraft).toHaveBeenCalledWith('r-1', 'the draft could not be started');
    expect(deferWork).not.toHaveBeenCalled();
  });

  it('the happy path claims, defers the render, and answers 202', async () => {
    verifyRunToken.mockReturnValue(PAYLOAD);
    claimJobRender.mockResolvedValue(true);
    draftableJobBySlug.mockResolvedValue({ slug: 'acme-staff-designer' });

    const res = await POST(ctx({ token: 'good' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(deferWork).toHaveBeenCalledTimes(1);
    expect(renderOneDocument).toHaveBeenCalledTimes(1);
  });
});
