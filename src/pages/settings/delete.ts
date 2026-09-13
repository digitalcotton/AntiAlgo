/**
 * POST /settings/delete: full erase of the signed-in caller's person-owned
 * rows plus render files. RUN-MASTER F1's "delete account" and its acceptance
 * line, "delete leaves zero person rows".
 *
 * MOUNTED AT /settings/delete, NOT /api/settings/delete, AND THAT IS FORCED,
 * FOR THE SAME REASON src/pages/auth/[...all].ts IS NOT AT /api/auth. This
 * repo has a root `api/` directory (api/subscribe.ts), which Vercel treats as
 * a zero-config serverless functions folder claiming every /api/* path before
 * Astro's router is ever consulted. vercel.json also rewrites everything this
 * deployment serves from /jobs/:path* down to /:path*, so a request that
 * looks like /jobs/api/settings/delete on the wire arrives here as
 * /api/settings/delete, squarely inside that claimed namespace. Verified on a
 * preview deploy for the auth case with the identical shape: /api/subscribe
 * answered 303 and /api/auth/ok answered 404 (see auth/[...all].ts's own
 * header). This route was first written at /api/account/delete and would
 * have 404'd in production the same way; it lives at /settings/delete now,
 * under the '/settings' prefix (src/lib/entitlement.ts). Do not move it
 * back under /api.
 *
 * WHO THIS CAN ACT ON. Same rule as export.ts and for the same reason: no id
 * anywhere on this route, only Astro.locals.viewer, which entitlement.ts's
 * '/settings' entry in GATED_PREFIXES resolves through middleware before this
 * file runs ('/settings/delete'.startsWith('/settings/'), so no second
 * ROUTE_POLICY entry is needed). A route that took an id could delete someone
 * else's account; this one cannot, because there is nowhere to put one.
 *
 * A PLAIN FORM POST, ON PURPOSE, NO CLIENT SCRIPT REQUIRED FOR THE ACTION
 * ITSELF. Unlike sign-in.astro, this route never needed Better Auth's own
 * JSON endpoint: it is this app's own handler, so it can accept a native
 * application/x-www-form-urlencoded submission and answer with a redirect,
 * exactly what a browser does with no JavaScript running at all. Keyboard
 * and screen-reader users get the same path as everyone else because it is
 * the only path.
 *
 * THE ORDER, AND WHY IT IS NOT ONE TRANSACTION EVEN THOUGH THE BRIEF ASKS FOR
 * ONE. Read literally, node_modules/better-auth/dist/db/internal-adapter.mjs's
 * deleteUser(userId) is itself a bare sequence of independent deletes (no
 * BEGIN anywhere in the function), run through Better Auth's own adapter,
 * which is not the same pg.Pool this file's own queries run through (traced
 * via node_modules/better-auth/dist/context/create-context.mjs, where
 * `internalAdapter` and the raw `adapter` are two different objects built from
 * the Pool at startup). Wrapping this route's own BEGIN/COMMIT around a call
 * into that separate adapter would not make Better Auth's three deletes
 * atomic with anything; it would just be a transaction that does not cover
 * the work it claims to. So what actually runs is: this file's own statement
 * (the verification cleanup) genuinely wrapped in a transaction, because that
 * one is entirely this file's to control; then internalAdapter.deleteUser();
 * then a survivor count across every table PERSON_TABLES knows how to check.
 * The survivor count is the backstop true atomicity would have made
 * unnecessary: if anything at all is left, this fails loudly instead of
 * reporting success. That gap, and the fact that it can only be closed by
 * forking Better Auth's adapter layer, is written down here rather than
 * quietly worked around, and it is the one item in this task's report that a
 * human has to weigh, not something this code can decide for them.
 *
 * WHERE THIS SENDS SOMEONE, ON EACH OUTCOME. On success, there is no page
 * left to send a reader back to: /account is gone and this reader's own
 * /settings would just 401 them right back out. The redirect goes to
 * sign-in.astro instead, with ?deleted=1, which renders "Your account is
 * deleted. Everything it owned is gone." before the generic signed-out form
 * a denied request would otherwise show; see sign-in.astro's own header for
 * that render. On failure, the redirect goes back to /settings?delete-failed=1,
 * which settings.astro's own "Your data" section reads to show the same
 * "nothing was changed" notice this file's own comments describe below.
 */
import type { APIContext } from 'astro';
import { getAuth } from '../../lib/auth';
import { db } from '../../lib/db';
import { PERSON_TABLES } from '../../lib/account';
import { withBase } from '../../../site.config.mjs';

export const prerender = false;

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: withBase(path) } });
}

export async function POST(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;

  if (!viewer || verdict?.allow !== true) {
    return new Response('Not signed in.', { status: 401 });
  }

  // A typed confirmation, checked server-side, not just in the markup: account
  // deletion is irreversible, and this makes a stray or scripted POST that did
  // not carry the exact word a no-op that returns the person to settings rather
  // than erasing their record. The origin gate (middleware) already refuses a
  // cross-site POST; this guards the accidental one-click case as well.
  const form = await context.request.formData();
  if (String(form.get('confirm') ?? '') !== 'DELETE') {
    return redirect('/settings?delete-unconfirmed=1');
  }

  const userId = viewer.userId;

  const verification = PERSON_TABLES.find((entry) => entry.table === 'verification');
  if (!verification || !verification.verifyColumn) {
    // Cannot happen with the current PERSON_TABLES, and account.test.ts pins
    // that verification always carries a verifyColumn. Guarded anyway: a
    // delete route silently skipping its own cleanup statement because a
    // constant changed shape is exactly the failure mode this task exists to
    // rule out, so a missing entry aborts instead of proceeding as if it had
    // nothing to do.
    console.error('settings delete: PERSON_TABLES has no usable "verification" entry; refusing to proceed.');
    return redirect('/settings?delete-failed=1');
  }

  // Step 1: this file's own statement, genuinely transactional because it is
  // entirely this file's own connection. internalAdapter.deleteUser() never
  // reaches this table (see the file header and account.ts's own note on
  // "verification"), so a live password-reset row would otherwise outlive
  // the account it was issued for.
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${verification.sql} WHERE ${verification.verifyColumn} = $1`, [userId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('settings delete: failed to clear verification rows; nothing else was touched.', error);
    return redirect('/settings?delete-failed=1');
  } finally {
    client.release();
  }

  // Step 2: Better Auth's own cascade. See the file header for why this is
  // not wrapped in the same transaction as step 1.
  let authContext: Awaited<ReturnType<typeof getAuth>['$context']>;
  try {
    authContext = await getAuth().$context;
    await authContext.internalAdapter.deleteUser(userId);
  } catch (error) {
    console.error(
      'settings delete: internalAdapter.deleteUser failed. The account may be partially deleted. ' +
        'Do not report this as a completed delete; a human needs to look at this user id directly.',
      error
    );
    return redirect('/settings?delete-failed=1');
  }

  // Step 3: fail loudly rather than trust step 2. Every table with a real
  // verifyColumn gets checked; 'not-user-linked' tables (rateLimit) have none
  // to check, by design, and are skipped rather than given a query that could
  // not mean anything.
  const survivors: string[] = [];
  for (const entry of PERSON_TABLES) {
    if (!entry.verifyColumn) continue;
    const { rows } = await db().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${entry.sql} WHERE ${entry.verifyColumn} = $1`,
      [userId]
    );
    if (Number(rows[0]?.count ?? '0') > 0) survivors.push(entry.table);
  }

  if (survivors.length > 0) {
    console.error(
      `settings delete: rows survived deletion for user ${userId} in: ${survivors.join(', ')}. ` +
        'This is reported as a failure even though internalAdapter.deleteUser() did not throw.'
    );
    return redirect('/settings?delete-failed=1');
  }

  // The account is gone. Clearing the cookie is best-effort from here: the
  // deletion already succeeded and is not undone by a cookie that fails to
  // clear, so a failure in this step is logged, not surfaced as the delete
  // having failed.
  try {
    const signOutResponse = await getAuth().api.signOut({
      headers: context.request.headers,
      asResponse: true
    });
    // Back to sign-in, not /account: /account is gone, and this reader's
    // own /settings would just 401 them right back out. sign-in.astro reads
    // ?deleted=1 and renders "Your account is deleted. Everything it owned
    // is gone." before the generic sign-in form, so the last thing shown is
    // a plain statement of what happened rather than a page that just looks
    // like a login wall.
    const response = redirect('/sign-in?deleted=1');
    for (const cookie of signOutResponse.headers.getSetCookie?.() ?? []) {
      response.headers.append('Set-Cookie', cookie);
    }
    return response;
  } catch (error) {
    console.error('settings delete: succeeded, but clearing the session cookie failed.', error);
    return redirect('/sign-in?deleted=1');
  }
}
