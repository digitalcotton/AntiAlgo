/**
 * posting-read.test.ts: the sequencer, with a fake network.
 *
 * Nothing here opens a socket. `fetchImpl` and the guard's `resolver` are both
 * injected, so every case below is a statement about the ORDER this module does
 * things in and about what it refuses, which is the only thing it adds over the
 * three readers it calls.
 */
import { describe, expect, it } from 'vitest';
import { readPostingNow, MAX_BYTES } from './posting-read';

/** Every host resolves to one ordinary public address unless a test says
    otherwise. The guard has its own suite; here it is a collaborator. */
const publicResolver = async () => ['93.184.216.34'];

interface Reply {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  url?: string;
}

/** A fetch built from a URL -> reply map, recording the order of calls. */
function fakeFetch(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const impl = async (url: string): Promise<Response> => {
    calls.push(url);
    const reply = replies[url];
    if (!reply) return new Response('not found', { status: 404 });
    const headers = new Headers(reply.headers ?? { 'content-type': 'application/json' });
    const response = new Response(reply.status && reply.status >= 300 && reply.status < 400 ? null : (reply.body ?? ''), {
      status: reply.status ?? 200,
      headers
    });
    Object.defineProperty(response, 'url', { value: reply.url ?? url });
    return response;
  };
  return { impl, calls };
}

const GREENHOUSE_JOB = 'https://boards.greenhouse.io/brex/jobs/8782440002';
const GREENHOUSE_API = 'https://boards-api.greenhouse.io/v1/boards/brex/jobs/8782440002';
const GREENHOUSE_BOARD_API = 'https://boards-api.greenhouse.io/v1/boards/brex';

const jobPayload = JSON.stringify({
  title: 'Senior Brand Designer',
  content: '&lt;div&gt;&lt;p&gt;Brex is hiring a Senior Brand Designer, and this is the body of that posting.&lt;/p&gt;&lt;/div&gt;'
});

describe('readPostingNow: the resolver path', () => {
  it('reads the ATS payload and asks the board for the company it never carries', async () => {
    const { impl, calls } = fakeFetch({
      [GREENHOUSE_API]: { body: jobPayload },
      [GREENHOUSE_BOARD_API]: { body: JSON.stringify({ name: 'Brex' }) }
    });

    const result = await readPostingNow(GREENHOUSE_JOB, { fetchImpl: impl, resolver: publicResolver });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.via).toBe('resolver');
    expect(result.extraction.title).toBe('Senior Brand Designer');
    expect(result.extraction.company).toBe('Brex');
    // The page the person pasted is never fetched when the API answered.
    expect(calls).toEqual([GREENHOUSE_API, GREENHOUSE_BOARD_API]);
  });

  it('falls back to the title-cased board slug when the company call fails', async () => {
    const { impl } = fakeFetch({
      [GREENHOUSE_API]: { body: jobPayload },
      [GREENHOUSE_BOARD_API]: { status: 500, body: 'nope' }
    });

    const result = await readPostingNow(GREENHOUSE_JOB, { fetchImpl: impl, resolver: publicResolver });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.company).toBe('Brex');
  });

  it('falls through to the pasted page when the resolver matches but the API is empty', async () => {
    const page = `<html><head><title>Senior Brand Designer</title></head><body><main><p>${'Brex is hiring. '.repeat(40)}</p></main></body></html>`;
    const { impl, calls } = fakeFetch({
      [GREENHOUSE_API]: { status: 404, body: '' },
      [GREENHOUSE_JOB]: { body: page, headers: { 'content-type': 'text/html' } }
    });

    const result = await readPostingNow(GREENHOUSE_JOB, { fetchImpl: impl, resolver: publicResolver });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.via).toBe('page');
    expect(calls).toEqual([GREENHOUSE_API, GREENHOUSE_JOB]);
  });
});

describe('readPostingNow: the guard runs on every hop', () => {
  it('refuses a redirect into a private address, even though the first hop was public', async () => {
    const start = 'https://jobs.example.com/posting/1';
    const hop = 'https://metadata.example.com/latest/meta-data/';
    const { impl, calls } = fakeFetch({
      [start]: { status: 302, headers: { location: hop } },
      [hop]: { body: 'secrets', headers: { 'content-type': 'text/html' } }
    });

    // The first host is public; the redirect target resolves inside the fence.
    const resolver = async (host: string) =>
      host === 'metadata.example.com' ? ['169.254.169.254'] : ['93.184.216.34'];

    const result = await readPostingNow(start, { fetchImpl: impl, resolver });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('refused_url');
    // The redirect target was never fetched: refused before the socket opened.
    expect(calls).toEqual([start]);
  });

  it('refuses a redirect to a Tailscale address', async () => {
    const start = 'https://jobs.example.com/posting/2';
    const hop = 'https://mini.example.com/';
    const { impl, calls } = fakeFetch({
      [start]: { status: 302, headers: { location: hop } },
      [hop]: { body: 'inside the tailnet' }
    });
    const resolver = async (host: string) => (host === 'mini.example.com' ? ['100.64.1.2'] : ['93.184.216.34']);

    const result = await readPostingNow(start, { fetchImpl: impl, resolver });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('refused_url');
    expect(calls).toEqual([start]);
  });

  it('follows an ordinary redirect and reads the destination', async () => {
    const start = 'https://jobs.example.com/posting/3';
    const hop = 'https://careers.example.com/posting/3';
    const page = `<html><body><main><p>${'This is a real job posting body. '.repeat(30)}</p></main></body></html>`;
    const { impl, calls } = fakeFetch({
      [start]: { status: 302, headers: { location: hop } },
      [hop]: { body: page, headers: { 'content-type': 'text/html' } }
    });

    const result = await readPostingNow(start, { fetchImpl: impl, resolver: publicResolver });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([start, hop]);
  });
});

describe('readPostingNow: the refusals', () => {
  it('refuses a body past the cap without decoding it', async () => {
    const url = 'https://jobs.example.com/huge';
    const { impl } = fakeFetch({
      [url]: {
        body: 'x'.repeat(64),
        headers: { 'content-type': 'text/html', 'content-length': String(MAX_BYTES + 1) }
      }
    });

    const result = await readPostingNow(url, { fetchImpl: impl, resolver: publicResolver });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('too_large');
  });

  it('refuses a response that is not markup', async () => {
    const url = 'https://jobs.example.com/poster.pdf';
    const { impl } = fakeFetch({ [url]: { body: '%PDF-1.7', headers: { 'content-type': 'application/pdf' } } });

    const result = await readPostingNow(url, { fetchImpl: impl, resolver: publicResolver });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('not_html');
  });

  it('reports a page with nothing to draft from as no_content, never as a thin success', async () => {
    const url = 'https://jobs.example.com/shell';
    const { impl } = fakeFetch({
      [url]: { body: '<html><body><div>Enable JavaScript</div></body></html>', headers: { 'content-type': 'text/html' } }
    });

    const result = await readPostingNow(url, { fetchImpl: impl, resolver: publicResolver });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('no_content');
  });

  it('gives up when the budget is spent rather than holding the form POST open', async () => {
    const url = 'https://jobs.example.com/slow';
    const { impl } = fakeFetch({ [url]: { body: 'never read', headers: { 'content-type': 'text/html' } } });

    const result = await readPostingNow(url, { fetchImpl: impl, resolver: publicResolver, budgetMs: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('timeout');
  });

  it('turns a refused scheme into a refusal before any request', async () => {
    const { impl, calls } = fakeFetch({});

    const result = await readPostingNow('http://jobs.example.com/plain', { fetchImpl: impl, resolver: publicResolver });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('refused_url');
    expect(calls).toEqual([]);
  });

  it('reports a network failure as fetch_error, not as a crash', async () => {
    const impl = async () => {
      throw new TypeError('connection reset');
    };

    const result = await readPostingNow('https://jobs.example.com/gone', { fetchImpl: impl, resolver: publicResolver });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('fetch_error');
  });
});
