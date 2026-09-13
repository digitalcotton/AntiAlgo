/**
 * /machine/posting-fetch/claim: the Mac mini takes the next posting to read.
 *
 * GET with `Authorization: Bearer <MACHINE_FETCH_SECRET>`. With `?id=`, that
 * request (if it is claimable); without, the oldest claimable one. Answers
 * `{ id, url }` and nothing else, or 204 when nothing waits. Never a user id,
 * never an application id: the mini reads pages, it does not know people.
 *
 * Claimable means pending, or claimed longer ago than CLAIM_STALE_MS (a mini
 * that died mid-read). The claim is one atomic UPDATE with SKIP LOCKED, so two
 * drains never hand out the same row and a duplicate wake answers 204.
 *
 * No secret configured: 503, because a deployment without the secret has no
 * machine and should say so rather than 401 as if one had knocked wrong.
 */
import type { APIContext } from 'astro';
import { machineRequestAuth } from '../../../lib/machine-secret';
import { claimPostingFetch } from '../../../lib/posting-fetch-store';

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

  const raw = (context.url.searchParams.get('id') ?? '').trim();
  const id = /^[0-9a-f-]{36}$/i.test(raw) ? raw : null;
  const claimed = await claimPostingFetch(id);
  if (!claimed) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  return json({ id: claimed.id, url: claimed.url });
}
