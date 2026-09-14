export const prerender = false;

import type { APIRoute } from 'astro';
import { db, isConfigured } from '../../lib/db';

/*
 * POST /api/waitlist: the "Save my spot" landing page's one action. Takes an
 * email, no name, no password, and answers with the position it landed at.
 *
 * Idempotent on purpose: an email that is already on the list is not an
 * error, it is a read. Someone who submits twice, or opens the page in two
 * tabs, gets the same position both times rather than a "you're already on
 * the list" failure, so the client never has to branch on that case.
 *
 * Same-origin form/fetch POST, so Astro's default security.checkOrigin (on,
 * see astro.config.mjs) already covers this route; nothing here turns it off.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// No 0/1/i/l/o: a referral code a person might read aloud or retype should
// not have characters that are easy to swap for each other.
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

function randomReferralCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function badRequest(error: string, status = 400): Response {
  return json({ ok: false, error }, status);
}

async function readEmail(request: Request): Promise<string | null> {
  const contentType = request.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown> | null;
      const raw = body?.email;
      return typeof raw === 'string' ? raw : null;
    }
    // Covers application/x-www-form-urlencoded and multipart/form-data alike.
    const form = await request.formData();
    const raw = form.get('email');
    return typeof raw === 'string' ? raw : null;
  } catch {
    return null;
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!isConfigured()) return badRequest('The waitlist is not available right now.', 503);

  const raw = await readEmail(request);
  if (raw === null) return badRequest('Could not read the request body.');

  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return badRequest('That does not look like a valid email address.');

  const pool = db();

  // INSERT ... ON CONFLICT (email) only resolves a collision on the email
  // column. A collision on the separately-unique referral_code is a
  // different constraint, so it still raises (Postgres error 23505); when it
  // does, a fresh code is tried rather than surfacing that as a failed
  // signup. At this alphabet and length the odds of even one collision are
  // vanishing, so a handful of attempts is far more than enough headroom.
  let insertError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await pool.query('INSERT INTO waitlist_email (email, referral_code) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', [
        email,
        randomReferralCode()
      ]);
      insertError = null;
      break;
    } catch (error) {
      insertError = error;
      const code = (error as { code?: string } | null)?.code;
      if (code !== '23505') break; // not a referral_code collision, no point retrying
    }
  }
  if (insertError) {
    console.error('waitlist: insert failed:', insertError);
    return badRequest('Something went wrong. Try again.', 500);
  }

  try {
    const { rows } = await pool.query<{ position: number; total: number }>(
      `WITH me AS (
         SELECT id, created_at FROM waitlist_email WHERE email = $1
       )
       SELECT
         (SELECT count(*)::int FROM waitlist_email w, me
           WHERE (w.created_at, w.id) <= (me.created_at, me.id)) AS position,
         (SELECT count(*)::int FROM waitlist_email) AS total
       FROM me`,
      [email]
    );
    const row = rows[0];
    if (!row) return badRequest('Something went wrong. Try again.', 500);
    return json({ ok: true, position: row.position, total: row.total });
  } catch (error) {
    console.error('waitlist: position read failed:', error);
    return badRequest('Something went wrong. Try again.', 500);
  }
};
