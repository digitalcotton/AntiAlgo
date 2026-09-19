/**
 * generated-render-store.ts: the impure half of drafting-on-apply's
 * persistence, db/012_drafting.sql's generated_render table and nothing
 * else. Same split record-store.ts already draws against record.ts,
 * restated here for the same reason: this file does I/O and decides
 * nothing, including about ownership. Every function below takes a
 * `userId`, and every read scopes its query to that id; none accepts a
 * userId from a request body, because a userId is a viewer fact, resolved
 * server-side from the session, never a form field a caller could type a
 * stranger's id into.
 *
 * PARAMETERISED QUERIES ONLY. No string ever gets concatenated into SQL
 * here; every value a caller supplies travels as a placeholder argument.
 *
 * THE ONLY CALLER IS src/lib/generation-preference-store.ts's
 * triggerBackgroundGeneration() (and the render loop it kicks off, not
 * awaited, once a decision is made). beginDraft() runs at the moment a
 * click decides to draft; completeDraft() runs once, later, when that
 * background render settles; getRenders() is what the draft room
 * (src/pages/desk/draft/[id].astro) reads to show or poll. No file outside
 * this task's own list writes to generated_render.
 *
 * NEVER THROWS FOR "NO ROWS". A missing draft is the ordinary "nothing was
 * ever started for this application" state (getRenders()'s own return
 * shape says so plainly, resume/cover each null), not an error to
 * diagnose, the same posture keychain-store.ts's keyMeta() and
 * getDecryptedKey() already take for a provider nobody connected.
 */
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { recordEvent } from './analytics';

/** db/012_drafting.sql's two kinds, and its statuses (db/026 added 'failed').
    Kept here rather than imported from anywhere else, the same hand-kept
    agreement keychain.ts's PROVIDERS tuple documents for db/007's own CHECK
    constraint: a migration cannot be imported into a module that must stay
    buildable with no connection.

    'failed' is a job draft's honest dead end: a provider that was tried and
    could not deliver (the owner's ruling is that the built-in template never
    stands in for a tried key), or a render that threw. It carries a reason
    and is what the result page offers a retry against; 'pending' is never
    left to mean "gave up". */
export type RenderKind = 'resume' | 'cover';
export type RenderStatus = 'pending' | 'ready' | 'fallback' | 'failed';

/* -------------------------------------------------------------------------
   Row shape and the pure mapper between a row and the shape the rest of the
   app reads.
   ------------------------------------------------------------------------- */

export interface GeneratedRenderRow {
  id: string;
  kind: RenderKind;
  status: RenderStatus;
  /** jsonb: node-postgres hands this back already parsed, null while
      status = 'pending'. Whatever shape src/lib/tailor.ts's ResumeRender or
      CoverRender wrote in is what comes back out; this file has no opinion
      about it beyond "unknown", the same defensive read filters-store.ts's
      own jsonb column takes. */
  payload: unknown;
  provider: string | null;
  model: string | null;
  /** db/026: a plain sentence our own code minted, set only with 'failed'. */
  failure_reason: string | null;
  /** db/026: stamped once by the invocation that claimed the row to render
      it; null until then. node-postgres decodes timestamptz to a Date, and a
      test may hand in the ISO string; toDate() below takes either. */
  started_at: Date | string | null;
  updated_at: Date | string;
  /** db/203: the tokens the live provider billed for this render, and how long
      the render took. All null unless a generative render was measured and
      settled: a pending row, a deterministic (no-key) 'fallback', and any row
      from before db/203 all read null, which is the honest "not measured", never
      a real zero. See completeDraft() below for where these are written. */
  input_tokens: number | null;
  output_tokens: number | null;
  render_ms: number | null;
}

/** What the rest of the app reads: one row, mapped one-to-one from
    GeneratedRenderRow. The two dates exist for one reader, jobDraftState()
    below, which needs them to tell a render still in flight from one the
    platform abandoned. */
export interface RenderRow {
  readonly id: string;
  readonly kind: RenderKind;
  readonly status: RenderStatus;
  readonly payload: unknown;
  readonly provider: string | null;
  readonly model: string | null;
  readonly failureReason: string | null;
  readonly startedAt: Date | null;
  readonly updatedAt: Date;
  /** db/203: measured token usage and wall time, null where not measured (a
      pending row, a deterministic fallback, a pre-db/203 row). A later feature
      reads these to show a person what a draft cost on their own key. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly renderMs: number | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Pure: a row in, the shape the rest of the app reads out. Exported so
    generated-render-store.test.ts can pin this mapping with no connection,
    the same seam desk-store.test.ts already tests for
    rowToStoredApplication() and record-store.test.ts tests for the
    Profile Record's own row mappers. */
export function rowToRenderRow(row: GeneratedRenderRow): RenderRow {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    payload: row.payload,
    provider: row.provider,
    model: row.model,
    failureReason: row.failure_reason ?? null,
    startedAt: row.started_at == null ? null : toDate(row.started_at),
    updatedAt: toDate(row.updated_at),
    inputTokens: row.input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    renderMs: row.render_ms ?? null
  };
}

/* -------------------------------------------------------------------------
   The job draft's state, as one pure function. Two surfaces answer "what is
   this draft doing" (the status endpoint and the draft room) and they must
   answer identically; both call this.
   ------------------------------------------------------------------------- */

export type JobDraftState = 'none' | 'pending' | 'ready' | 'failed';

/** Slack past the platform ceiling before a claimed, still-pending row is
    declared abandoned: the ceiling is the longest an invocation can possibly
    still be working on it, plus a margin for the final writes. */
export const STALE_CLAIMED_SLACK_MS = 30_000;

/** How long an unclaimed pending row may wait for an invocation to claim it.
    The dispatch is a sub-second round trip and its failure falls back to an
    in-process render that claims at once, so a row nobody has claimed after
    this long has been dropped. */
export const STALE_UNCLAIMED_MS = 90_000;

/** One document is its own JobDraftState. */
export type DocumentState = JobDraftState;

/**
 * The state of ONE document's row. Absent is 'none'. A row marked 'failed' is
 * 'failed'. A 'pending' row is 'pending' while an invocation could still be
 * working on it, and 'failed' once it has been pending longer than any
 * invocation could live (`ceilingMs`, the platform's maxDuration, plus slack)
 * or, never even claimed, longer than a dispatch could take. A settled row
 * ('ready' or the no-key 'fallback') is 'ready'.
 */
export function documentState(row: RenderRow | null, nowMs: number, ceilingMs: number): DocumentState {
  if (row === null) return 'none';
  if (row.status === 'failed') return 'failed';
  if (row.status === 'pending') {
    const age = nowMs - row.updatedAt.getTime();
    const limit = row.startedAt ? ceilingMs + STALE_CLAIMED_SLACK_MS : STALE_UNCLAIMED_MS;
    return age > limit ? 'failed' : 'pending';
  }
  return 'ready';
}

/**
 * The state of one posting's draft PAIR, derived from the two documents so it
 * can never disagree with the per-document view the room now shows. Both 'none'
 * is 'none'. Either 'failed' is 'failed'. Either still 'pending', or exactly one
 * document present (the half-written moment between beginJobDraft()'s two
 * INSERTs), is 'pending'. Only both documents settled is 'ready'.
 */
export function jobDraftState(
  rows: { readonly resume: RenderRow | null; readonly cover: RenderRow | null },
  nowMs: number,
  ceilingMs: number
): JobDraftState {
  const states = [documentState(rows.resume, nowMs, ceilingMs), documentState(rows.cover, nowMs, ceilingMs)];
  if (states.every((s) => s === 'none')) return 'none';
  if (states.some((s) => s === 'failed')) return 'failed';
  if (states.some((s) => s === 'pending') || states.some((s) => s === 'none')) return 'pending';
  return 'ready';
}

/* -------------------------------------------------------------------------
   Writes.
   ------------------------------------------------------------------------- */

/**
 * Starts a draft: upserts one 'pending' row per kind (resume, cover) for
 * this application, each with a fresh id, then stamps
 * desk_application.resume_render_id / cover_render_id with those same ids
 * so a reader who already has the application row can find its drafts
 * without a second table in between.
 *
 * A FRESH ID EVERY CALL, EVEN ON CONFLICT. If this application already had
 * a draft (a retry, in practice; nothing in this codebase's own call sites
 * triggers a second beginDraft() for the same application today), the old
 * row's id, payload, provider and model are all replaced, not appended to:
 * db/012_drafting.sql's UNIQUE (application_id, kind) means there is only
 * ever one row per kind per application, and the stamp on desk_application
 * below is what keeps that row's new id the one the rest of the app finds,
 * rather than a stale id left over from the row this upsert just
 * overwrote.
 *
 * THE STAMP IS SCOPED TO userId, THE SAME OWNERSHIP DISCIPLINE EVERY WRITE
 * IN desk-store.ts USES. A caller that somehow reached this function with
 * an applicationId it does not own gets a no-op UPDATE (0 rows), not a
 * write into a stranger's application; the two generated_render rows would
 * still exist, orphaned from any desk_application.*_render_id column, which
 * is the same "gone versus never there" shape the rest of this codebase's
 * stores already leave for a caller to notice rather than throwing on.
 * triggerBackgroundGeneration() is this function's only caller, and it is
 * only ever invoked with the applicationId of an application it just
 * created for that same userId, so this path is not expected to run in
 * practice; it is defended anyway because "trust the caller" is not this
 * file's job (see this file's own header).
 */
export async function beginDraft(
  userId: string,
  applicationId: number
): Promise<{ resumeId: string; coverId: string }> {
  const resumeId = randomUUID();
  const coverId = randomUUID();

  for (const [id, kind] of [
    [resumeId, 'resume'],
    [coverId, 'cover']
  ] as const) {
    await db().query(
      `INSERT INTO generated_render (id, user_id, application_id, kind, status, payload, provider, model)
       VALUES ($1, $2, $3, $4, 'pending', NULL, NULL, NULL)
       ON CONFLICT (application_id, kind) DO UPDATE SET
         id = EXCLUDED.id,
         user_id = EXCLUDED.user_id,
         status = 'pending',
         payload = NULL,
         provider = NULL,
         model = NULL`,
      [id, userId, applicationId, kind]
    );
  }

  await db().query(
    'UPDATE desk_application SET resume_render_id = $1, cover_render_id = $2 WHERE id = $3 AND user_id = $4',
    [resumeId, coverId, applicationId, userId]
  );

  // The first-draft funnel milestone, best-effort. Kept only once per person.
  await recordEvent(userId, 'first_draft');

  return { resumeId, coverId };
}

export interface CompleteDraftFields {
  readonly status: 'ready' | 'fallback';
  /** JSON.stringify()'d below, the same `$n::jsonb` cast filters-store.ts's
      saveFilterState() already uses for its own jsonb column, so a plain
      JS object is the right thing to pass in here. */
  readonly payload: unknown;
  readonly provider: string | null;
  readonly model: string | null;
  /** db/203: the tokens a live provider billed for this render, read from the
      generative provider's own usage() accumulator (generation-providers.ts).
      OPTIONAL and honest: omitted for a deterministic (no-key) 'fallback', which
      made the document with no provider call, so its input_tokens/output_tokens
      stay NULL (not measured) rather than 0 (measured none). Present with a
      generative render, where 0 would only appear if the wire genuinely returned
      no usage field. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** db/203: wall-clock milliseconds this render took, computed at the call site
      only when a start time is known. Omitted otherwise, leaving render_ms NULL. */
  readonly renderMs?: number;
}

/**
 * Finishes one draft: the one write completeDraft() ever makes, by id, no
 * userId or applicationId needed because the id itself
 * (crypto.randomUUID(), minted by beginDraft() above) is already
 * unguessable and already scoped to the row it names. A caller with the
 * wrong id (one that does not exist any more, an application that was
 * deleted between beginDraft() and this call landing) gets a silent no-op:
 * see this file's own header, never throws for "no rows".
 */
export async function completeDraft(id: string, fields: CompleteDraftFields): Promise<void> {
  await db().query(
    `UPDATE generated_render SET
       status = $2,
       payload = $3::jsonb,
       provider = $4,
       model = $5,
       input_tokens = $6,
       output_tokens = $7,
       render_ms = $8
     WHERE id = $1`,
    [
      id,
      fields.status,
      JSON.stringify(fields.payload),
      fields.provider,
      fields.model,
      // Undefined usage writes NULL (not measured), not 0. A generative render
      // passes usage even when it is {0, 0}, which db/203 reads as "measured
      // none"; only a deterministic render omits it and leaves the column NULL.
      fields.usage?.inputTokens ?? null,
      fields.usage?.outputTokens ?? null,
      fields.renderMs ?? null
    ]
  );
}

/**
 * Ends one draft as 'failed' with the reason, clearing any payload. Only a
 * row still 'pending' is touched: a draft that already settled keeps its
 * result, so a late failure signal from a superseded attempt cannot undo a
 * finished document. The reason is a sentence our own code minted, never a
 * provider body (see generation-preference-store.ts), so it can never carry
 * a key; the column's own CHECK caps it at 1000 characters and this slices
 * to stay inside it.
 */
export async function failDraft(id: string, reason: string): Promise<void> {
  await db().query(
    `UPDATE generated_render SET
       status = 'failed',
       failure_reason = $2,
       payload = NULL
     WHERE id = $1 AND status = 'pending'`,
    [id, reason.slice(0, 1000)]
  );
}

/**
 * Claims one job-draft row for rendering: stamps started_at on a row that is
 * still pending and has not been claimed, scoped to the owner, posting and
 * kind the caller was told. True when this call made the claim; false when
 * the row was already claimed, already settled, or not what the caller
 * described. The run endpoint's replay guard: a second request for the same
 * row finds nothing to claim and renders nothing.
 */
export async function claimJobRender(id: string, userId: string, jobId: string, kind: RenderKind): Promise<boolean> {
  const result = await db().query(
    `UPDATE generated_render SET started_at = now()
     WHERE id = $1 AND user_id = $2 AND job_id = $3 AND kind = $4
       AND status = 'pending' AND started_at IS NULL`,
    [id, userId, jobId, kind]
  );
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------
   Reads.
   ------------------------------------------------------------------------- */

const RENDER_COLUMNS =
  'id, kind, status, payload, provider, model, failure_reason, started_at, updated_at, input_tokens, output_tokens, render_ms';

/**
 * Both drafts for one application, scoped to userId so an id copied from
 * someone else's draft room matches nothing rather than reading their
 * render. null for a kind that was never started (no beginDraft() call
 * yet) or that belongs to a different application/user than the one asked
 * for; both null is the honest "nothing was ever drafted here" state the
 * draft room's own empty state reads.
 */
export async function getRenders(
  userId: string,
  applicationId: number
): Promise<{ resume: RenderRow | null; cover: RenderRow | null }> {
  const { rows } = await db().query<GeneratedRenderRow>(
    `SELECT ${RENDER_COLUMNS} FROM generated_render WHERE user_id = $1 AND application_id = $2`,
    [userId, applicationId]
  );
  const byKind = new Map(rows.map((row) => [row.kind, rowToRenderRow(row)] as const));
  return { resume: byKind.get('resume') ?? null, cover: byKind.get('cover') ?? null };
}

/* -------------------------------------------------------------------------
   Job drafts: the one-click button's rows (db/022_job_draft.sql). Same table,
   keyed by the posting's slug instead of an application, application_id null.
   No desk_application stamp, because a job draft has no application: it is
   tied to the posting, not to anything the person did, which is the whole
   point of a draft that is not an apply.
   ------------------------------------------------------------------------- */

/**
 * Appends one new version of a (user, job, kind) draft (db/202): reads the
 * current max version, retires whatever row was current, then inserts the fresh
 * 'pending' row as version N+1 and current. Order matters: the retire runs
 * before the insert so the current-only partial unique
 * (generated_render_job_current_uidx) never sees two current rows for the same
 * kind at once. A re-draft therefore keeps the prior version rather than
 * deleting it, which is what makes the room's version list and restore possible.
 * The note (db/027) rides the cover row only, the letter's opening anchor.
 */
async function appendJobRenderVersion(
  userId: string,
  jobId: string,
  kind: RenderKind,
  id: string,
  reason: string | null
): Promise<void> {
  const { rows } = await db().query<{ next: string }>(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM generated_render WHERE user_id = $1 AND job_id = $2 AND kind = $3',
    [userId, jobId, kind]
  );
  const nextVersion = Number(rows[0]?.next ?? '1');
  await db().query(
    'UPDATE generated_render SET is_current = false WHERE user_id = $1 AND job_id = $2 AND kind = $3 AND is_current',
    [userId, jobId, kind]
  );
  await db().query(
    `INSERT INTO generated_render (id, user_id, application_id, job_id, kind, status, payload, provider, model, reason, version, is_current)
     VALUES ($1, $2, NULL, $3, $4, 'pending', NULL, NULL, NULL, $5, $6, true)`,
    [id, userId, jobId, kind, kind === 'cover' ? reason : null, nextVersion]
  );
}

/**
 * Starts a job draft: a new current version of BOTH kinds for this (user, job),
 * each with a fresh id, application_id null and job_id set to the posting's slug.
 * Unlike before db/202, a prior draft is NOT deleted: it becomes an earlier
 * version the room can list and restore. Scoped to userId like every write here.
 */
export async function beginJobDraft(
  userId: string,
  jobId: string,
  reason: string | null = null
): Promise<{ resumeId: string; coverId: string }> {
  const resumeId = randomUUID();
  const coverId = randomUUID();

  await appendJobRenderVersion(userId, jobId, 'resume', resumeId, reason);
  await appendJobRenderVersion(userId, jobId, 'cover', coverId, reason);

  // The first-draft funnel milestone, best-effort. Kept only once per person.
  await recordEvent(userId, 'first_draft');

  return { resumeId, coverId };
}

/**
 * Restarts ONE document of a job draft as a new version, leaving the other's
 * current version alone. The per-document retry the room's "Draft the cover
 * letter again" button drives, and the shape steered regeneration reuses. A
 * cover retry carries the note forward: the caller's `reason` when the form
 * still holds it, else the value the current cover version keeps (db/027), so
 * the person's words are never lost to a retry.
 */
export async function beginJobDraftDocument(
  userId: string,
  jobId: string,
  kind: RenderKind,
  reason: string | null = null
): Promise<{ id: string; reason: string | null }> {
  const id = randomUUID();
  let carried = reason;
  if (carried === null && kind === 'cover') {
    const { rows } = await db().query<{ reason: string | null }>(
      'SELECT reason FROM generated_render WHERE user_id = $1 AND job_id = $2 AND kind = $3 AND is_current',
      [userId, jobId, kind]
    );
    carried = rows[0]?.reason ?? null;
  }
  const stored = kind === 'cover' ? carried : null;
  await appendJobRenderVersion(userId, jobId, kind, id, stored);
  return { id, reason: stored };
}

/**
 * Both drafts for one posting, scoped to userId. null for a kind never
 * started; both null is the honest "nothing was ever drafted for this
 * posting" state the job draft room's own empty state reads, the same shape
 * getRenders() returns for an application.
 */
export async function getJobRenders(
  userId: string,
  jobId: string
): Promise<{ resume: RenderRow | null; cover: RenderRow | null }> {
  const { rows } = await db().query<GeneratedRenderRow>(
    // is_current (db/202): the room reads the CURRENT version of each kind. The
    // rest of this function is unchanged, so the one-row-per-kind byKind Map and
    // every downstream reader (status, PDF/DOCX) keep working exactly as before.
    `SELECT ${RENDER_COLUMNS} FROM generated_render WHERE user_id = $1 AND job_id = $2 AND is_current`,
    [userId, jobId]
  );
  const byKind = new Map(rows.map((row) => [row.kind, rowToRenderRow(row)] as const));
  return { resume: byKind.get('resume') ?? null, cover: byKind.get('cover') ?? null };
}

/** The reason written onto a draft the clock has given up on. Kept here, beside
    the write, and equal to the sentence the room already defaults to for a
    stale row, so the stored reason and the shown reason are the same words. */
export const ABANDONED_REASON = 'it did not finish in time';

/**
 * getJobRenders, plus a write for any row the clock has already declared dead.
 * documentState() infers 'failed' for a pending row past the invocation ceiling,
 * but only in memory: the DB row stays 'pending' forever, so the throttle keeps
 * counting it and a later reader re-derives the same stale state. Here, a
 * pending row that reads as 'failed' is settled to 'failed' with ABANDONED_REASON
 * (failDraft touches only status='pending', so this is idempotent and can never
 * clobber a document that finished in the meantime), and the returned row already
 * reflects that, so every reader that calls documentState() on it computes the
 * same thing it did before. Used by the room, the status endpoint and the POST,
 * so all three agree with what is actually in the database. Never throws.
 */
export async function getJobRendersReconciled(
  userId: string,
  jobId: string,
  nowMs: number,
  ceilingMs: number
): Promise<{ resume: RenderRow | null; cover: RenderRow | null }> {
  const { resume, cover } = await getJobRenders(userId, jobId);
  const settle = async (row: RenderRow | null): Promise<RenderRow | null> => {
    if (!row || row.status !== 'pending') return row;
    if (documentState(row, nowMs, ceilingMs) !== 'failed') return row;
    try {
      await failDraft(row.id, ABANDONED_REASON);
    } catch (error) {
      console.error(`generated-render-store: could not settle abandoned ${row.kind} render ${row.id} for job ${jobId}.`, error);
      return row;
    }
    console.error(
      `generated-render-store: settled abandoned ${row.kind} render ${row.id} for job ${jobId} as failed (pending ${nowMs - row.updatedAt.getTime()}ms, claimed=${row.startedAt !== null}).`
    );
    return { ...row, status: 'failed', failureReason: ABANDONED_REASON, payload: null };
  };
  return { resume: await settle(resume), cover: await settle(cover) };
}

/**
 * How many job-draft render rows this person has started in the last `windowMs`.
 * A per-user rate signal for the draft endpoint: each draft writes one or two of
 * these rows, each carrying up to two model calls on the person's own key, so
 * counting recent rows bounds how fast a session can spend that key's credit and
 * the platform's function time. Scoped to userId and to job drafts (job_id set),
 * like every read here.
 */
export async function countRecentJobRenders(userId: string, windowMs: number): Promise<number> {
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  const { rows } = await db().query<{ n: string }>(
    // Counts rows STARTED in the window (created_at), which versioning does not
    // change: each draft still inserts one or two rows, and older versions carry
    // an older created_at that falls outside the window. So this still bounds how
    // fast a session spends the key's credit, the reason it exists.
    'SELECT count(*)::text AS n FROM generated_render WHERE user_id = $1 AND job_id IS NOT NULL AND created_at >= $2',
    [userId, sinceIso]
  );
  return Number(rows[0]?.n ?? '0');
}

/* -------------------------------------------------------------------------
   Draft versions (db/202): listing a posting's earlier drafts and restoring
   one as current. The room's "Earlier drafts are kept" panel reads these.
   ------------------------------------------------------------------------- */

/** One draft version's metadata, without its payload (kept light for a list). */
export interface RenderVersionRow {
  readonly id: string;
  readonly kind: RenderKind;
  readonly version: number;
  readonly status: RenderStatus;
  readonly provider: string | null;
  readonly model: string | null;
  readonly isCurrent: boolean;
  readonly createdAt: Date;
  /** db/203: usage carried on the version list too, so the room can show what an
      earlier draft cost without pulling its full payload. Null where not measured. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly renderMs: number | null;
}

interface RenderVersionDbRow {
  id: string;
  kind: RenderKind;
  version: number;
  status: RenderStatus;
  provider: string | null;
  model: string | null;
  is_current: boolean;
  created_at: Date | string;
  input_tokens: number | null;
  output_tokens: number | null;
  render_ms: number | null;
}

/**
 * Every version of one kind for one posting, newest first. Metadata only, so
 * the room can list "Draft 2, current" and "Draft 1, first pass" without pulling
 * every stored payload. Scoped to userId.
 */
export async function listJobRenderVersions(
  userId: string,
  jobId: string,
  kind: RenderKind
): Promise<RenderVersionRow[]> {
  const { rows } = await db().query<RenderVersionDbRow>(
    `SELECT id, kind, version, status, provider, model, is_current, created_at, input_tokens, output_tokens, render_ms
       FROM generated_render
      WHERE user_id = $1 AND job_id = $2 AND kind = $3
      ORDER BY version DESC`,
    [userId, jobId, kind]
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    version: row.version,
    status: row.status,
    provider: row.provider,
    model: row.model,
    isCurrent: row.is_current,
    createdAt: toDate(row.created_at),
    inputTokens: row.input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    renderMs: row.render_ms ?? null
  }));
}

/** One specific version's full render row, scoped to userId. Null if the id is
    not this person's draft of this posting and kind. */
export async function getJobRenderVersion(
  userId: string,
  jobId: string,
  kind: RenderKind,
  id: string
): Promise<RenderRow | null> {
  const { rows } = await db().query<GeneratedRenderRow>(
    `SELECT ${RENDER_COLUMNS} FROM generated_render WHERE id = $1 AND user_id = $2 AND job_id = $3 AND kind = $4`,
    [id, userId, jobId, kind]
  );
  return rows[0] ? rowToRenderRow(rows[0]) : null;
}

/**
 * Makes an earlier version current, so the room and the download path read it.
 * Only a version that actually holds a document ('ready' or 'fallback') can be
 * restored: a pending or failed row has nothing to make current. Retire-then-set
 * order keeps the current-only partial unique satisfied throughout. Returns
 * false and changes nothing when the id is not eligible or not this person's.
 */
export async function restoreJobRenderVersion(
  userId: string,
  jobId: string,
  kind: RenderKind,
  id: string
): Promise<boolean> {
  const eligible = await db().query(
    `SELECT 1 FROM generated_render
      WHERE id = $1 AND user_id = $2 AND job_id = $3 AND kind = $4 AND status IN ('ready', 'fallback')`,
    [id, userId, jobId, kind]
  );
  if (eligible.rowCount === 0) return false;
  await db().query(
    'UPDATE generated_render SET is_current = false WHERE user_id = $1 AND job_id = $2 AND kind = $3 AND is_current',
    [userId, jobId, kind]
  );
  await db().query(
    'UPDATE generated_render SET is_current = true WHERE id = $1 AND user_id = $2 AND job_id = $3 AND kind = $4',
    [id, userId, jobId, kind]
  );
  return true;
}

/* -------------------------------------------------------------------------
   The person's own drafting spend (db/203): every render that billed tokens,
   summed per provider and model so the settings page can price each group by
   its own rate. Scoped to userId; only rows that actually measured usage count.
   ------------------------------------------------------------------------- */

/** One (provider, model) group's summed token spend across a person's drafts. */
export interface UserUsageGroup {
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly drafts: number;
}

/**
 * A person's drafting token spend, grouped by (provider, model). Only renders
 * that measured usage (input_tokens not null) are counted: a deterministic
 * no-key draft billed nothing and is not in the sum. Grouping keeps each
 * provider and model together so the caller prices each by its own rate, since
 * cost lives in generation-cost.ts, never in SQL. Scoped to userId.
 */
export async function sumUserRenderUsage(userId: string): Promise<UserUsageGroup[]> {
  const { rows } = await db().query<{
    provider: string | null;
    model: string | null;
    input_tokens: string;
    output_tokens: string;
    drafts: string;
  }>(
    `SELECT provider, model,
            COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
            COUNT(*)::text AS drafts
       FROM generated_render
      WHERE user_id = $1 AND input_tokens IS NOT NULL
      GROUP BY provider, model`,
    [userId]
  );
  return rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    drafts: Number(row.drafts)
  }));
}
