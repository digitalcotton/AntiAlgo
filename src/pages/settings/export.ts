/**
 * GET /settings/export: every person-owned row this database holds about the
 * signed-in caller, as one JSON file. RUN-MASTER F1's "export bundle (every
 * person-owned row as JSON, one click)".
 *
 * MOUNTED AT /settings/export, NOT /api/settings/export, AND THAT IS FORCED,
 * FOR THE SAME REASON src/pages/auth/[...all].ts IS NOT AT /api/auth. This
 * repo has a root `api/` directory (api/subscribe.ts), which Vercel treats as
 * a zero-config serverless functions folder claiming every /api/* path before
 * Astro's router is ever consulted. vercel.json also rewrites everything this
 * deployment serves from /jobs/:path* down to /:path*, so a request that
 * looks like /jobs/api/settings/export on the wire arrives here as
 * /api/settings/export, squarely inside that claimed namespace. Verified on a
 * preview deploy for the auth case with the identical shape: /api/subscribe
 * answered 303 and /api/auth/ok answered 404 (see auth/[...all].ts's own
 * header). This route was first written at /api/account/export and would
 * have 404'd in production the same way; it lives at /settings/export now,
 * under the '/settings' prefix (src/lib/entitlement.ts). Do not move it
 * back under /api.
 *
 * A GET on purpose. This route reads and changes nothing, so it needs no
 * client script and no form to reach: a plain <a href> triggers the download
 * via Content-Disposition below, works with the keyboard exactly as any link
 * does, and survives a right-click "save link as" the way a POST-only action
 * would not.
 *
 * WHO THIS CAN ACT ON. There is no id anywhere in this route, not in the URL,
 * not in a query string, not in a body. The only account it can ever read is
 * the one the session on this request proves, via Astro.locals.viewer, which
 * src/lib/entitlement.ts resolves through middleware.ts before this file ever
 * runs: '/settings' is a gated prefix, and isGated() matches this route by
 * that prefix ('/settings/export'.startsWith('/settings/')), so no second
 * ROUTE_POLICY entry is needed for it. A route that took an id would be a
 * route that could export someone else's account by guessing it; this route
 * cannot, by construction.
 */
import type { APIContext } from 'astro';
import { db } from '../../lib/db';
import {
  exportShape,
  type ExportField,
  type ExportInput,
  type RawAccountRow,
  type RawProfileRow,
  type RawSessionRow,
  type RawUserRow
} from '../../lib/account';
import { listEntries, listLinks } from '../../lib/record-store';
import { listApplications, listSavedJobs } from '../../lib/desk-store';
import { listPostingFetches } from '../../lib/posting-fetch-store';
import { listFollows } from '../../lib/watchlist-store';
import { getFilterState } from '../../lib/filters-store';

export const prerender = false;

/**
 * THE SET OF READS THIS ROUTE RUNS FOR record/desk DATA, DERIVED, THE SAME
 * WAY exportShape()'s bundle shape is already derived from PERSON_TABLES
 * rather than hand-listed beside it.
 *
 * Keyed by ExportField, src/lib/account.ts's own name for "which ExportInput
 * field a table's export data lands in before exportShape() nests it under
 * the table's exportBundleKey." Typed `{ [K in ExportField]: ... }`, not
 * `Record<ExportField, ...>` written out by hand, for a concrete reason: if
 * account.ts's PERSON_TABLES ever grows a new exportField this map has no
 * entry for, TypeScript refuses to compile this file until one is added.
 * That half of the guarantee is the compiler's job.
 *
 * THE OTHER HALF: GET() below never names 'records', 'savedJobs' or
 * 'applications' by hand either. It loops Object.keys(READERS), awaits every
 * reader concurrently, and spreads the results straight into exportShape()'s
 * input. That is what makes this a derivation and not a second hand-list
 * beside the first: adding a table whose data needs a new reader means
 * adding one line here, to this object, and nothing else, anywhere, ever
 * gets touched or can be forgotten. Before this task, desk_saved_job and
 * desk_application shipped with includedInExport: true in PERSON_TABLES and
 * this route still queried only user, session, account and
 * app_user_profile: the type system had nothing to check because no
 * ReaderMap and no loop existed yet, so the gap compiled clean and stayed
 * green over an empty desk.savedJobs/desk.applications for a whole task.
 *
 * 'records' maps to listEntries(), not a separate function per table: both
 * record_entry and record_artifact resolve to 'records' in PERSON_TABLES
 * (see that field's own comment), because listEntries() already nests one
 * inside the other. Two PERSON_TABLES rows, one reader, one map entry: that
 * is a feature of the shape, not a gap in it.
 *
 * 'watchlist' maps to watchlist-store.ts's listFollows(), added alongside
 * db/008_watchlist.sql and account.ts's watchlist PERSON_TABLES entry: this
 * is the one line that entry's own exportField requires, and it is what
 * keeps this file compiling now that ExportField carries a fourth member.
*
 * WHY THE TYPE BELOW EXCLUDES undefined AND NOT null. It used to say
 * NonNullable, which was correct while every exportable field was an array:
 * a reader that returned nothing was a reader that had failed. `filters` broke
 * that, and the break is a real distinction rather than a typing nuisance.
 * A person who has never saved a filter selection and a person who saved one
 * and cleared it are two different facts, and their bundle should say which,
 * so account_filter_state's reader returns null for the first and a row for
 * the second. `undefined` stays forbidden, because that is still what a reader
 * returning nothing at all looks like, and that is still a bug.
 */
type ReaderMap = { [K in ExportField]: (userId: string) => Promise<Exclude<ExportInput[K], undefined>> };

const READERS: ReaderMap = {
  records: listEntries,
  links: listLinks,
  savedJobs: listSavedJobs,
  applications: listApplications,
  postingFetches: listPostingFetches,
  watchlist: listFollows,
  // Returns null when this person has never saved a filter selection, which is
  // a real state and not an empty one: "I have not set filters" and "I set
  // filters and cleared them" are different facts about somebody, and the
  // bundle says which. ReaderMap's NonNullable wrapper covers the field, not
  // the value, so a nullable reader belongs here exactly like the others.
  filters: getFilterState
};

export async function GET(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  const verdict = context.locals.verdict;

  // Refuse before touching the database. A verdict that is not an outright
  // allow covers signed-out and email-unverified alike; neither gets a query
  // run on their behalf.
  if (!viewer || verdict?.allow !== true) {
    return new Response(JSON.stringify({ error: 'Not signed in.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const userId = viewer.userId;

  // The four raw reads Better Auth's own tables and app_user_profile need
  // (nothing in src/lib/account.ts wraps these in a store-module reader, so
  // there is no ReaderMap entry for them, the same "null exportField" the
  // PERSON_TABLES rows for user/session/account/profile document), plus
  // every READERS entry, all scoped to this one proven userId, run
  // together. See ReaderMap's own comment above for why the second group is
  // a loop over that object rather than named calls written out here.
  const [userResult, sessionResult, accountResult, profileResult, readerEntries] = await Promise.all([
    db().query<RawUserRow>('SELECT * FROM "user" WHERE id = $1', [userId]),
    db().query<RawSessionRow>('SELECT * FROM session WHERE "userId" = $1 ORDER BY "createdAt" DESC', [userId]),
    db().query<RawAccountRow>('SELECT * FROM account WHERE "userId" = $1', [userId]),
    db().query<RawProfileRow>('SELECT * FROM app_user_profile WHERE user_id = $1', [userId]),
    Promise.all(
      (Object.keys(READERS) as ExportField[]).map(
        async (field) => [field, await READERS[field](userId)] as const
      )
    )
  ]);

  const user = userResult.rows[0];
  if (!user) {
    // The session proved a user id that no longer has a user row. That is a
    // signed-out account wearing a still-valid cookie, not a 500: answer the
    // same way an unauthenticated caller would rather than describe why.
    return new Response(JSON.stringify({ error: 'Not signed in.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Object.fromEntries loses the per-key literal types Promise.all's map
  // above tracked; the cast restores them. It is safe, not a silencer:
  // readerEntries was built by mapping Object.keys(READERS), and READERS's
  // own type (ReaderMap, above) guarantees that key set is exactly
  // ExportField, so every field this type promises is actually present.
  const readerData = Object.fromEntries(readerEntries) as {
    [K in ExportField]: NonNullable<ExportInput[K]>;
  };

  const bundle = exportShape({
    user,
    sessions: sessionResult.rows,
    accounts: accountResult.rows,
    profile: profileResult.rows[0] ?? null,
    generatedAt: new Date(),
    ...readerData
  });

  const body = JSON.stringify(bundle, null, 2);

  // The filename carries a date, never the person's email or name: a
  // downloaded file's name is visible in a Downloads folder listing, a
  // screenshot, a shared screen, to anyone who never asked to see either.
  const dateStamp = new Date().toISOString().slice(0, 10);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="account-data-export-${dateStamp}.json"`,
      'Cache-Control': 'no-store'
    }
  });
}
