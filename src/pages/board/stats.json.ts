/**
 * /board/stats.json: the board's own counts, as the database holds them.
 *
 * WHY THIS EXISTS. /board is server rendered, so the truth gate (test/gates/
 * truth.mjs), which reads built HTML under dist/, has never been able to check
 * a number on it. Since 2026-09-08 the gate has a --url mode that fetches the
 * live /board and checks every data-truth-metric="board_*" it finds against
 * this endpoint, then opens one killed posting's page and expects the closure
 * marker. This is the row the page read, nothing computed here, so the two
 * cannot disagree except by a real fault, which is the point of asking.
 *
 * sample_killed_slug is one slug the gate can fetch; null when nothing on the
 * board is killed, which is a true and checkable state.
 */
import type { APIRoute } from 'astro';
import { db, isConfigured } from '../../lib/db';
import { getBoardStats } from '../../lib/job-store';

export const prerender = false;

export const GET: APIRoute = async () => {
  if (!isConfigured()) {
    return new Response(JSON.stringify({ error: 'the job store is not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
  const stats = await getBoardStats();
  const { rows } = await db().query<{ slug: string | null }>(
    `SELECT slug FROM jobs WHERE status = 'killed' AND slug IS NOT NULL ORDER BY last_seen DESC NULLS LAST, slug LIMIT 1`
  );
  const { rows: countRows } = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs`);
  const body = {
    ...stats,
    board_rows: countRows[0]?.n ?? 0,
    sample_killed_slug: rows[0]?.slug ?? null,
    served_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
};
