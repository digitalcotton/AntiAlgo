/**
 * GET /board/suggest: the search box's grouped, counted suggestions for the text
 * being typed. The contract is "The suggest contract" in docs/search-engine-plan.md
 * and the logic is src/lib/search-suggest.ts, which has the argument for every
 * number this returns; this file is the HTTP around it and nothing else.
 *
 * `GET /board/suggest?q=<text>&<every board parameter>&v=<crawl instant>`
 *
 * WHERE IT LIVES. Beside /board/[slug], under /board, because Astro's routing
 * puts a static route ahead of a dynamic one, so /board/suggest is this and never
 * the posting whose slug is "suggest". Not under /api: the repo's root api/
 * directory claims every /api/* path on Vercel before Astro is asked
 * (.claude/rules/no-pages-api.md), and the path is built by routeFor('board-suggest')
 * everywhere it is used.
 *
 * THE TEXT IS PARSED BEFORE ANY CAP THE BOARD APPLIES TO ITS OWN `q`. The board
 * reads at most 120 characters of `q`; the box may send 200, and a pay or a place
 * at character 150 is as much a fact as one at character 5. `q` here is cut at
 * the parser's own limit (SEARCH_MAX_CHARS) and nowhere else. Text past it is
 * truncated, not refused.
 *
 * THE FILTERS ARE THE BOARD'S, READ THE BOARD'S WAY. Every parameter other than
 * `q`, `v` and `page` goes through parseBoardQuery (via suggestBaseQuery), the one
 * reader of the address, so a value the board would ignore is ignored here and a
 * counted row can never be narrower or wider than the table. The one thing an
 * address cannot be trusted with is `title=`: a title only narrows the board for
 * a member who holds it on their Desk (board.astro keeps only those), so it is
 * resolved the same way here, from the session, and an answer that depends on
 * the session is never cached by anyone else (`private, no-store`).
 *
 * CACHING, per the contract. `v` is the crawl instant the page was drawn for.
 * When it is still the current one the answer is a pure function of the URL and
 * is shared for a day (a new crawl is a new `v`, so a new URL); when it is not,
 * or none was sent, the answer is for the current crawl, carries that `v`, and is
 * kept by nobody. suggestCacheControl is the one place that is decided.
 *
 * A server error is `500 {"error": "<message>"}` and the box shows its error
 * state. The message is fixed text: what went wrong goes to the log, because a
 * driver's error can carry a host name and this body goes to the browser.
 */
import type { APIRoute } from 'astro';
import { isConfigured } from '../../lib/db';
import { boardRowsLoadedAt, getBoardStats } from '../../lib/job-store';
import { listWatches } from '../../lib/ledger-watch-store';
import { getLexicon } from '../../lib/search-lexicon';
import { SEARCH_MAX_CHARS } from '../../lib/search-parse';
import { suggest, suggestBaseQuery, suggestCacheControl } from '../../lib/search-suggest';
import { sweepDate } from '../../lib/data';
import { routeFor } from '../../data/nav';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function failure(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store' }
  });
}

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    if (!isConfigured()) return failure('Suggestions are unavailable.');

    const text = (url.searchParams.get('q') ?? '').slice(0, SEARCH_MAX_CHARS);
    const asked = url.searchParams.get('v') ?? '';
    const { query, namedTitles } = suggestBaseQuery(url.searchParams);

    // The crawl instant, read now rather than remembered: a remembered one would
    // let an answer for the new crawl be filed under the old one's address.
    const stamp = boardRowsLoadedAt(await getBoardStats());
    const v = stamp ?? '';

    // The titles the member holds among the ones the address names, the same
    // rule board.astro applies. A signed-out reader, or a failed read, holds none.
    let titles: string[] = [];
    const viewer = locals.viewer;
    if (namedTitles.length > 0 && viewer?.emailVerified) {
      try {
        const held = new Set((await listWatches(viewer.userId)).map((w) => w.title));
        titles = namedTitles.filter((title) => held.has(title));
      } catch (error) {
        console.error('board/suggest: could not read the Desk titles; counting without them.', error);
      }
    }

    const body = await suggest({
      text,
      base: { ...query, titles },
      lex: await getLexicon(stamp),
      boardPath: routeFor('board'),
      sweepDate: sweepDate(),
      v
    });

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { ...JSON_HEADERS, 'Cache-Control': suggestCacheControl(asked, v, namedTitles.length > 0) }
    });
  } catch (error) {
    console.error('board/suggest: the suggestions could not be built.', error);
    return failure('Suggestions are unavailable.');
  }
};
