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
import { sanitizeCrawledHtml } from './description';

/** The whole read, from the first guard to the last byte. A form POST is
    holding a person still while this runs, so it is deliberately short: past
    this, the queue is the better answer and the mini is better at the job. */
export const READ_BUDGET_MS = 6_000;
/** One request inside that budget. */
export const REQUEST_TIMEOUT_MS = 4_000;
/** The same ceiling postfetch.py sets, for the same reason: a job posting that
    does not fit in two megabytes is not a job posting. */
export const MAX_BYTES = 2 * 1024 * 1024;
/**
 * The ceiling for a resolver's own endpoint, which is a different kind of
 * thing and was being measured with the wrong ruler.
 *
 * MAX_BYTES is a statement about ONE POSTING. Two of the resolvers do not have
 * a per-posting endpoint to fetch: Ashby and Workable publish the WHOLE BOARD
 * and the parser picks the posting out of it. A board is legitimately large --
 * Ramp's Ashby board measured 2.8MB on 2026-09-29 -- so every Ashby posting on
 * any employer big enough to be worth pasting was failing the cap, returning
 * `too_large`, and falling through to the generic page reader. Silently: the
 * page read usually finds the JSON-LD block and settles, so the posting looked
 * fine and simply arrived with none of the facts the Ashby payload states and
 * a `jsonld` source kind. Ashby has the richest payload of the six, and it was
 * unreachable for exactly the boards people paste from.
 *
 * Eight megabytes is chosen against the thing being bought: Ramp at 2.8MB is
 * one of the larger boards, and this leaves that much room again before the
 * cap bites. It is still a cap -- the read is in a request, holding a person
 * still -- and the six second budget remains the real limit, since a board
 * this side of 8MB that cannot arrive in six seconds times out anyway.
 */
export const BOARD_MAX_BYTES = 8 * 1024 * 1024;
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
  resolver?: (host: string) => Promise<string[]>,
  /** The ceiling on THIS request. `REQUEST_TIMEOUT_MS` by default, which
      leaves room in the budget for the second call most resolver paths make.
      A caller that knows there will be no second call passes the whole
      remaining budget instead -- see `soleRequest` below. */
  capMs: number = REQUEST_TIMEOUT_MS,
  /** How many bytes this response may be. A posting's page gets `MAX_BYTES`;
      a resolver's endpoint gets `BOARD_MAX_BYTES`, because two of them serve
      a whole board rather than one posting. */
  maxBytes: number = MAX_BYTES
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
        signal: AbortSignal.timeout(Math.min(left, capMs)),
        headers: {
          // Say who we are, and mean it. This is the ON-REQUEST reader -- one
          // page, because a signed-in person pasted its address and is looking
          // at it -- so it is named apart from the nightly sweep (AntiAlgoBot
          // on the machine) and a site can refuse one without the other. The
          // URL used to point at /colophon, which is about this site's build
          // and says nothing about a crawler; an operator who followed it
          // learned nothing. /bot answers the question they actually have.
          'User-Agent': 'AntiAlgoReader/1.0 (+https://antialgo.ai/bot; contact Ryan@digitalcotton.com)',
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
    if (Number.isFinite(declared) && declared > maxBytes) return failed('too_large', response.status);

    const body = await readCapped(response, maxBytes);
    if (body === null) return failed('too_large', response.status);

    return { body, status: response.status, finalUrl: response.url || current, contentType };
  }

  return failed('http_error');
}

/** The body as text, or null when it runs past MAX_BYTES. Read through the
    stream rather than `response.text()` so an enormous page costs us the cap
    and not its whole length. */
async function readCapped(response: Response, maxBytes: number = MAX_BYTES): Promise<string | null> {
  if (!response.body) {
    const text = await response.text();
    return text.length > maxBytes ? null : text;
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
      if (total > maxBytes) {
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
 *
 * The one exception is a resolver whose endpoint IS the pasted page (Apple).
 * There the page read would refetch the identical address inside the same
 * budget, so it is skipped and the single request gets the whole budget
 * instead of the per-request ceiling. See `soleRequest` below.
 */
export async function readPostingNow(url: string, options: ReadOptions = {}): Promise<PostingReadResult> {
  const fetchImpl = options.fetchImpl ?? ((target, init) => fetch(target, init));
  const deadline = (options.now?.() ?? Date.now()) + (options.budgetMs ?? READ_BUDGET_MS);

  const resolved = resolvePosting(url);

  /**
   * True when the resolver's endpoint IS the page the person pasted, so this
   * read will make exactly one request no matter what happens.
   *
   * Apple is the case that made this explicit: its posting lives in the page's
   * own hydration blob, so `api` is the pasted URL. Without this the same
   * address was fetched twice inside one budget -- once by the resolver,
   * once by the page branch below -- and each got the per-request ceiling
   * rather than the budget, so a page answering in four and a half seconds
   * failed twice over instead of succeeding once. The second read could never
   * have added anything either: the bytes would have been identical, and the
   * generic extractor has already been shown to find nothing in them.
   *
   * So a sole request gets the whole remaining budget, and the page branch is
   * skipped. Every other resolver is untouched: their `api` is an ATS endpoint
   * on another host, the pasted page is genuinely a second thing to try, and
   * the two-call ceiling is what makes room for it.
   */
  const soleRequest = resolved !== null && resolved.api === url && !resolved.fallback;

  if (resolved) {
    const primary = await guardedFetch(
      resolved.api, fetchImpl, deadline, options.resolver,
      soleRequest ? options.budgetMs ?? READ_BUDGET_MS : REQUEST_TIMEOUT_MS,
      // Apple's `api` is the pasted page, so it keeps the posting-sized cap;
      // every other resolver's is an endpoint that may serve a whole board.
      soleRequest ? MAX_BYTES : BOARD_MAX_BYTES
    );
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
      const second = await guardedFetch(resolved.fallback.api, fetchImpl, deadline, options.resolver, REQUEST_TIMEOUT_MS, BOARD_MAX_BYTES);
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

      // SANITISE THE ATS PATH TOO. posting-extract.ts runs sanitizeCrawledHtml()
      // itself, so the page branch below arrives here already clean; the
      // resolvers hand back whatever HTML a board put inside its own JSON, and
      // that is bytes from a page on the internet by a slightly more
      // respectable-looking route. /machine/posting-fetch/result.ts sanitises
      // everything the mini sends for exactly this reason, and a read done here
      // instead of there must not be the cheaper one.
      extraction = {
        ...extraction,
        descriptionHtml: extraction.descriptionHtml ? sanitizeCrawledHtml(extraction.descriptionHtml) : null
      };

      if (usable(extraction)) {
        return { ok: true, extraction, via: 'resolver', httpStatus: status ?? 200 };
      }
    }
    // Fell through on purpose: try the page the person actually pasted --
    // unless that is the address we just read, in which case there is nothing
    // left to try here and the mini's browser is the next real layer.
    if (soleRequest) {
      return isFailure(primary) ? primary : failed('no_content', primary.status);
    }
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
