/**
 * /board/kills.json: the recent kill records, as the database holds them.
 *
 * WHY THIS EXISTS. stats.json publishes the board's counts; this publishes the
 * rows behind the kill count, so a surface off this site (the Anti Algo
 * marketing site's evidence page) can render the actual records rather than a
 * number. Same shape of endpoint as stats.json: server rendered, read straight
 * from the store on every request, no-store, so what a reader sees is what the
 * sweep last wrote and not a build-time snapshot.
 *
 * THE WINDOW IS THE LAST TWO MONTHS, on purpose. The evidence surface shows what
 * is current, not the whole archive, so a record ages out of the feed as new
 * ones land. Older records still live on the kill list itself; this feed is the
 * recent slice, ordered newest first.
 *
 * Nothing here is computed except open_days, which is the two stored dates
 * subtracted, the same span the kill list draws. The company and title are the
 * record's own; redaction, if a consumer wants it, is the consumer's decision
 * and not baked into the record the store holds.
 */
import type { APIRoute } from 'astro';
import { db, isConfigured } from '../../lib/db';

export const prerender = false;

interface KillFeedRow {
  company: string;
  title: string;
  slug: string | null;
  kill_rule: string | null;
  reason: string;
  killed_on: string | null;
  first_published: string | null;
  open_days: number | null;
}

export const GET: APIRoute = async () => {
  if (!isConfigured()) {
    return new Response(JSON.stringify({ error: 'the job store is not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  const { rows } = await db().query<KillFeedRow>(
    `SELECT j.company,
            j.title,
            j.slug,
            k.kill_rule,
            k.reason,
            to_char(k.killed_on, 'YYYY-MM-DD')       AS killed_on,
            to_char(k.first_published, 'YYYY-MM-DD') AS first_published,
            (k.killed_on::date - k.first_published::date) AS open_days
       FROM jobs j
       JOIN board_kills k ON k.id = j.kill_id
      WHERE j.status = 'killed'
        AND k.killed_on IS NOT NULL
        AND k.killed_on >= (CURRENT_DATE - INTERVAL '2 months')
      ORDER BY k.killed_on DESC NULLS LAST, j.company ASC, j.title ASC
      LIMIT 200`
  );

  const body = {
    kills: rows,
    window_months: 2,
    served_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
};
