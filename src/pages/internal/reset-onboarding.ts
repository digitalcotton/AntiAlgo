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
 * resumé read in flight or waiting, every generated draft, the postings and
 * applications the free flow's "add a job by link" creates, every saved role
 * and Pre-List follow, the board's remembered filter selection, and the
 * funnel milestones this run crossed.
 *
 * THE JOB-SIDE ROWS WERE HALF THE PROBLEM. Until 2026-09-25 this list was
 * written out by hand and three tables added after it — watchlist (db/108),
 * account_filter_state (db/109) and analytics_event (db/128) — were never
 * added to it, so a "reset" account walked back into a board that still
 * remembered its filters, a Pre-List that still held its follows, and a
 * funnel that already counted its first draft. A list maintained by memory
 * drifts the moment a migration lands, so test/internal-reset-onboarding
 * -post.test.ts now checks OWNED against src/lib/account.ts's PERSON_TABLES
 * inventory: a new per-account table fails that test until it is named here
 * or named as deliberately kept.
 *
 * WHAT IT KEEPS, and as of 2026-09-25 this is the whole list: the account
 * row itself, its tier, its first and last name, its email, its verified
 * state, when it was created, and its live sessions. Everything else on the
 * profile row goes back to what a fresh signup has — the handle is released,
 * the resumé email settings, the signup source and the draft-on-apply choice
 * go back to their column defaults, and the PRF ledger is emptied so the
 * next entry is PRF-0001 again.
 *
 * WHY TIER AND THE SESSION SURVIVE, owner's call 2026-09-25. Tier: testing
 * the paid first run has to stay one click, and the "Set an account's tier"
 * form directly above this one on /internal is the tool for changing it.
 * Session: a genuinely brand-new account IS signed in the second it signs
 * up, so keeping the session is the accurate brand-new state, not a
 * shortcut — the tab stays alive and /start shows step 1 on refresh.
 *
 * A reset is still not a delete; the person is on the same account.
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
export const OWNED: readonly { table: string; column: string; label: string }[] = [
  { table: 'ledger_watch', column: 'user_id', label: 'titles' },
  { table: 'account_ledger_prefs', column: 'user_id', label: 'filters' },
  { table: 'user_provider_key', column: 'user_id', label: 'keys' },
  { table: 'record_entry', column: 'user_id', label: 'record entries' },
  { table: 'profile_link', column: 'user_id', label: 'links' },
  { table: 'resume_parse', column: 'user_id', label: 'reads' },
  { table: 'generated_render', column: 'user_id', label: 'drafts' },
  { table: 'desk_posting_fetch', column: 'user_id', label: 'added postings' },
  { table: 'desk_application', column: 'user_id', label: 'applications' },
  { table: 'desk_saved_job', column: 'user_id', label: 'saved roles' },
  { table: 'watchlist', column: 'user_id', label: 'Pre-List follows' },
  { table: 'account_filter_state', column: 'user_id', label: 'board filters' },
  { table: 'analytics_event', column: 'user_id', label: 'milestones' }
];

/** The per-account tables a reset deliberately does NOT clear, and why. Read
    by the same test that reads OWNED, so "we meant to leave this" is a
    written decision rather than an omission nobody noticed.

    record_artifact is not listed in OWNED because it does not need to be:
    its foreign key cascades from record_entry (user_id, prf_id), which
    OWNED does delete (db/104_profile_record.sql).

    app_user_profile is the row a reset keeps by definition — the account,
    its tier, its name, its email — so it is UPDATEd below rather than
    deleted, and that UPDATE is where "brand new" is actually enforced. */
export const KEPT: readonly { table: string; why: string }[] = [
  { table: 'record_artifact', why: 'cascades from record_entry, which OWNED deletes' },
  { table: 'app_user_profile', why: 'the row a reset keeps; its first-run columns are cleared by the UPDATE below' }
];

/** The app_user_profile columns a reset deliberately leaves alone, and why.
    Every OTHER column on that table must appear in the UPDATE below, and the
    test reads both this list and the schema to hold that: a migration that
    adds a column to app_user_profile fails the test until someone decides
    whether a reset clears it or keeps it. That decision being implicit is
    the whole bug this endpoint was rewritten for on 2026-09-25 — the reset
    had quietly stopped meaning "brand new". */
export const KEPT_COLUMNS: readonly { column: string; why: string }[] = [
  { column: 'user_id', why: 'the primary key; it IS the account' },
  { column: 'tier', why: "owner's call 2026-09-25: testing the paid first run stays one click. /internal's tier form is the tool for changing it" },
  { column: 'first_name', why: 'the name, which a reset keeps by definition' },
  { column: 'last_name', why: 'the name, which a reset keeps by definition' },
  { column: 'created_at', why: 'when the account was born, which a reset does not rewrite' }
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
      // The profile row stays, but nothing a run of Come ready wrote on it
      // stays with it. Every column here is set to DEFAULT rather than to a
      // literal wherever the column has one, so this statement cannot drift
      // from what a brand-new account actually starts with: the default is
      // read from the schema at execution, not copied here by hand.
      //
      // handle goes to NULL, which is a release, not a blank: db/110 makes
      // the column UNIQUE and nullable precisely so NULL is the ordinary
      // state and the name becomes claimable again.
      //
      // THE PRF LEDGER, and why this is the one place that empties it.
      // db/105_record_prf_ledger.sql makes record_prf_ids_issued append-only
      // so a deleted entry's PRF number is never reissued — every render
      // that ever cited PRF-0003 would otherwise go ambiguous about which
      // fact it meant. That reasoning holds for a person deleting one entry.
      // It does not hold here: this transaction has already deleted every
      // record_entry, every generated_render and every desk_application this
      // account has, so by the time this line runs there is nothing left
      // anywhere that cites a PRF number at all. Nothing can be made
      // ambiguous by reusing one. Leaving the ledger alone is what actually
      // broke the contract the owner asked for — a "brand new" account whose
      // first entry comes back as PRF-0003. db/208 updates the column's own
      // COMMENT so the schema stops claiming nothing ever empties it.
      //
      // THE RESUME RECEIPT (db/209) goes with the rest. It names the document
      // a past run read and the entries that read put in, and the loop above
      // has already deleted every record_entry this account had, so leaving
      // the receipt would offer a brand-new account a Remove for entries that
      // are not there. The cover letter's three columns directly above clear
      // for the same reason.
      await client.query(
        `UPDATE app_user_profile
            SET cover_letter_text = NULL,
                cover_letter_source_name = NULL,
                cover_letter_added_at = NULL,
                resume_source_name = NULL,
                resume_added_at = NULL,
                drafting_provider = NULL,
                generate_on_apply = DEFAULT,
                handle = NULL,
                resume_email = NULL,
                resume_email_use_login = DEFAULT,
                signup_source = DEFAULT,
                record_prf_ids_issued = DEFAULT,
                updated_at = now()
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
      `${row.email} is brand new again. Cleared: ${cleared.join(', ') || 'nothing, it was already clear'}, plus the profile row's own first-run columns (handle released, PRF numbering back to 0001). Its name, email, tier and sign-in are untouched.`
    );
  } catch (error) {
    console.error('internal/reset-onboarding: failed.', error);
    return relay(context, false, 'The database refused that. Nothing changed.');
  }
}
