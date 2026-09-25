/**
 * board-return.ts: where a posting's breadcrumb sends a reader back to.
 *
 * THE BUG THIS EXISTS FOR (2026-09-24, owner-reported). board-query.ts opens by
 * promising "THE URL IS THE STATE ... a bookmark, a shared link and the back
 * button all mean what they say", and the board keeps that promise: page,
 * filters, sort and size all ride in the address, so the browser's own back
 * button lands a reader exactly where they were. The breadcrumb on the posting
 * did not. It was a bare routeFor('board'), so a reader who paged to 4, opened
 * a role and pressed "The board" was returned to page 1 of an unfiltered table
 * and had to find their place again. The back button was never broken; this
 * one link was, and it is the one a reader reaches for because it is on the
 * page in front of them.
 *
 * WHY THE REFERRER AND NOT A COOKIE OR sessionStorage. The address the reader
 * came from is already being sent to us on that request, it costs nothing to
 * read, and it needs no script: /board/[slug] is prerender = false, so this
 * resolves on the server and the breadcrumb is correct in the HTML. A stored
 * "last board page" would also have to be invalidated, would be wrong in a
 * second tab, and would survive a reader who deliberately went back to page 1.
 *
 * WHY EVERY PARAMETER IS RE-PARSED RATHER THAN COPIED. The referrer is a header,
 * which means it is input. Feeding it back into an href verbatim would put a
 * string we did not write into a link we published. Instead the search string
 * goes through parseBoardQuery (which allowlists every value and reads anything
 * unknown as the default) and comes back out through boardHref, so the link can
 * only ever carry the seven parameters the board actually has, at values the
 * board actually accepts. A referrer of "?page=4&evil=1" returns "?page=4".
 *
 * It is deliberately NOT an open redirect in miniature: the path must be one of
 * the listing paths the caller names, and the origin must be our own. Anything
 * else returns null and the caller falls back to the plain board.
 */
import { boardHref, parseBoardQuery } from './board-query';

/** Trailing slashes are a presentation detail; /board and /board/ are one page. */
function normalise(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * The listing address a reader arrived from, re-emitted through the board's own
 * URL contract, or null when they did not arrive from one.
 *
 * @param referer     the request's Referer header, as it comes (may be absent)
 * @param requestUrl  this request's own URL, which supplies the origin to match
 * @param listPaths   the listing paths a breadcrumb may point back at
 */
export function boardReturnHref(
  referer: string | null | undefined,
  requestUrl: string | URL,
  listPaths: readonly string[]
): string | null {
  if (!referer) return null;

  let from: URL;
  let here: URL;
  try {
    from = new URL(referer);
    here = typeof requestUrl === 'string' ? new URL(requestUrl) : requestUrl;
  } catch {
    // A malformed Referer is not worth a 500. The breadcrumb falls back.
    return null;
  }

  if (from.origin !== here.origin) return null;

  const path = normalise(from.pathname);
  const allowed = listPaths.find((candidate) => normalise(candidate) === path);
  if (!allowed) return null;

  return boardHref(allowed, parseBoardQuery(from.searchParams));
}
