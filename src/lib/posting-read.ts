/**
 * posting-read.ts: read one posting now, from this process, or say why not.
 *
 * WHAT THIS IS FOR. `desk/posting.ts` has always handed every pasted URL to the
 * Mac mini and sent the person to a waiting room. Most of what a member pastes
 * does not need the mini: the company is new to us, but the plumbing is not,
 * and `posting-resolvers.ts` turns a Greenhouse or Ashby or Lever URL into a
 * JSON endpoint we already know how to parse. This module is the sequencer that
 * spends one HTTPS call — sometimes two — to try that, so the common case lands
 * on a filled page instead of a queue.
 *
 * IT IS ALLOWED TO FAIL, AND FAILING IS CHEAP. Every return path that is not a
 * finished extraction is a `FailureCode`, and the route's answer to a failure
 * code is the path it already had: create the fetch row, wake the mini, send
 * the person to the waiting room. So the worst case of this whole module is one
 * wasted request and the behaviour of the previous edition. That is the reason
 * the budget below is small and unapologetic: a read worth waiting six seconds
 * for in a form POST does not exist, and the fallback is good.
 *
 * THE GUARD RUNS ON EVERY HOP, NOT ONCE. `postfetch_agent.py` re-runs its guard
 * on every redirect, and so does this, which is why the fetch loop below is
 * hand-rolled with `redirect: 'manual'` instead of letting `fetch` follow
 * redirects itself. A URL that passes the guard and then 302s to
 * `169.254.169.254` is the entire reason that rule exists; letting `fetch`
 * follow hops internally would check the first address and dial the last.
 *
 * THE CALLER'S POLICY, STATED HERE BECAUSE IT IS NOT OBVIOUS. An extraction
 * with no description is treated as a failed read (`no_content`) rather than a
 * thin success. `posting-extraction.ts` allows a null description because a
 * reader must report what the source said; this module decides what to do about
 * it, and the answer is fall through to the mini, because `tailor.ts` and
 * `posting-requirements.ts` read `description_html` and a draft built from an
 * empty posting is worse than a waiting room that resolves into a real one.
 *
 * WHAT IT DOES NOT DO. No database, no sanitising beyond what the two readers
 * already do, and no browser. The JavaScript-only tail — Workday's rendered
 * shells, anything behind bot protection that challenges a datacentre address —
 * is exactly what the mini keeps, and this module's job is to recognise that it
 * has nothing and get out of the way quickly.
 */
import type { FailureCode } from './posting-fetch-store';
import type { PostingExtraction } from './posting-extraction';
import { guardPostingUrl } from './posting-url-guard';
import { resolvePosting } from './posting-resolvers';
import { extractPosting } from './posting-extract';

/** The whole read, from the first guard to the last byte. A form POST is
    holding a person still while this runs, so it is deliberately short: past
    this, the queue is the better answer and the mini is better at the job. */
export const READ_BUDGET_MS = 6_000;
/** One request inside that budget. */
export const REQUEST_TIMEOUT_MS = 4_000;
/** The same ceiling postfetch.py sets, for the same reason: a job posting that
    does not fit in two megabytes is not a job posting. */
export const MAX_BYTES = 2 * 1024 * 1024;
/** postfetch_agent.py's own hop limit. */
export const MAX_REDIRECTS = 5;

/** Injected so the tests never open a socket, the same discipline the three
    readers keep. Node's own `fetch` is the default at the call site. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PostingReadOk {
  ok: true;
  extraction: PostingExtraction;
  /** Which reader produced it, for the note the route stores. */
  via: 'resolver' | 'page';
  httpStatus: number;
}

export interface PostingReadFailure {
  ok: false;
  failureCode: FailureCode;
  /** The status we actually saw, when we got far enough to see one. */
  httpStatus: number | null;
}

export type PostingReadResult = PostingReadOk | PostingReadFailure;

function failed(failureCode: FailureCode, httpStatus: number | null = null): PostingReadFailure {
  return { ok: false, failureCode, httpStatus };
}

/** A deadline the whole read shares, so two requests cannot each spend the
    budget. Returns the milliseconds left, or 0 when there is no time. */
function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

interface FetchedBody {
  body: string;
  status: number;
  finalUrl: string;
  contentType: string;
}

/** Narrows `guardedFetch`'s union. A failure carries `ok: false`; a body does
    not carry `ok` at all, so the discriminant is the presence of the field. */
function isFailure(result: FetchedBody | PostingReadFailure): result is PostingReadFailure {
  return 'ok' in result;
}

/**
 * One guarded GET, following redirects by hand and re-guarding every hop.
 * Returns the body as text, or the code that says why there is none.
 */
async function guardedFetch(
  url: string,
  fetchImpl: FetchLike,
  deadline: number,
  resolver?: (host: string) => Promise<string[]>
): Promise<FetchedBody | PostingReadFailure> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const refusal = await guardPostingUrl(current, resolver);
    if (refusal) return failed(refusal);

    const left = remaining(deadline);
    if (left <= 0) return failed('timeout');

    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(left, REQUEST_TIMEOUT_MS)),
        headers: {
          // Say who we are. A board that wants to refuse us should be able to.
          'User-Agent': 'AntiAlgoBot/1.0 (+https://www.antialgo.ai/colophon)',
          Accept: 'application/json, text/html;q=0.9, */*;q=0.8'
        }
      });
    } catch (error) {
      const name = (error as { name?: string })?.name ?? '';
      return failed(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'fetch_error');
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return failed('http_error', response.status);
      try {
        current = new URL(location, current).toString();
      } catch {
        return failed('refused_url', response.status);
      }
      continue; // re-guard the new address at the top of the loop
    }

    if (response.status !== 200) return failed('http_error', response.status);

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_BYTES) return failed('too_large', response.status);

    const body = await readCapped(response);
    if (body === null) return failed('too_large', response.status);

    return { body, status: response.status, finalUrl: response.url || current, contentType };
  }

  return failed('http_error');
}

/** The body as text, or null when it runs past MAX_BYTES. Read through the
    stream rather than `response.text()` so an enormous page costs us the cap
    and not its whole length. */
async function readCapped(response: Response): Promise<string | null> {
  if (!response.body) {
    const text = await response.text();
    return text.length > MAX_BYTES ? null : text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(joined);
}

/** An extraction is only worth settling on if it has a body to draft from. */
function usable(extraction: PostingExtraction): boolean {
  return Boolean(extraction.descriptionHtml && extraction.descriptionHtml.trim().length > 0);
}

export interface ReadOptions {
  fetchImpl?: FetchLike;
  /** Injected in tests; the guard's own default resolver otherwise. */
  resolver?: (host: string) => Promise<string[]>;
  now?: () => number;
  budgetMs?: number;
}

/**
 * Read the posting at `url`, or say why this process could not.
 *
 * The order is the one postfetch_agent.py uses, minus the browser: the board's
 * own API where the URL is an ATS we know, then the page through the generic
 * extractor. A resolver that matches but comes back empty still falls through
 * to the page read, because a board that changed its payload shape should cost
 * us a slower read, not a failed one.
 */
export async function readPostingNow(url: string, options: ReadOptions = {}): Promise<PostingReadResult> {
  const fetchImpl = options.fetchImpl ?? ((target, init) => fetch(target, init));
  const deadline = (options.now?.() ?? Date.now()) + (options.budgetMs ?? READ_BUDGET_MS);

  const resolved = resolvePosting(url);

  if (resolved) {
    const primary = await guardedFetch(resolved.api, fetchImpl, deadline, options.resolver);
    let extraction: PostingExtraction | null = null;
    let status: number | null = null;

    if (!isFailure(primary)) {
      status = primary.status;
      const parsed = resolved.parse(primary.body);
      if (typeof parsed !== 'string') extraction = parsed;
    }

    // Workable's second attempt: the v2 job endpoint 404s often enough that the
    // widget list is a real retry, not an enrichment.
    if (!extraction && resolved.fallback && remaining(deadline) > 0) {
      const second = await guardedFetch(resolved.fallback.api, fetchImpl, deadline, options.resolver);
      if (!isFailure(second)) {
        status = second.status;
        const parsed = resolved.fallback.parse(second.body);
        if (typeof parsed !== 'string') extraction = parsed;
      }
    }

    if (extraction) {
      // Greenhouse never names the company in the job payload. One more request
      // for the board's own name, and the slug only if that fails too.
      if (!extraction.company && resolved.companyApi && resolved.companyParse && remaining(deadline) > 0) {
        const third = await guardedFetch(resolved.companyApi, fetchImpl, deadline, options.resolver);
        if (!isFailure(third)) {
          const name = resolved.companyParse(third.body);
          if (name) extraction = { ...extraction, company: name };
        }
      }
      if (!extraction.company) extraction = { ...extraction, company: resolved.companyHint };

      if (usable(extraction)) {
        return { ok: true, extraction, via: 'resolver', httpStatus: status ?? 200 };
      }
    }
    // Fell through on purpose: try the page the person actually pasted.
  }

  const page = await guardedFetch(url, fetchImpl, deadline, options.resolver);
  if (isFailure(page)) return page;

  if (page.contentType && !/html|xml|text\/plain/.test(page.contentType)) {
    return failed('not_html', page.status);
  }

  const extracted = extractPosting(page.body, page.finalUrl);
  if (typeof extracted === 'string') return failed(extracted, page.status);
  if (!usable(extracted)) return failed('no_content', page.status);

  return { ok: true, extraction: extracted, via: 'page', httpStatus: page.status };
}
