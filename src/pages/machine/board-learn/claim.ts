/**
 * /machine/board-learn/claim: the Mac mini takes the next board to look at.
 *
 * GET with `Authorization: Bearer <MACHINE_FETCH_SECRET>`. Answers `{ id, url }`
 * or 204 when nothing waits. The same shape, the same secret and the same
 * silence about people as /machine/posting-fetch/claim: the mini learns boards,
 * it does not know who added anything.
 *
 * WHY THIS ROUTE EXISTS AT ALL. Until the site started reading postings itself,
 * learning a board was free: the mini read a page and learn_board() noticed the
 * board that page sat on in the same pass. The site reading the common case
 * took that away without meaning to, and with it the half of "Add a job" that
 * grows the corpus for everyone instead of for one person. This route gives it
 * back by separating the two jobs the mini used to do at once: it is handed the
 * URLs the site already read, purely so the board behind them can be measured
 * and, where it is new and answers, added to the nightly crawl.
 *
 * NOTHING HERE IS A READ. The mini is not being asked to fetch this posting;
 * the posting is already read and stored. It is being asked about the board,
 * and the row it gets back is closed by /machine/board-learn/result with a
 * verdict, never with posting text.
 */
import type { APIContext } from 'astro';
import { machineRequestAuth } from '../../../lib/machine-secret';
import { claimBoardLearn } from '../../../lib/posting-fetch-store';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function GET(context: APIContext): Promise<Response> {
  const auth = machineRequestAuth(context.request);
  if (auth === 'unset') return json({ ok: false, reason: 'not-configured' }, 503);
  if (auth === 'mismatch') return json({ ok: false, reason: 'unauthorized' }, 401);

  const claimed = await claimBoardLearn();
  if (!claimed) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  return json({ id: claimed.id, url: claimed.url });
}
