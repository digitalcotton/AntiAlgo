import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The entitlement gate, with defineMiddleware unwrapped to the raw handler and
// the two I/O boundaries (viewer resolution, flag lighting) mocked. What this
// proves is the one fix that unbroke drafting: a cookieless server-to-server
// POST to the run endpoint reaches it (the token is its auth), while every other
// gated path still bounces a signed-out request to /sign-in, and the CSRF gate
// is unchanged.

const { viewerFrom } = vi.hoisted(() => ({ viewerFrom: vi.fn(async () => null) }));
vi.mock('astro:middleware', () => ({ defineMiddleware: (fn: unknown) => fn }));
vi.mock('./lib/viewer', () => ({ viewerFrom }));
vi.mock('./lib/flags', () => ({ routeIsLit: () => true }));

import { onRequest } from './middleware';

function run(pathname: string, { method = 'GET', origin }: { method?: string; origin?: string } = {}) {
  const url = new URL(`https://www.antialgo.ai${pathname}`);
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  const request = new Request(url, { method, headers });
  const redirect = vi.fn((path: string, status = 302) => new Response(null, { status, headers: { location: path } }));
  const next = vi.fn(async () => new Response('ok', { status: 200 }));
  const context = { url, request, locals: {} as Record<string, unknown>, redirect };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { promise: (onRequest as any)(context, next), redirect, next };
}

beforeEach(() => {
  viewerFrom.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe('middleware: the run endpoint is exempt from the entitlement gate', () => {
  it('lets a cookieless POST to /desk/job-draft/<slug>/run through, never redirecting it', async () => {
    const { promise, redirect, next } = run('/desk/job-draft/acme-staff-designer/run', { method: 'POST' });
    const res = await promise;
    expect(next).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('still redirects a signed-out request to the sibling /status endpoint', async () => {
    const { promise, redirect } = run('/desk/job-draft/acme-staff-designer/status');
    await promise;
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect.mock.calls[0][0]).toContain('/sign-in?next=');
  });

  it('still redirects a signed-out request to the draft room itself', async () => {
    const { promise, redirect } = run('/desk/job-draft/acme-staff-designer');
    await promise;
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect.mock.calls[0][0]).toContain('/sign-in?next=');
  });

  it('leaves the CSRF gate intact: a foreign-Origin POST to the begin endpoint is 403', async () => {
    const { promise, next } = run('/desk/job-draft', { method: 'POST', origin: 'https://evil.example' });
    const res = await promise;
    expect(res.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
