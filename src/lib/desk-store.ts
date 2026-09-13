/**
 * desk-store.ts: the impure half of the Desk (MASTER-SPEC 3.5, F4). Every
 * query db/006_desk.sql's two tables get, and nothing this file decides on
 * its own: the same split record-store.ts already draws against record.ts,
 * restated here for the same reason. src/lib/desk.ts is pure and decides
 * (STM-0002's states and legal edges, the click-is-not-applied guard, the
 * fate overlay, the friction-timing rule, the 14-day self-archive
 * predicate); this file does I/O and decides nothing, including about
 * ownership: every function below takes a `userId`, and every function
 * scopes its query to that id. None of them accepts a userId from a
 * request body, because a userId is a viewer fact, resolved server-side
 * from the session by src/lib/viewer.ts, never a form field a caller could
 * type a stranger's id into.
 *
 * PARAMETERISED QUERIES ONLY. No string ever gets concatenated into SQL
 * here; every value a caller supplies travels as a placeholder argument.
 *
 * THIS FILE DOES NOT CALL src/lib/desk.ts's transition(). That is
 * deliberate, and it is the same division record-store.ts already draws
 * against record.ts's validateEntry(): the decision (is this STM-0002 edge
 * legal, does a move to 'applied' carry a real PersonConfirmation, does a
 * move to 'abandoned' carry one of the six F4.1 reasons) is made once, by
 * the endpoint under src/pages/desk/ that calls transitionApplication()
 * below, not by this file. transitionApplication() trusts the `to` value
 * it is handed. See that function's own comment for what that trust does
 * and does not cover.
 *
 * THE CREATE-FROM-CLICK FUNCTION IS THE ONE THAT MATTERS MOST. See
 * createApplicationFromClick()'s own comment: it has no parameter that can
 * spell any state but 'clicked', which is db/006_desk.sql's own column
 * default. A row leaves 'clicked' only through transitionApplication(),
 * and transitionApplication() only ever runs after an endpoint has already
 * gone through desk.ts's transition() and, for a move to 'applied',
 * through recordPersonConfirmation(). That chain, not a check inside this
 * file, is what makes silent auto-applied structurally impossible end to
 * end; see desk.ts's own header for the half of that claim it is
 * responsible for.
 */
import { db } from './db';
import { recordEvent } from './analytics';
import type { AbandonReason, ApplicationState, ClosedReason } from './desk';

/* -------------------------------------------------------------------------
   Shared helpers.
   ------------------------------------------------------------------------- */

/** node-postgres returns a timestamptz as a Date already in the common
    case, but a test can hand this an ISO string, and a driver upgrade
    could too. Pure: no clock read, a value in, the same instant out. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/* -------------------------------------------------------------------------
   desk_saved_job: a bookmark against a verified posting, before a click.
   ------------------------------------------------------------------------- */

export interface SavedJobRow {
  user_id: string;
  job_id: string;
  saved_at: Date | string;
  updated_at: Date | string;
}

export interface StoredSavedJob {
  jobId: string;
  savedAt: Date;
  updatedAt: Date;
}

/** Pure: a row in, the shape the rest of the app reads out. */
export function rowToStoredSavedJob(row: SavedJobRow): StoredSavedJob {
  return { jobId: row.job_id, savedAt: toDate(row.saved_at), updatedAt: toDate(row.updated_at) };
}

/** Every job this person has saved, most recently saved first. */
export async function listSavedJobs(userId: string): Promise<StoredSavedJob[]> {
  const { rows } = await db().query<SavedJobRow>(
    'SELECT * FROM desk_saved_job WHERE user_id = $1 ORDER BY saved_at DESC',
    [userId]
  );
  return rows.map(rowToStoredSavedJob);
}

/**
 * Saves one job. Idempotent, matching db/006_desk.sql's own comment on its
 * primary key: "saving again is a no-op, not a second row." The upsert's
 * DO UPDATE is a no-op write (it sets user_id to the value it already is)
 * rather than DO NOTHING, purely so RETURNING still has a row to hand
 * back on the "already saved" path; it changes nothing about what is
 * stored.
 */
export async function saveJob(userId: string, jobId: string): Promise<StoredSavedJob> {
  const { rows } = await db().query<SavedJobRow>(
    `INSERT INTO desk_saved_job (user_id, job_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, job_id) DO UPDATE SET user_id = desk_saved_job.user_id
     RETURNING *`,
    [userId, jobId]
  );
  return rowToStoredSavedJob(rows[0]);
}

/** Removes one saved job. Returns whether a row was actually removed, the
    same "gone versus never there" distinction deleteEntry() in
    record-store.ts returns. */
export async function unsaveJob(userId: string, jobId: string): Promise<boolean> {
  const result = await db().query('DELETE FROM desk_saved_job WHERE user_id = $1 AND job_id = $2', [
    userId,
    jobId
  ]);
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------
   desk_application: the tracker's spine.
   ------------------------------------------------------------------------- */

export interface ApplicationRow {
  /** bigint IDENTITY. node-postgres returns int8 as a string by default,
      the same quirk RecordArtifactRow's id documents in record-store.ts. */
  id: string | number;
  user_id: string;
  job_id: string | null;
  external_url: string | null;
  snapshot_title: string | null;
  snapshot_company: string | null;
  snapshot_description: string | null;
  state: ApplicationState;
  interview_substage: string | null;
  abandon_reason: AbandonReason | null;
  closed_reason: ClosedReason | null;
  offered_comp: string | null;
  resume_render_id: string | null;
  cover_render_id: string | null;
  clicked_at: Date | string;
  confirmed_at: Date | string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface StoredApplication {
  id: number;
  /** Exactly one of jobId/externalUrl is non-null, matching db/006_desk.sql's
      XOR CHECK (MASTER-SPEC F4.2: a verified posting, or any pasted URL). */
  jobId: string | null;
  externalUrl: string | null;
  /** Taken at clicked_at, never re-fetched. See db/006_desk.sql's own
      comment on why this is one capture, one instant, not two clocks. */
  snapshot: {
    title: string | null;
    company: string | null;
    description: string | null;
  };
  state: ApplicationState;
  interviewSubstage: string | null;
  abandonReason: AbandonReason | null;
  closedReason: ClosedReason | null;
  offeredComp: string | null;
  resumeRenderId: string | null;
  coverRenderId: string | null;
  clickedAt: Date;
  confirmedAt: Date | null;
  archivedAt: Date | null;
}

/** Pure: a row in, the shape the rest of the app reads out. The one
    mapping in this file worth testing with no connection string, the same
    reason record-store.test.ts exists at all. */
export function rowToStoredApplication(row: ApplicationRow): StoredApplication {
  return {
    id: typeof row.id === 'string' ? Number(row.id) : row.id,
    jobId: row.job_id,
    externalUrl: row.external_url,
    snapshot: {
      title: row.snapshot_title,
      company: row.snapshot_company,
      description: row.snapshot_description
    },
    state: row.state,
    interviewSubstage: row.interview_substage,
    abandonReason: row.abandon_reason,
    closedReason: row.closed_reason,
    offeredComp: row.offered_comp,
    resumeRenderId: row.resume_render_id,
    coverRenderId: row.cover_render_id,
    clickedAt: toDate(row.clicked_at),
    confirmedAt: row.confirmed_at === null ? null : toDate(row.confirmed_at),
    archivedAt: row.archived_at === null ? null : toDate(row.archived_at)
  };
}

/* ---- reads ---- */

/** Every application this person holds, most recently clicked first.
    Archived rows are included: this function does not decide what a
    caller shows, only what exists. A board or table view filters
    archived_at itself, the way desk.ts's isArchived() reads. */
export async function listApplications(userId: string): Promise<StoredApplication[]> {
  const { rows } = await db().query<ApplicationRow>(
    'SELECT * FROM desk_application WHERE user_id = $1 ORDER BY clicked_at DESC',
    [userId]
  );
  return rows.map(rowToStoredApplication);
}

/** One application, or null when this person holds none with that id.
    Scoped on user_id as well as id, so an id copied from someone else's
    URL matches nothing rather than reading their application. */
export async function getApplication(userId: string, id: number): Promise<StoredApplication | null> {
  const { rows } = await db().query<ApplicationRow>(
    'SELECT * FROM desk_application WHERE user_id = $1 AND id = $2',
    [userId, id]
  );
  const row = rows[0];
  return row ? rowToStoredApplication(row) : null;
}

/**
 * The person's live application for one posting, or null when none is on the
 * active board. ACTIVE means archived_at IS NULL: a card that self-archived
 * after 14 days unconfirmed (desk.ts's shouldSelfArchive) is not "still
 * tracking this job", so re-engaging with it starts a fresh card rather than
 * reviving an archived one. The most recent wins, in the rare event two exist
 * (desk_application has no unique (user_id, job_id): a click can be recorded
 * more than once). This is the dedup a caller that wants "track this job once"
 * reads before creating, since the table itself will not enforce it.
 */
export async function getActiveApplicationForJob(userId: string, jobId: string): Promise<StoredApplication | null> {
  const { rows } = await db().query<ApplicationRow>(
    'SELECT * FROM desk_application WHERE user_id = $1 AND job_id = $2 AND archived_at IS NULL ORDER BY clicked_at DESC LIMIT 1',
    [userId, jobId]
  );
  const row = rows[0];
  return row ? rowToStoredApplication(row) : null;
}

/* ---- writes ---- */

export interface ClickInput {
  /** Exactly one of these two must be non-null, mirroring db/006_desk.sql's
      `CHECK ((job_id IS NOT NULL) <> (external_url IS NOT NULL))`. */
  jobId: string | null;
  externalUrl: string | null;
  /** The JD snapshot, taken at this same click, never re-fetched later.
      Null means nothing was there to capture, not that capture failed;
      see db/006_desk.sql's own comment on why these are nullable rather
      than empty-string defaults. */
  snapshotTitle: string | null;
  snapshotCompany: string | null;
  snapshotDescription: string | null;
  /** The instant of the click, supplied by the caller rather than read
      from `new Date()` here, the same "pass the clock in" discipline
      data.ts's header states as its own rule 3, extended to the one
      instant that matters for this table. */
  clickedAt: Date;
}

/**
 * Records one outbound click. NOTHING ELSE.
 *
 * THERE IS NO ARGUMENT ABOVE THAT CAN PRODUCE A ROW IN ANY STATE BUT
 * 'clicked'. ClickInput carries no `state` field, on purpose, and the
 * INSERT below names no `state` column either: db/006_desk.sql's own
 * `state text NOT NULL DEFAULT 'clicked'` is what actually sets it. A row
 * leaves 'clicked' only through transitionApplication() below, and that
 * function only ever runs from an endpoint that has already produced a
 * legal STM-0002 move through src/lib/desk.ts's transition(), which is
 * where CLICK IS NOT APPLIED is actually enforced (a PersonConfirmation
 * carrying answer 'applied', built only by recordPersonConfirmation()).
 * This function cannot bypass that gate because it has no vocabulary to
 * even name the state the gate protects.
 *
 * jobId and externalUrl are checked as XOR here, before the database ever
 * sees the call, so a malformed caller gets a readable error naming which
 * two fields disagree rather than a bare constraint-violation from
 * Postgres. db/006_desk.sql's own CHECK enforces the same rule underneath
 * this one, which is the backstop, not the caller-facing message.
 */
export async function createApplicationFromClick(userId: string, input: ClickInput): Promise<StoredApplication> {
  if ((input.jobId !== null) === (input.externalUrl !== null)) {
    throw new Error(
      'desk-store: createApplicationFromClick requires exactly one of jobId or externalUrl ' +
        `(got jobId=${JSON.stringify(input.jobId)}, externalUrl=${JSON.stringify(input.externalUrl)}), ` +
        "matching db/006_desk.sql's XOR CHECK."
    );
  }

  const { rows } = await db().query<ApplicationRow>(
    `INSERT INTO desk_application
       (user_id, job_id, external_url, snapshot_title, snapshot_company, snapshot_description, clicked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      userId,
      input.jobId,
      input.externalUrl,
      input.snapshotTitle,
      input.snapshotCompany,
      input.snapshotDescription,
      input.clickedAt
    ]
  );

  // The apply funnel milestone, best-effort. A click is not an application
  // (F4.2), but it is the moment a person acts on a role, which is what the
  // funnel counts; the milestone table keeps only the first per person.
  await recordEvent(userId, 'apply');

  return rowToStoredApplication(rows[0]);
}

/**
 * Fills an application's snapshot exactly once, where it is still null. The
 * "Add a posting" path creates the card before the posting has been read, so
 * the snapshot is null at click and filled here when the text lands. Never a
 * refresh: a row with a title already keeps it. db/006's "one capture, one
 * instant" wording holds because this is the first capture, arriving late.
 */
export async function fillApplicationSnapshot(
  userId: string,
  id: number,
  snapshot: { title: string | null; company: string | null; description: string | null }
): Promise<boolean> {
  const result = await db().query(
    `UPDATE desk_application
        SET snapshot_title = $3, snapshot_company = $4, snapshot_description = $5
      WHERE user_id = $1 AND id = $2 AND snapshot_title IS NULL`,
    [userId, id, snapshot.title, snapshot.company, snapshot.description]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Records that the person answered a confirm-loop prompt (F4.1's three
 * channels: return-to-tab, next-visit, the weekly digest), without moving
 * the state. Exists as its own function, separate from
 * transitionApplication() below, for the one answer that does not resolve
 * to a state by itself: 'didnt_finish' marks the moment resolved
 * (confirmed_at set, which is what stops desk.ts's shouldSelfArchive()
 * counting toward the 14 days) before the person has necessarily chosen
 * which of the six abandon reasons applies. The 'applied' and
 * 'still_working' answers can, and normally do, resolve in the same
 * request as a state move; transitionApplication()'s own `confirmedAt`
 * field covers that one-statement case so a caller is not forced to run
 * this function first for every answer.
 */
export async function recordConfirmLoopAnswer(
  userId: string,
  id: number,
  confirmedAt: Date
): Promise<StoredApplication | null> {
  const { rows } = await db().query<ApplicationRow>(
    'UPDATE desk_application SET confirmed_at = $3 WHERE user_id = $1 AND id = $2 RETURNING *',
    [userId, id, confirmedAt]
  );
  const row = rows[0];
  return row ? rowToStoredApplication(row) : null;
}

export interface ApplyTransitionInput {
  /** The state to move to. Already decided: see this function's own
      comment for who decided it and how. */
  to: ApplicationState;
  /** Required exactly when `to === 'abandoned'`, matching
      db/006_desk.sql's `CHECK ((state = 'abandoned') = (abandon_reason IS
      NOT NULL))`. Omitted or null clears it, which is only ever correct
      when `to` is not 'abandoned'. */
  abandonReason?: AbandonReason | null;
  /** Required exactly when `to === 'closed'`, same shape as abandonReason. */
  closedReason?: ClosedReason | null;
  /** F4.1's user-defined sub-stage text ("panel round", "take-home due
      Friday"). Omitted leaves the column as it already is; the database
      column itself has no required-iff rule to mirror. */
  interviewSubstage?: string | null;
  /** Set confirmed_at in the same statement, for the common case where
      this write IS the confirm-loop resolution (a person answers "applied"
      or "still working" and the row moves in one shot). Omit to leave
      confirmed_at as it already is, which is the right choice for a move
      that is not itself a confirm-loop answer (interviewing, offer,
      closed all move a row that was already confirmed). */
  confirmedAt?: Date;
}

/**
 * Writes an already-decided STM-0002 transition.
 *
 * TRUSTS THE CALLER, AND SAYS SO PLAINLY. This function does not call
 * src/lib/desk.ts's transition() itself. That decision, whether `to` is a
 * legal edge from the row's current state, whether a move to 'applied'
 * carries a real PersonConfirmation, whether 'abandoned' or 'closed' carry
 * one of their required reasons, is made once, by the endpoint under
 * src/pages/desk/ that calls this function, matching the split
 * record-store.ts's createEntry()/updateEntry() already draw against
 * record.ts's validateEntry() (see that file's own header for the same
 * argument made about a different feature). The endpoint's call site is
 * therefore the review point for every write this function makes: anyone
 * asking "could this codebase silently auto-apply" has exactly one place
 * to look for every caller of this function with `to: 'applied'`, the same
 * way desk.ts's own header names recordPersonConfirmation()'s call sites
 * as that file's review point.
 *
 * Returns null when this person holds no application with that id, the
 * same "not found or not yours, indistinguishably" contract
 * record-store.ts's updateEntry() already uses.
 */
export async function transitionApplication(
  userId: string,
  id: number,
  input: ApplyTransitionInput
): Promise<StoredApplication | null> {
  const { rows } = await db().query<ApplicationRow>(
    `UPDATE desk_application SET
       state = $3,
       abandon_reason = $4,
       closed_reason = $5,
       interview_substage = COALESCE($6, interview_substage),
       confirmed_at = COALESCE($7, confirmed_at)
     WHERE user_id = $1 AND id = $2
     RETURNING *`,
    [
      userId,
      id,
      input.to,
      input.abandonReason ?? null,
      input.closedReason ?? null,
      input.interviewSubstage ?? null,
      input.confirmedAt ?? null
    ]
  );
  const row = rows[0];
  return row ? rowToStoredApplication(row) : null;
}

/**
 * MASTER-SPEC 3.5's posted-vs-offered comparison: "stored against the
 * posting's posted range... No fetched competitor captures this." The
 * posted range itself is never written here; it is read from the sweep by
 * job_id at render time (see db/006_desk.sql's own comment on offered_comp
 * for why), so this function only ever writes the one figure this
 * database actually owns.
 */
export async function setOfferedComp(
  userId: string,
  id: number,
  offeredComp: string | null
): Promise<StoredApplication | null> {
  const { rows } = await db().query<ApplicationRow>(
    'UPDATE desk_application SET offered_comp = $3 WHERE user_id = $1 AND id = $2 RETURNING *',
    [userId, id, offeredComp]
  );
  const row = rows[0];
  return row ? rowToStoredApplication(row) : null;
}

/**
 * F4.1's 14-day self-archive, and its manual counterpart: a person may also
 * archive a card themselves. Sets archived_at; never deletes a row. See
 * desk.ts's isArchived() and shouldSelfArchive() for the predicate this
 * column feeds, and that file's own comment for why a nullable timestamp,
 * not a boolean or a delete, is what makes reversal free.
 */
export async function archiveApplication(
  userId: string,
  id: number,
  archivedAt: Date
): Promise<StoredApplication | null> {
  const { rows } = await db().query<ApplicationRow>(
    'UPDATE desk_application SET archived_at = $3 WHERE user_id = $1 AND id = $2 RETURNING *',
    [userId, id, archivedAt]
  );
  const row = rows[0];
  return row ? rowToStoredApplication(row) : null;
}

/** Reverses an archive, self- or manual. Clears archived_at back to null,
    which is what makes the row indistinguishable from one that was never
    archived at all (see archiveApplication()'s own comment). */
export async function unarchiveApplication(userId: string, id: number): Promise<StoredApplication | null> {
  const { rows } = await db().query<ApplicationRow>(
    'UPDATE desk_application SET archived_at = NULL WHERE user_id = $1 AND id = $2 RETURNING *',
    [userId, id]
  );
  const row = rows[0];
  return row ? rowToStoredApplication(row) : null;
}

/* -------------------------------------------------------------------------
   The confirm-loop nudge sender's reads. Behind the `email_send` flag, driven
   by the scheduled endpoint src/pages/tasks/nudge.ts, not by any page request.
   ------------------------------------------------------------------------- */

/** One still-waiting application, with the account email to reach, for the
    confirm-loop nudge. Title and company are the snapshot taken at click time
    (db/006), which is exactly what the person saw; either can be null on an
    external-URL click that never matched a verified posting. */
export interface NudgeCandidate {
  applicationId: number;
  userId: string;
  email: string;
  title: string | null;
  company: string | null;
  clickedAt: Date;
}

interface NudgeRow {
  id: number;
  user_id: string;
  email: string;
  snapshot_title: string | null;
  snapshot_company: string | null;
  clicked_at: Date | string;
}

/**
 * Every still-waiting card eligible for a confirm-loop nudge, across all users,
 * joined to the account email. THE ONE READ IN THIS FILE NOT SCOPED TO A SINGLE
 * user_id, on purpose: a scheduled sender acts on everyone at once, and the
 * caller (the cron endpoint, gated by CRON_SECRET and the flag) is the only
 * thing that reaches it. Eligible means the loop is unresolved (confirmed_at and
 * archived_at both null), it has not already been nudged (confirm_nudged_at
 * null, db/029), and the click is old enough to be worth a nudge but not so old
 * it is stale: clicked between minAgeDays and maxAgeDays ago. Ordered by user so
 * the caller can batch a person's cards into one email.
 */
export async function listUnconfirmedForNudge(
  opts: { minAgeDays?: number; maxAgeDays?: number; limit?: number } = {}
): Promise<NudgeCandidate[]> {
  const minAgeDays = opts.minAgeDays ?? 3;
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const limit = opts.limit ?? 500;
  const { rows } = await db().query<NudgeRow>(
    `SELECT a.id, a.user_id, u.email,
            a.snapshot_title, a.snapshot_company, a.clicked_at
       FROM desk_application a
       JOIN "user" u ON u.id = a.user_id
      WHERE a.confirmed_at IS NULL
        AND a.archived_at IS NULL
        AND a.confirm_nudged_at IS NULL
        AND a.clicked_at < now() - make_interval(days => $1::int)
        AND a.clicked_at > now() - make_interval(days => $2::int)
      ORDER BY a.user_id, a.clicked_at DESC
      LIMIT $3`,
    [minAgeDays, maxAgeDays, limit]
  );
  return rows.map((row) => ({
    applicationId: row.id,
    userId: row.user_id,
    email: row.email,
    title: row.snapshot_title,
    company: row.snapshot_company,
    clickedAt: toDate(row.clicked_at)
  }));
}

/**
 * Marks a set of applications nudged so they are never nudged again. Called by
 * the sender the moment a person's nudge email is accepted by the mail service,
 * so a card is marked only after its nudge actually went out. The WHERE keeps
 * confirm_nudged_at IS NULL so a concurrent run cannot stamp it twice.
 */
export async function markConfirmNudged(applicationIds: number[], nudgedAt: Date): Promise<void> {
  if (applicationIds.length === 0) return;
  await db().query(
    'UPDATE desk_application SET confirm_nudged_at = $2 WHERE id = ANY($1) AND confirm_nudged_at IS NULL',
    [applicationIds, nudgedAt]
  );
}
