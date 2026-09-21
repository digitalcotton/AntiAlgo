/**
 * POST /internal/reset-onboarding: put one account back to the start of Come
 * ready, without deleting the account.
 *
 * WHY THIS EXISTS. Testing the first run means running it more than once, and
 * every step checks itself off against real rows, so a second run needs those
 * rows gone. The alternative was raw SQL in the Neon console every time, which
 * is how a test account gets half cleared and a flow gets debugged against a
 * state nobody can describe.
 *
 * WHAT IT REMOVES, and this is the whole list: watched titles, the Desk's
 * filters, provider keys and the designation that names which one drafts,
 * every Profile Record entry and its artifacts, links, the cover letter, any
 * resumé read in flight or waiting, every generated draft, and the postings
 * and applications the free flow's "add a job by link" creates.
 *
 * WHAT IT KEEPS: the account, its tier, its name, its email and its verified
 * state. A reset is not a delete; the person signs back in to the same
 * account and walks the flow again.
 *
 * THIS DESTROYS REAL WORK, so it is deliberately narrow. Internal tier only
 * (the middleware gates the whole /internal prefix), the address has to be
 * typed in full, and an internal account is refused outright: the tool for
 * clearing test accounts must never be one keystroke away from clearing the
 * account that operates it.
 */
import type { APIContext } from 'astro';
import { db } from '../../lib/db';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

const INTERNAL_PATH = '/internal';
const RELAY_COOKIE = 'internal_tier_relay';

/** Every table a run of Come ready writes to, and the column each keys the
    account by. Listed once, so what a reset clears is readable in one place
    rather than inferred from a wall of statements. */
const OWNED: readonly { table: string; column: string; label: string }[] = [
  { table: 'ledger_watch', column: 'user_id', label: 'titles' },
  { table: 'account_ledger_prefs', column: 'user_id', label: 'filters' },
  { table: 'user_provider_key', column: 'user_id', label: 'keys' },
  { table: 'record_entry', column: 'user_id', label: 'record entries' },
  { table: 'profile_link', column: 'user_id', label: 'links' },
  { table: 'resume_parse', column: 'user_id', label: 'reads' },
  { table: 'generated_render', column: 'user_id', label: 'drafts' },
  { table: 'desk_posting_fetch', column: 'user_id', label: 'added postings' },
  { table: 'desk_application', column: 'user_id', label: 'applications' },
  { table: 'desk_saved_job', column: 'user_id', label: 'saved roles' }
];

function redirect(): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(INTERNAL_PATH) } });
}

function relay(context: APIContext, ok: boolean, message: string): Response {
  context.cookies.set(RELAY_COOKIE, JSON.stringify({ ok, message }), {
    path: withBase(INTERNAL_PATH),
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    maxAge: 120
  });
  return redirect();
}

export function GET(): Response {
  return redirect();
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  if (!viewer || context.locals.verdict?.allow !== true) {
    return new Response('Not available on your account.', { status: 403 });
  }

  const form = await context.request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!email.includes('@')) return relay(context, false, 'That does not look like an email address.');

  try {
    const { rows } = await db().query<{ id: string; email: string; tier: string | null }>(
      `SELECT u.id, u.email, p.tier
         FROM "user" u
         LEFT JOIN app_user_profile p ON p.user_id = u.id
        WHERE lower(u.email) = $1
        LIMIT 1`,
      [email]
    );
    const row = rows[0];
    if (!row) return relay(context, false, `No account for ${email}.`);
    if (row.tier === 'internal') {
      return relay(context, false, `${row.email} is internal. An internal account is not reset here.`);
    }

    // One transaction: a half-cleared account is a worse state to debug than
    // either end of this.
    const client = await db().connect();
    const cleared: string[] = [];
    try {
      await client.query('BEGIN');
      for (const { table, column, label } of OWNED) {
        const result = await client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [row.id]);
        if (result.rowCount) cleared.push(`${result.rowCount} ${label}`);
      }
      // The letter and the designation live on the profile row, which stays.
      await client.query(
        `UPDATE app_user_profile
            SET cover_letter_text = NULL,
                cover_letter_source_name = NULL,
                cover_letter_added_at = NULL,
                drafting_provider = NULL
          WHERE user_id = $1`,
        [row.id]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    console.log(`internal/reset-onboarding: ${viewer.userId} reset ${row.email}: ${cleared.join(', ') || 'nothing to clear'}.`);
    return relay(
      context,
      true,
      `${row.email} is back at the start of Come ready. Cleared: ${cleared.join(', ') || 'nothing, it was already clear'}. The account, its tier and its sign-in are untouched.`
    );
  } catch (error) {
    console.error('internal/reset-onboarding: failed.', error);
    return relay(context, false, 'The database refused that. Nothing changed.');
  }
}
