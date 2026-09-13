import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchJobDraftRuns, selfOrigin, type DocumentDispatch } from './draft-run-dispatch';
import { verifyRunToken } from './draft-run-token';
import type { Job } from './data';

/**
 * The hand-off from the job-draft POST to a fresh invocation per document.
 * fetch is stubbed (the function takes it as an argument for exactly this
 * reason), so what is proved is the contract, not the network: one POST per
 * document to this deployment's own run endpoint, a token that verifies with
 * the secret and carries the right document, and the fallback shape (a
 * document that could not be handed off is returned for in-process rendering,
 * that one only).
 */

const SECRET = 'test-draft-run-secret';

function job(): Job {
  return {
    id: 'job-1',
    slug: 'acme-staff-designer',
    company: 'Acme Corp',
    title: 'Staff Product Designer',
    kind: 'posted',
    prospect: null,
    comp_posted: null,
    comp_range: null,
    published_at: null,
    location: 'Remote',
    remote: true,
    source_system: 'greenhouse',
    source_url: 'https://boards.example.com/acme/staff-designer',
    apply_url: 'https://boards.example.com/acme/staff-designer/apply',
    first_observed: '2026-08-01T00:00:00Z',
    last_verified: '2026-08-20T00:00:00Z',
    published_date: '2026-08-01',
    age_days: 19,
    status: 'live',
    window: null,
    risk: 'LOW',
    ease: { friction: 'EASY', minutes_estimate: 10, account_required: false, destination: 'acme.com' },
    fit: { total: 80, title_scope: 20, remote_geo: 20, comp: 20, freshness: 10, apply_friction: 10 },
    description_html: '<p>We need someone who can redesign checkout.</p>'
  };
}

function docs(): DocumentDispatch[] {
  return [
    { userId: 'user_1', job: job(), kind: 'resume', renderId: 'r-1', provider: 'anthropic', reason: null },
    { userId: 'user_1', job: job(), kind: 'cover', renderId: 'c-1', provider: 'anthropic', reason: 'I like the craft.' }
  ];
}

const priorSecret = process.env.DRAFT_RUN_SECRET;
const priorVercelUrl = process.env.VERCEL_URL;

beforeEach(() => {
  process.env.DRAFT_RUN_SECRET = SECRET;
  delete process.env.VERCEL_URL;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (priorSecret === undefined) delete process.env.DRAFT_RUN_SECRET;
  else process.env.DRAFT_RUN_SECRET = priorSecret;
  if (priorVercelUrl === undefined) delete process.env.VERCEL_URL;
  else process.env.VERCEL_URL = priorVercelUrl;
  vi.restoreAllMocks();
});

describe('selfOrigin(): this deployment, never the forwarded host', () => {
  it('prefers VERCEL_URL, as https, over the request origin', () => {
    process.env.VERCEL_URL = 'tokens-to-agents-jobs-abc123.vercel.app';
    expect(selfOrigin(new URL('https://tokenstoagents.ai/jobs/desk/job-draft'))).toBe(
      'https://tokens-to-agents-jobs-abc123.vercel.app'
    );
  });

  it('falls back to the request origin with no VERCEL_URL (local dev)', () => {
    expect(selfOrigin(new URL('http://localhost:4321/jobs/desk/job-draft'))).toBe('http://localhost:4321');
  });
});

describe('dispatchJobDraftRuns(): one fresh invocation per document', () => {
  it('POSTs one signed token per document to the run endpoint and returns nothing for in-process', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('{"accepted":true}', { status: 202 });
    }) as typeof fetch;

    const leftover = await dispatchJobDraftRuns('https://example.test', docs(), fetchImpl);

    expect(leftover).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://example.test/desk/job-draft/acme-staff-designer/run',
      'https://example.test/desk/job-draft/acme-staff-designer/run'
    ]);
    const payloads = calls.map((c) => {
      const body = JSON.parse(String(c.init.body)) as { token: string };
      return verifyRunToken(body.token, SECRET, Date.now());
    });
    expect(payloads[0]).toMatchObject({ renderId: 'r-1', kind: 'resume', userId: 'user_1', jobId: 'acme-staff-designer', provider: 'anthropic', reason: null });
    expect(payloads[1]).toMatchObject({ renderId: 'c-1', kind: 'cover', reason: 'I like the craft.' });
    for (const c of calls) expect(c.init.method).toBe('POST');
  });

  it('hands back only the document whose run endpoint did not answer 202', async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { token: string };
      const payload = verifyRunToken(body.token, SECRET, Date.now());
      return payload?.kind === 'cover' ? new Response('boom', { status: 500 }) : new Response('', { status: 202 });
    }) as typeof fetch;

    const leftover = await dispatchJobDraftRuns('https://example.test', docs(), fetchImpl);
    expect(leftover.map((d) => d.kind)).toEqual(['cover']);
  });

  it('hands back a document whose fetch threw, and never rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const leftover = await dispatchJobDraftRuns('https://example.test', docs(), fetchImpl);
    expect(leftover.map((d) => d.kind)).toEqual(['resume', 'cover']);
  });

  it('with no secret configured, dispatches nothing and hands every document back', async () => {
    delete process.env.DRAFT_RUN_SECRET;
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 })) as unknown as typeof fetch;

    const leftover = await dispatchJobDraftRuns('https://example.test', docs(), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(leftover).toHaveLength(2);
  });
});
