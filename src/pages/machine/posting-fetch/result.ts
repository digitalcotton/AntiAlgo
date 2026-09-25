/**
 * /machine/posting-fetch/result: the Mac mini hands back what it read.
 *
 * POST, JSON, `Authorization: Bearer <MACHINE_FETCH_SECRET>`. The body names a
 * request id and an outcome: `ready` with title, company and the description
 * as HTML, or `unreadable` with one of our own failure codes. Everything is
 * treated as untrusted bytes from a page on the internet, which is what it is:
 * the HTML goes through sanitizeCrawledHtml() (the same parser-based pass the
 * board's descriptions get), names are trimmed and capped, enums come from
 * allowlists and anything else is a 400.
 *
 * Only a claimed row settles. A second result for a settled row answers 200
 * with accepted:false so the mini stops retrying; an unknown id likewise.
 *
 * NOTHING IS DRAFTED HERE (since 2026-09-11). The first edition started the
 * resume and cover letter the moment the text landed. That drafted before the
 * person could say why they want the job, and it spent a second draft when
 * they then pressed Generate with a reason. The read settles, the snapshot
 * fills, and the posting's own page (/board/added-<id>) waits with the reason
 * box and the Generate button; the draft starts there and only there.
 *
 * The body may also carry `board`: what the learning pass on the mini made of
 * the posting's board (added to the crawl, already known, no board). It is
 * kept as machine_notes so the page can say so. A malformed `board` is
 * dropped, never a 400: it is commentary on a read that already succeeded.
 */
import type { APIContext } from 'astro';
import { machineRequestAuth } from '../../../lib/machine-secret';
import {
  DESCRIPTION_MAX_CHARS,
  FAILURE_CODES,
  NAME_MAX_CHARS,
  SOURCE_KINDS,
  boardNoteFrom,
  type FailureCode,
  type MachineNotes,
  type SourceKind
} from '../../../lib/posting-fetch-store';
import { settlePostingAndFillSnapshot } from '../../../lib/posting-settle';
import { sanitizeCrawledHtml } from '../../../lib/description';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function name(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_CHARS);
  return trimmed || null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

export async function POST(context: APIContext): Promise<Response> {
  const auth = machineRequestAuth(context.request);
  if (auth === 'unset') return json({ ok: false, reason: 'not-configured' }, 503);
  if (auth === 'mismatch') return json({ ok: false, reason: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await context.request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ accepted: false, reason: 'bad-body' }, 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ accepted: false, reason: 'bad-body' }, 400);
  }

  const id = typeof body.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : null;
  if (!id) return json({ accepted: false, reason: 'bad-id' }, 400);
  const outcome = body.outcome === 'ready' || body.outcome === 'unreadable' ? body.outcome : null;
  if (!outcome) return json({ accepted: false, reason: 'bad-outcome' }, 400);

  const sourceKind = typeof body.source_kind === 'string' && (SOURCE_KINDS as readonly string[]).includes(body.source_kind)
    ? (body.source_kind as SourceKind)
    : null;
  const failureCode = typeof body.failure_code === 'string' && (FAILURE_CODES as readonly string[]).includes(body.failure_code)
    ? (body.failure_code as FailureCode)
    : null;
  if (outcome === 'unreadable' && !failureCode) return json({ accepted: false, reason: 'bad-failure-code' }, 400);
  if (outcome === 'ready' && sourceKind === null) return json({ accepted: false, reason: 'bad-source-kind' }, 400);

  const rawHtml = typeof body.description_html === 'string' ? body.description_html : '';
  const descriptionHtml = outcome === 'ready' && rawHtml.trim() ? sanitizeCrawledHtml(rawHtml).slice(0, DESCRIPTION_MAX_CHARS) : null;
  const httpStatus = Number.isInteger(body.http_status) ? (body.http_status as number) : null;
  const fetchedAtMs = typeof body.fetched_at === 'string' ? Date.parse(body.fetched_at) : Number.NaN;
  const fetchedAt = Number.isNaN(fetchedAtMs) ? new Date() : new Date(fetchedAtMs);
  const machineNotes: MachineNotes = {};
  const board = boardNoteFrom(body.board);
  if (board) machineNotes.board = board;

  const settled = await settlePostingAndFillSnapshot(id, {
    outcome,
    sourceKind,
    title: name(body.title),
    company: name(body.company),
    descriptionHtml,
    finalUrl: httpsUrl(body.final_url),
    httpStatus,
    failureCode,
    fetchedAt,
    machineNotes: { ...machineNotes, reader: 'mini' }
  });
  if (!settled) return json({ accepted: false, reason: 'already-settled' });

  return json({ accepted: true, outcome });
}
