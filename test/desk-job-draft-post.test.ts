import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The POST's own branching, with every I/O boundary mocked: does a click that
// lands while a draft is already in flight begin another version, or land the
// person back on the room without spending the throttle? documentState is mocked
// to echo a row's status, so a test controls "pending"/"ready"/"failed" directly
// (its real behaviour has its own tests in generated-render-store.test.ts). This
// endpoint lives under src/pages, where Astro builds every file as a route, so
// its test lives here in test/ rather than beside it.

const { draftableJobBySlug, triggerJobDraft, getActiveApplicationForJob, createApplicationFromClick, countRecentJobRenders, getJobRendersReconciled } =
  vi.hoisted(() => ({
    draftableJobBySlug: vi.fn(),
    triggerJobDraft: vi.fn(),
    getActiveApplicationForJob: vi.fn(),
    createApplicationFromClick: vi.fn(),
    countRecentJobRenders: vi.fn(),
    getJobRendersReconciled: vi.fn()
  }));

vi.mock('../src/lib/draft-job', () => ({ draftableJobBySlug }));
vi.mock('../src/lib/generation-preference-store', () => ({ triggerJobDraft }));
vi.mock('../src/lib/desk-store', () => ({ getActiveApplicationForJob, createApplicationFromClick }));
vi.mock('../src/lib/generated-render-store', () => ({
  countRecentJobRenders,
  getJobRendersReconciled,
  documentState: (row: { status?: string } | null) => (row ? row.status : 'none')
}));

import { POST } from '../src/pages/desk/job-draft';

function job() {
  return { id: 'job-1', slug: 'acme-staff-designer', title: 'Staff Product Designer', company: 'Acme', description_html: '<p>x</p>' };
}

function ctx(form: Record<string, string | string[]> = {}, accept = '') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  const headers: Record<string, string> = {};
  if (accept) headers.accept = accept;
  const request = new Request('https://www.antialgo.ai/desk/job-draft', { method: 'POST', headers, body: fd });
  return {
    locals: { viewer: { userId: 'user_1' }, verdict: { allow: true } },
    request,
    url: new URL('https://www.antialgo.ai/desk/job-draft')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  draftableJobBySlug.mockResolvedValue(job());
  getActiveApplicationForJob.mockResolvedValue({ id: 1 }); // already tracked: skip createApplicationFromClick
  countRecentJobRenders.mockResolvedValue(0);
  triggerJobDraft.mockResolvedValue({ resumeId: 'r-1', coverId: 'c-1' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('POST /desk/job-draft: idempotent retry while a draft is in flight', () => {
  it('both documents still pending: begins nothing, spends no throttle, 303s to the room', async () => {
    getJobRendersReconciled.mockResolvedValue({ resume: { status: 'pending' }, cover: { status: 'pending' } });

    const res = await POST(ctx({ slug: 'acme-staff-designer' }));

    expect(triggerJobDraft).not.toHaveBeenCalled();
    expect(countRecentJobRenders).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/desk/job-draft/acme-staff-designer');
  });

  it('a fetch() caller gets the same "already drafting" as JSON with the draft URL', async () => {
    getJobRendersReconciled.mockResolvedValue({ resume: { status: 'pending' }, cover: { status: 'pending' } });

    const res = await POST(ctx({ slug: 'acme-staff-designer' }, 'application/json'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ drafting: 'started', draftUrl: '/desk/job-draft/acme-staff-designer' });
    expect(triggerJobDraft).not.toHaveBeenCalled();
  });

  it('the rows were stale (reconciled to failed): begins a fresh draft', async () => {
    getJobRendersReconciled.mockResolvedValue({ resume: { status: 'failed' }, cover: { status: 'failed' } });

    await POST(ctx({ slug: 'acme-staff-designer' }));
    expect(triggerJobDraft).toHaveBeenCalledTimes(1);
  });

  it('kind=cover while the cover is still pending (resume ready): begins nothing', async () => {
    getJobRendersReconciled.mockResolvedValue({ resume: { status: 'ready' }, cover: { status: 'pending' } });

    await POST(ctx({ slug: 'acme-staff-designer', kind: 'cover' }));
    expect(triggerJobDraft).not.toHaveBeenCalled();
  });

  it('kind=cover after the cover failed: re-drafts just the cover, carrying the steer', async () => {
    getJobRendersReconciled.mockResolvedValue({ resume: { status: 'ready' }, cover: { status: 'failed' } });

    await POST(ctx({ slug: 'acme-staff-designer', kind: 'cover', steer: ['shorter'], steerNote: 'tighter' }));
    expect(triggerJobDraft).toHaveBeenCalledTimes(1);
    const opts = triggerJobDraft.mock.calls[0][2];
    expect(opts.kind).toBe('cover');
    expect(opts.steer).toMatchObject({ chips: ['shorter'], note: 'tighter' });
  });

  it('no draft yet (both none): begins a draft', async () => {
    getJobRendersReconciled.mockResolvedValue({ resume: null, cover: null });

    await POST(ctx({ slug: 'acme-staff-designer' }));
    expect(triggerJobDraft).toHaveBeenCalledTimes(1);
  });
});
