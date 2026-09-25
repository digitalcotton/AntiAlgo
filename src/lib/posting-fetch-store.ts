/**
 * posting-fetch-store.ts: the "Add a posting" request table (db/033).
 *
 * Same discipline as desk-store.ts: parameterised queries only, every read and
 * write scoped on user_id except the two the machine routes make, which are
 * scoped on the row's own random id and answer with id and url alone. The pure
 * halves (row mapping, url_key, the display clock) sit at the top so they can
 * be tested with no connection string.
 *
 * THE LIFECYCLE. pending (waiting for the mini) -> claimed (the mini is on it)
 * -> ready (text came back) | unreadable (the page could not be read). A person
 * can paste text at any point, which settles the row as pasted, and can retry
 * an unreadable row, which puts it back to pending. A claim older than ten
 * minutes is claimable again: a mini that died mid-read gets a second chance
 * without a person doing anything.
 */
import { randomUUID } from 'node:crypto';
import { db } from './db';

export type FetchStatus = 'pending' | 'claimed' | 'ready' | 'unreadable' | 'pasted';
export type FetchOrigin = 'machine' | 'pasted';
export const SOURCE_KINDS = ['greenhouse', 'ashby', 'lever', 'workable', 'rippling', 'workday', 'jsonld', 'page', 'browser', 'pasted'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const FAILURE_CODES = ['refused_url', 'http_error', 'timeout', 'too_large', 'not_html', 'no_content', 'fetch_error'] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** The board learning pass's verdicts, as the mini's learn_board() names them. */
export const BOARD_VERDICTS = ['added', 'known', 'no-board', 'no-adapter', 'empty', 'off'] as const;
export type BoardVerdict = (typeof BOARD_VERDICTS)[number];

/** What the mini reported about the board the posting lives on (db/036). */
export interface BoardNote {
  verdict: BoardVerdict;
  /** The board's name as the crawl list will carry it, when there is a board. */
  name: string | null;
  /** The board system, when there is a board. */
  ats: string | null;
  /** Postings the first pull saw, for an added board; null otherwise. */
  postingsSeen: number | null;
}

/** The machine's notes on one read, beyond the text (db/036). Every key is
    optional and allowlisted; the page prints only what it knows how to. */
export interface MachineNotes {
  board?: BoardNote;
  /** Which machine did the reading. The site reads most postings itself now
      (posting-read.ts) and hands the rest to the mini, and the two are
      otherwise indistinguishable on the row: `origin` says 'machine' for both,
      because both are a machine rather than a person typing, and `source_kind`
      says how the page was read rather than by whom. Without this the question
      "is the fast path actually working in production" has no answer short of
      reading logs, which is the state this whole feature was already in. */
  reader?: Reader;
}

export const READERS = ['site', 'mini'] as const;
export type Reader = (typeof READERS)[number];

export const DESCRIPTION_MAX_CHARS = 120_000;
export const SNAPSHOT_MAX_CHARS = 40_000;
export const NAME_MAX_CHARS = 500;
/** A claim this old is a mini that never came back; the row is claimable again. */
export const CLAIM_STALE_MS = 10 * 60 * 1000;
/** A pending row this old reads as "still queued" on the card. */
export const QUEUED_NOTICE_MS = 10 * 60 * 1000;
/** A claimed row this old reads as "taking longer than usual". */
export const SLOW_NOTICE_MS = 5 * 60 * 1000;

export interface PostingFetchRow {
  id: string;
  user_id: string;
  application_id: string | number;
  url: string;
  url_key: string;
  status: FetchStatus;
  origin: FetchOrigin | null;
  source_kind: SourceKind | null;
  title: string | null;
  company: string | null;
  description_html: string | null;
  final_url: string | null;
  http_status: number | null;
  failure_code: FailureCode | null;
  fetched_at: Date | string | null;
  claimed_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  machine_notes?: unknown;
}

export interface StoredPostingFetch {
  id: string;
  applicationId: number;
  url: string;
  urlKey: string;
  status: FetchStatus;
  origin: FetchOrigin | null;
  sourceKind: SourceKind | null;
  title: string | null;
  company: string | null;
  descriptionHtml: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  failureCode: FailureCode | null;
  fetchedAt: Date | null;
  claimedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  machineNotes: MachineNotes;
}

/**
 * Pure: the notes as stored, re-read through the same allowlist that wrote
 * them. Anything the column holds that this file does not know is dropped on
 * the way out, so a row written by a later edition never prints through an
 * older page.
 */
export function machineNotesFrom(value: unknown): MachineNotes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const notes: MachineNotes = {};
  const board = boardNoteFrom(raw.board);
  if (board) notes.board = board;
  if (typeof raw.reader === 'string' && (READERS as readonly string[]).includes(raw.reader)) {
    notes.reader = raw.reader as Reader;
  }
  return notes;
}

/** Pure: one board note from untrusted JSON, or null when it is not one. The
    verdict must be on the list; names are trimmed and capped; the count must
    be a non-negative integer. */
export function boardNoteFrom(value: unknown): BoardNote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.verdict !== 'string' || !(BOARD_VERDICTS as readonly string[]).includes(raw.verdict)) return null;
  const text = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const trimmed = v.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_CHARS);
    return trimmed || null;
  };
  const seen = raw.postingsSeen ?? raw.postings_seen;
  return {
    verdict: raw.verdict as BoardVerdict,
    name: text(raw.name),
    ats: text(raw.ats)?.toLowerCase() ?? null,
    postingsSeen: Number.isInteger(seen) && (seen as number) >= 0 ? (seen as number) : null
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Pure: a row in, the shape the app reads out. */
export function rowToStoredPostingFetch(row: PostingFetchRow): StoredPostingFetch {
  return {
    id: row.id,
    applicationId: typeof row.application_id === 'string' ? Number(row.application_id) : row.application_id,
    url: row.url,
    urlKey: row.url_key,
    status: row.status,
    origin: row.origin,
    sourceKind: row.source_kind,
    title: row.title,
    company: row.company,
    descriptionHtml: row.description_html,
    finalUrl: row.final_url,
    httpStatus: row.http_status,
    failureCode: row.failure_code,
    fetchedAt: row.fetched_at === null ? null : toDate(row.fetched_at),
    claimedAt: row.claimed_at === null ? null : toDate(row.claimed_at),
    completedAt: row.completed_at === null ? null : toDate(row.completed_at),
    createdAt: toDate(row.created_at),
    machineNotes: machineNotesFrom(row.machine_notes)
  };
}

/** Query parameters that name a campaign, never a posting. gh_jid is kept: it
    is the Greenhouse job id on an embedded board and identifies the posting. */
const TRACKING_PARAMS = new Set(['ref', 'source', 'src', 'gh_src', 'lever-source', 'fbclid', 'gclid', 'mc_cid', 'mc_eid']);

/**
 * Pure: the same posting pasted twice, with a fragment or a campaign tag on one
 * of them, is one posting. Host lowercased, fragment dropped, utm_* and the
 * named campaign params removed, remaining params sorted, trailing slash kept
 * as pasted (a slash can be significant on some boards). Returns the input
 * unchanged when it does not parse; the endpoint has already refused those.
 */
export function normaliseUrlKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  const kept: Array<[string, string]> = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  parsed.search = '';
  for (const [key, value] of kept) parsed.searchParams.append(key, value);
  return parsed.toString();
}

export type FetchDisplayState = 'reading' | 'queued' | 'slow' | 'ready' | 'unreadable' | 'pasted';

/** Pure: what the card says. Computed from the row's clocks, never stored. */
export function fetchDisplayState(row: StoredPostingFetch, nowMs: number): FetchDisplayState {
  if (row.status === 'ready') return 'ready';
  if (row.status === 'pasted') return 'pasted';
  if (row.status === 'unreadable') return 'unreadable';
  if (row.status === 'claimed') {
    const since = row.claimedAt ? row.claimedAt.getTime() : row.createdAt.getTime();
    return nowMs - since > SLOW_NOTICE_MS ? 'slow' : 'reading';
  }
  return nowMs - row.createdAt.getTime() > QUEUED_NOTICE_MS ? 'queued' : 'reading';
}

/* ---- reads, owner scoped ---- */

export async function listPostingFetches(userId: string): Promise<StoredPostingFetch[]> {
  const { rows } = await db().query<PostingFetchRow>(
    'SELECT * FROM desk_posting_fetch WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows.map(rowToStoredPostingFetch);
}

export async function getPostingFetchByApplication(userId: string, applicationId: number): Promise<StoredPostingFetch | null> {
  const { rows } = await db().query<PostingFetchRow>(
    'SELECT * FROM desk_posting_fetch WHERE user_id = $1 AND application_id = $2',
    [userId, applicationId]
  );
  return rows[0] ? rowToStoredPostingFetch(rows[0]) : null;
}

/** The person's in-flight or settled request for one url_key on an active card,
    newest first. The dedup the add intent reads before creating. */
export async function getPostingFetchByUrlKey(userId: string, urlKey: string): Promise<StoredPostingFetch | null> {
  const { rows } = await db().query<PostingFetchRow>(
    `SELECT f.* FROM desk_posting_fetch f
       JOIN desk_application a ON a.id = f.application_id
      WHERE f.user_id = $1 AND f.url_key = $2 AND a.archived_at IS NULL
      ORDER BY f.created_at DESC LIMIT 1`,
    [userId, urlKey]
  );
  return rows[0] ? rowToStoredPostingFetch(rows[0]) : null;
}

export async function countRecentPostingFetches(userId: string, windowMs: number): Promise<number> {
  const { rows } = await db().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM desk_posting_fetch WHERE user_id = $1 AND created_at > now() - ($2::bigint * interval '1 millisecond')`,
    [userId, windowMs]
  );
  return rows[0]?.n ?? 0;
}

/* ---- writes, owner scoped ---- */

export async function createPostingFetch(userId: string, applicationId: number, url: string): Promise<StoredPostingFetch> {
  const { rows } = await db().query<PostingFetchRow>(
    `INSERT INTO desk_posting_fetch (id, user_id, application_id, url, url_key)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [randomUUID(), userId, applicationId, url, normaliseUrlKey(url)]
  );
  return rowToStoredPostingFetch(rows[0]);
}

/** A person's own text, which wins over any machine read, landed or not. */
export async function pastePostingFetch(
  userId: string,
  applicationId: number,
  input: { title: string | null; company: string; descriptionHtml: string }
): Promise<StoredPostingFetch | null> {
  const { rows } = await db().query<PostingFetchRow>(
    `UPDATE desk_posting_fetch
        SET status = 'pasted', origin = 'pasted', source_kind = 'pasted',
            title = $3, company = $4, description_html = $5,
            failure_code = NULL, completed_at = now()
      WHERE user_id = $1 AND application_id = $2
      RETURNING *`,
    [userId, applicationId, input.title, input.company, input.descriptionHtml.slice(0, DESCRIPTION_MAX_CHARS)]
  );
  return rows[0] ? rowToStoredPostingFetch(rows[0]) : null;
}

/** An unreadable or stale-claimed row goes back to the queue. */
export async function resetPostingFetch(userId: string, applicationId: number): Promise<StoredPostingFetch | null> {
  const { rows } = await db().query<PostingFetchRow>(
    `UPDATE desk_posting_fetch
        SET status = 'pending', origin = NULL, source_kind = NULL, title = NULL, company = NULL,
            description_html = NULL, final_url = NULL, http_status = NULL, failure_code = NULL,
            fetched_at = NULL, claimed_at = NULL, completed_at = NULL, machine_notes = NULL
      WHERE user_id = $1 AND application_id = $2
        AND (status = 'unreadable' OR (status = 'claimed' AND claimed_at < now() - ($3::bigint * interval '1 millisecond')))
      RETURNING *`,
    [userId, applicationId, CLAIM_STALE_MS]
  );
  return rows[0] ? rowToStoredPostingFetch(rows[0]) : null;
}

/** The person names the role or company the page did not; settled rows only. */
export async function renamePostingFetch(
  userId: string,
  applicationId: number,
  input: { title: string | null; company: string | null }
): Promise<StoredPostingFetch | null> {
  const { rows } = await db().query<PostingFetchRow>(
    `UPDATE desk_posting_fetch
        SET title = COALESCE($3, title), company = COALESCE($4, company)
      WHERE user_id = $1 AND application_id = $2 AND status IN ('ready', 'pasted')
      RETURNING *`,
    [userId, applicationId, input.title, input.company]
  );
  return rows[0] ? rowToStoredPostingFetch(rows[0]) : null;
}

/* ---- the machine's two calls: scoped on the row's random id, never on a person ---- */

export interface ClaimedFetch {
  id: string;
  url: string;
}

/**
 * One atomic claim. With an id, that row (if claimable); without, the next
 * claimable row. Claimable means pending, or claimed longer ago than
 * CLAIM_STALE_MS. SKIP LOCKED so two workers never hand out the same row.
 *
 * FAIR BEFORE FIRST. Without an id the order is: fewest rows this person
 * already has in flight, then oldest. Twenty pastes from one member and one
 * from another means the one is read second, not twenty first. The mini never
 * sees who anyone is; the fairness lives here, in the one query that knows.
 *
 * CLAIM_STALE_MS is coupled to the mini's REQUEST_BUDGET_S (postfetch_agent.py):
 * no read there starts its browser phase past 300 s after the claim, so a live
 * read is never handed out twice. Lower one only with the other.
 */
export async function claimPostingFetch(id: string | null): Promise<ClaimedFetch | null> {
  const { rows } = await db().query<ClaimedFetch>(
    `WITH pick AS (
       SELECT id FROM desk_posting_fetch
        WHERE ($1::text IS NULL OR id = $1)
          AND (status = 'pending' OR (status = 'claimed' AND claimed_at < now() - ($2::bigint * interval '1 millisecond')))
        ORDER BY (SELECT count(*) FROM desk_posting_fetch o WHERE o.user_id = desk_posting_fetch.user_id AND o.status = 'claimed'),
                 created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE desk_posting_fetch f
        SET status = 'claimed', claimed_at = now()
       FROM pick
      WHERE f.id = pick.id
      RETURNING f.id, f.url`,
    [id, CLAIM_STALE_MS]
  );
  return rows[0] ?? null;
}

export interface SettleInput {
  outcome: 'ready' | 'unreadable';
  sourceKind: SourceKind | null;
  title: string | null;
  company: string | null;
  descriptionHtml: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  failureCode: FailureCode | null;
  fetchedAt: Date;
  /** Already allowlisted by the route; stored only on ready. */
  machineNotes: MachineNotes;
}

/** Settles a claimed row. Returns the full row (with its owner, for the draft
    trigger) or null when the row was not claimed, which the route answers as
    already settled. */
export async function settlePostingFetch(id: string, input: SettleInput): Promise<(StoredPostingFetch & { userId: string }) | null> {
  const ready = input.outcome === 'ready';
  const { rows } = await db().query<PostingFetchRow>(
    `UPDATE desk_posting_fetch
        SET status = $2, origin = $3, source_kind = $4, title = $5, company = $6, description_html = $7,
            final_url = $8, http_status = $9, failure_code = $10, fetched_at = $11, completed_at = now(),
            machine_notes = $12
      WHERE id = $1 AND status = 'claimed'
      RETURNING *`,
    [
      id,
      ready ? 'ready' : 'unreadable',
      ready ? 'machine' : null,
      input.sourceKind,
      input.title,
      input.company,
      ready ? input.descriptionHtml : null,
      input.finalUrl,
      input.httpStatus,
      ready ? null : input.failureCode,
      input.fetchedAt,
      ready && Object.keys(input.machineNotes).length ? JSON.stringify(input.machineNotes) : null
    ]
  );
  const row = rows[0];
  return row ? { ...rowToStoredPostingFetch(row), userId: row.user_id } : null;
}

/* -------------------------------------------------------------------------
   THE LEARNING LANE.

   Reading a posting and learning the board it lives on are two different
   jobs, and until the site started reading postings itself they happened to
   be done by the same machine in the same pass: the mini read a page, and
   learn_board() in postfetch_agent.py noticed the board that page sat on and
   added it to the nightly crawl if it was new and answered. That is the half
   of "Add a job" that grows the corpus for everybody rather than for the one
   person who pasted the link.

   The site reading most postings itself quietly broke that. A posting read
   here is a board the mini never hears about, so member adds would stop
   feeding the crawl list entirely -- a silent regression in the feature's
   whole point, traded for the latency win.

   WHY THIS IS NOT A NEW TABLE. Every added URL is already a row here, and
   the board verdict already has a home on that row (machine_notes.board,
   which the posting page already renders). So the lane is not a queue of its
   own, it is a second view over rows this table already holds: the ones the
   site read (reader = 'site') that no board verdict has landed on yet. A
   table would have to be kept in step with this one and would answer no
   question this one cannot.

   WHY NOT PUT THE URL ON THE WAKE. postfetch_agent.py's own header states
   the rule: "The wake line carries hints (an id, or 'look'), never work."
   The ntfy topic is a secret but not an authenticated channel, and a message
   that carried a URL would let anyone who guessed the topic choose what the
   mini fetches. The mini asks us what to learn, over the same authenticated
   claim/result shape it already uses for reads.
   ------------------------------------------------------------------------- */

/** A learn claim this old is a mini that died mid-learn; the row is claimable
    again. Learning runs a whole board adapter, so it is allowed longer than a
    single posting read. */
export const LEARN_STALE_MS = 20 * 60 * 1000;

export interface LearnableBoard {
  id: string;
  url: string;
}

/**
 * Hands out the next URL whose board nobody has looked at, and marks it taken.
 *
 * Claimable means: the site did the reading (so the mini never saw this URL),
 * no board verdict has landed yet, and either nothing has claimed it for
 * learning or the claim is stale. One atomic UPDATE with SKIP LOCKED, the same
 * shape claimPostingFetch() uses, so two drains never get the same row.
 */
export async function claimBoardLearn(): Promise<LearnableBoard | null> {
  const { rows } = await db().query<LearnableBoard>(
    `WITH pick AS (
       SELECT id FROM desk_posting_fetch
        WHERE status = 'ready'
          AND machine_notes ->> 'reader' = 'site'
          AND machine_notes -> 'board' IS NULL
          AND (
            machine_notes ->> 'learnClaimedAt' IS NULL
            OR (machine_notes ->> 'learnClaimedAt')::timestamptz < now() - ($1::bigint * interval '1 millisecond')
          )
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE desk_posting_fetch f
        SET machine_notes = jsonb_set(
              coalesce(f.machine_notes, '{}'::jsonb), '{learnClaimedAt}', to_jsonb(now()), true)
       FROM pick
      WHERE f.id = pick.id
      RETURNING f.id, coalesce(f.final_url, f.url) AS url`,
    [LEARN_STALE_MS]
  );
  return rows[0] ?? null;
}

/**
 * Records what the mini made of that row's board, and releases the claim.
 *
 * Returns false when the row is gone or already carries a verdict, which the
 * route answers as accepted-but-not-applied so a retry stops rather than
 * looping. The note goes through boardNoteFrom() at the route, the same
 * allowlist every other board note passes.
 */
export async function settleBoardLearn(id: string, note: BoardNote): Promise<boolean> {
  const { rowCount } = await db().query(
    `UPDATE desk_posting_fetch
        SET machine_notes = jsonb_set(
              coalesce(machine_notes, '{}'::jsonb), '{board}', $2::jsonb, true) - 'learnClaimedAt'
      WHERE id = $1
        AND machine_notes -> 'board' IS NULL`,
    [id, JSON.stringify(note)]
  );
  return (rowCount ?? 0) > 0;
}
