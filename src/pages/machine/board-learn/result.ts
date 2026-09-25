/**
 * /machine/board-learn/result: what the mini made of that board.
 *
 * POST, JSON, `Authorization: Bearer <MACHINE_FETCH_SECRET>`. The body names a
 * row id and a board note: a verdict from learn_board()'s own list, and, where
 * there is a board, its name, its ATS and how many postings the first pull saw.
 *
 * THE NOTE GOES THROUGH THE SAME ALLOWLIST AS EVERY OTHER BOARD NOTE.
 * boardNoteFrom() is imported from the store rather than reimplemented here,
 * so a verdict this codebase does not know is a 400 and a name is trimmed and
 * capped exactly as it is on the read path. That matters more than it looks:
 * this is the one field on the row that the posting page prints from the
 * machine's own words.
 *
 * A SECOND RESULT IS NOT AN ERROR. A row that already carries a verdict answers
 * 200 with applied:false, the same stance /machine/posting-fetch/result takes
 * for an already-settled read, so a retrying mini stops rather than loops.
 */
import type { APIContext } from 'astro';
import { machineRequestAuth } from '../../../lib/machine-secret';
import { boardNoteFrom, settleBoardLearn } from '../../../lib/posting-fetch-store';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function POST(context: APIContext): Promise<Response> {
  const auth = machineRequestAuth(context.request);
  if (auth === 'unset') return json({ ok: false, reason: 'not-configured' }, 503);
  if (auth === 'mismatch') return json({ ok: false, reason: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await context.request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, reason: 'bad-json' }, 400);
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, reason: 'bad-id' }, 400);

  const note = boardNoteFrom(body.board);
  if (!note) return json({ ok: false, reason: 'bad-board' }, 400);

  const applied = await settleBoardLearn(id, note);
  return json({ ok: true, applied });
}
