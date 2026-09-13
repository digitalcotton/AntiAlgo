/**
 * desk.ts: the pure state machine behind the Desk (MASTER-SPEC 3.5, F4). No
 * database access in this file, on purpose, in the same spirit as record.ts
 * and entitlement.ts: this is what lets STM-0002's transition table, the
 * click-is-not-applied guard, the fate overlay, the friction-timing rule and
 * the 14-day self-archive predicate all be tested with no connection string,
 * which matters here specifically because a connection string is the one
 * thing this repository will not let a worker open. The impure half (reading
 * and writing db/006_desk.sql's tables) lives elsewhere, later, and reads
 * this file rather than reimplementing any of it.
 *
 * THE TWO TRACKS NEVER MERGE. MASTER-SPEC 3.5: "the two tracks never merge
 * into one status." ApplicationState (what the person did) and PostingFate
 * (what the sweep observed happen to the posting) are two separate types
 * below, with disjoint field shapes (ApplicationState-bearing values use a
 * `state` field; PostingFate values use a `kind` field), and there is no
 * function anywhere in this file that accepts both and returns one combined
 * value. transition() only ever touches ApplicationState; fateOf() only
 * ever touches PostingFate. See desk.test.ts's "the two tracks never merge"
 * describe block for how far that claim is actually tested, and its own
 * comment for the one part of it a runtime test cannot prove.
 *
 * NO FABRICATED STATES. Every ApplicationState value below is something the
 * person told us (via transition()'s branded PersonConfirmation, or a
 * direct choice like 'still_working') or the system's own honest starting
 * point ('clicked': we saw the click, nothing more). Every PostingFate value is
 * `observedByUs: true` and computed only from data the published sweep
 * files actually contain. There is no "under review", no "viewed", no
 * progress theatre anywhere in this file. If a future change to this file
 * adds a state neither the person nor the sweep produced, that change is
 * wrong, not this comment.
 */

import type { Ease, Job, Kill, KillRule } from './data';
// publishedRuleOf is a value import, not a type: it is the one place data.ts
// itself decides whether a kill's rule is one the site still stands behind
// (evergreen, retired 2026-08-19, is excluded there). Reusing it here means
// fateOf() below cannot drift from that decision by reimplementing it; this
// does not reach across the "no database" line the rest of this file's
// header describes, because data.ts reads bundled JSON fixtures at module
// load, the same static files every page on this site already reads, never
// a network call or a connection string.
import { publishedRuleOf } from './data';
import { FRESH_WINDOW_HOURS } from './data-contract';

/* -------------------------------------------------------------------------
   STM-0002: the user-side states and their legal transitions.
   ------------------------------------------------------------------------- */

/**
 * Every user-side state STM-0002 names, as DATA, so this file, desk.test.ts
 * and a future UI can all read the same list rather than three copies of it
 * drifting apart. Matches db/006_desk.sql's state CHECK constraint,
 * word for word.
 */
export const APPLICATION_STATES = [
  'clicked',
  'applied',
  'abandoned',
  'still_working',
  'interviewing',
  'offer',
  'closed'
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];

export const ABANDON_REASONS = [
  'form_too_long',
  'account_wall',
  'salary_missing',
  'posting_dead',
  'changed_my_mind',
  'other'
] as const;
export type AbandonReason = (typeof ABANDON_REASONS)[number];

export const CLOSED_REASONS = ['accepted', 'withdrawn', 'rejected', 'no_answer', 'presumed_closed'] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

/**
 * One legal edge in STM-0002, read straight off MASTER-SPEC 3.5:
 *
 *   clicked -> applied | abandoned(reason) | still_working
 *   -> interviewing -> offer -> closed(...)
 *
 * The middle arrow's three destinations all leave `clicked`. The trailing
 * chain ("-> interviewing -> offer -> closed") reads onto `applied`: a
 * still-working card has not yet told us it was submitted, so it cannot
 * itself be interviewing; it first has to become `applied` (or close out as
 * `abandoned`). `applied` may also close directly, and `interviewing` may
 * close directly: MASTER-SPEC's closed reasons include 'rejected' with no
 * qualifier about which stage the rejection arrived at, and a rejection
 * that never reached an interview is a real, common shape this graph has to
 * hold. `abandoned` and `closed` are terminal: STM-0002 gives no reopening
 * path for either, and this file adds none rather than inventing one.
 *
 * DATA, NOT A SWITCH STATEMENT, for the same reason APPLICATION_STATES is
 * an array and not a type union alone: desk.test.ts loops this table to
 * prove every declared state is wired in, which a chain of `if` branches
 * could not be looped over.
 */
export interface ApplicationTransition {
  from: ApplicationState;
  to: ApplicationState;
}

export const APPLICATION_TRANSITIONS: readonly ApplicationTransition[] = [
  { from: 'clicked', to: 'applied' },
  { from: 'clicked', to: 'abandoned' },
  { from: 'clicked', to: 'still_working' },
  { from: 'still_working', to: 'applied' },
  { from: 'still_working', to: 'abandoned' },
  { from: 'applied', to: 'interviewing' },
  { from: 'applied', to: 'closed' },
  { from: 'interviewing', to: 'offer' },
  { from: 'interviewing', to: 'closed' },
  { from: 'offer', to: 'closed' }
] as const;

/** Whether STM-0002 permits moving from `from` directly to `to`. Reads
    APPLICATION_TRANSITIONS; the two are never allowed to disagree because
    this function is the only thing that answers this question. */
export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return APPLICATION_TRANSITIONS.some((edge) => edge.from === from && edge.to === to);
}

/* -------------------------------------------------------------------------
   PersonConfirmation: not constructible without going through the confirm
   loop's own answer. CLICK IS NOT APPLIED, made structural rather than
   requested by a boolean.
   ------------------------------------------------------------------------- */

/**
 * A private, module-local symbol used to brand PersonConfirmation, the same
 * technique tailor.ts uses to make a Bullet unconstructible without its
 * source ids (see that file's own comment on BULLET_BRAND for the full
 * argument). TypeScript's object types are structural: without this, any
 * object literal shaped like `{ answer: 'applied', confirmedAt: someDate }`
 * would satisfy PersonConfirmation from any file, whether or not it was
 * ever built by recordPersonConfirmation() below. Because
 * PERSON_CONFIRMATION_BRAND is not exported, no file outside this module
 * can name it, so no file outside this module can write a value that is
 * structurally assignable to PersonConfirmation. This is a stronger claim
 * than the boolean this type replaces: a `true` literal is copyable by
 * accident (a default, a careless `confirmedByPerson: true` on every
 * request); a value carrying a field no other module can spell is not.
 */
const PERSON_CONFIRMATION_BRAND: unique symbol = Symbol('desk.PersonConfirmation');

/** The three answers F4.1's confirm loop offers, and nothing else: "Did
    you apply to <company>?" resolves to exactly one of these. */
export const CONFIRM_LOOP_ANSWERS = ['applied', 'still_working', 'didnt_finish'] as const;
export type ConfirmLoopAnswer = (typeof CONFIRM_LOOP_ANSWERS)[number];

/**
 * One person's answer to the confirm loop, at the instant they gave it.
 * Unconstructible outside this file: the only way to produce a value
 * TypeScript accepts as a PersonConfirmation is to call
 * recordPersonConfirmation() below, which is therefore the one place in
 * this codebase a future reviewer needs to check to answer "who calls
 * this, and do they have a real person in front of them."
 */
export interface PersonConfirmation {
  readonly answer: ConfirmLoopAnswer;
  readonly confirmedAt: Date;
  readonly [PERSON_CONFIRMATION_BRAND]: true;
}

/**
 * The only way to construct a PersonConfirmation. Takes the two things
 * F4.1 says the confirm loop actually captures: which of the three answers
 * was given, and when. Nothing here validates `confirmedAt` against a
 * clock (this file reads no clock; see the file header), because the
 * instant itself is the caller's report of when the person answered, the
 * same way `now` is a parameter everywhere else in this file rather than a
 * `Date.now()` call.
 */
export function recordPersonConfirmation(answer: ConfirmLoopAnswer, confirmedAt: Date): PersonConfirmation {
  return { answer, confirmedAt, [PERSON_CONFIRMATION_BRAND]: true };
}

/* -------------------------------------------------------------------------
   transition(): the one door STM-0002's edges are walked through.
   ------------------------------------------------------------------------- */

/**
 * What a caller supplies to attempt one transition.
 *
 * `confirmation` IS THE CLICK-IS-NOT-APPLIED GUARD. MASTER-SPEC 3.5:
 * "Silent auto-applied is a forbidden state." transition() below refuses
 * any request that targets 'applied' unless `confirmation` is present AND
 * its `answer` is `'applied'`. This used to be a plain `confirmedByPerson:
 * boolean`; it is a branded PersonConfirmation instead precisely because a
 * boolean is a claim a caller makes about itself, and a forbidden state
 * should be unrepresentable, not merely unrequested. There is no object
 * literal a caller can write that type-checks as a PersonConfirmation
 * (see PERSON_CONFIRMATION_BRAND above): the only route to one is
 * recordPersonConfirmation(), so the only route to `to: 'applied'`
 * succeeding is a caller that went through that constructor first.
 * canTransition() alone would still happily say `clicked -> applied` is a
 * legal edge, because the edge IS legal, gated on confirmation, not absent
 * from the graph; transition() is the only place that checks the gate.
 *
 * WHERE THIS WOULD BREAK, STATED AS PLAINLY AS THE BOOLEAN VERSION WAS: a
 * brand stops accidental and casual forgery (a stray `true`, a default
 * that quietly turns "unconfirmed" into "confirmed"). It does not stop a
 * determined caller inside this same package who chooses to call
 * recordPersonConfirmation('applied', new Date()) with invented
 * arguments and no real person behind them; nothing in this file can see
 * whether the instant or the answer it is handed came from an actual
 * confirm-loop response or a batch job pretending to be one. That caller
 * still has to go through one named, exported, greppable function to do
 * it, rather than setting a field, which is the whole improvement: the
 * call site of recordPersonConfirmation() is the review point. Anyone
 * asking "could this codebase silently auto-apply" now has exactly one
 * place to look for every caller of that function and ask, of each one,
 * whether a person was actually there.
 */
export interface TransitionRequest {
  from: ApplicationState;
  to: ApplicationState;
  /** Present only when the person has actually answered the confirm loop.
      Required, and required to carry answer 'applied', for `to: 'applied'`
      to succeed; optional for every other transition, none of which STM-0002
      or F4.1 ties to a confirm-loop answer. */
  confirmation?: PersonConfirmation;
  /** Required exactly when `to === 'abandoned'`. */
  abandonReason?: AbandonReason;
  /** Required exactly when `to === 'closed'`. */
  closedReason?: ClosedReason;
}

export type TransitionResult =
  | { ok: true; state: ApplicationState }
  | { ok: false; reason: string };

function isAbandonReason(value: unknown): value is AbandonReason {
  return typeof value === 'string' && (ABANDON_REASONS as readonly string[]).includes(value);
}

function isClosedReason(value: unknown): value is ClosedReason {
  return typeof value === 'string' && (CLOSED_REASONS as readonly string[]).includes(value);
}

/**
 * Attempts one STM-0002 transition. Never throws for a user-caused refusal
 * (an illegal edge, a missing confirmation, a missing or invalid reason):
 * those are `{ ok: false, reason }`, the same "return issues, do not throw"
 * shape record.ts's validateEntry() uses for the same reason, restated in
 * this file's own header. A throw here would mean a bug in this code, and
 * nothing below throws.
 */
export function transition(request: TransitionRequest): TransitionResult {
  const { from, to } = request;

  if (!canTransition(from, to)) {
    return { ok: false, reason: `desk: no legal transition from '${from}' to '${to}' in STM-0002.` };
  }

  if (to === 'applied' && request.confirmation?.answer !== 'applied') {
    return {
      ok: false,
      reason:
        "desk: 'applied' requires a PersonConfirmation carrying answer 'applied', produced by " +
        'recordPersonConfirmation() from the confirm loop (MASTER-SPEC F4.1). A click alone ' +
        'never promotes a card; this refusal is what makes silent auto-applied structurally ' +
        'impossible from this function.'
    };
  }

  if (to === 'abandoned' && !isAbandonReason(request.abandonReason)) {
    return {
      ok: false,
      reason: `desk: 'abandoned' requires one of the six F4.1 reasons: ${ABANDON_REASONS.join(', ')}.`
    };
  }

  if (to === 'closed' && !isClosedReason(request.closedReason)) {
    return {
      ok: false,
      reason: `desk: 'closed' requires one of the five MASTER-SPEC 3.5 reasons: ${CLOSED_REASONS.join(', ')}.`
    };
  }

  return { ok: true, state: to };
}

/* -------------------------------------------------------------------------
   The posting-fate overlay: a separate axis, observed_by_us only.
   ------------------------------------------------------------------------- */

/**
 * The overlay MASTER-SPEC 3.5 names: `posting_live | posting_aging |
 * posting_came_down | posting_killed_by_rule(rule) | posting_reposted`.
 * Every member carries `observedByUs: true` because nothing in this union
 * has any other way to be known (there is no `you_told_us` posting fate:
 * a person cannot tell us what happened to a listing, only the sweep can),
 * and `asOf`, the sweep instant the observation is good as of, so a render
 * can show its own working the way ageOf() in data.ts does for age.
 *
 * `staleSweep` answers F4.4's "sweep gap (amber band inherited)" state:
 * true when `asOf` is further in the past than FRESH_WINDOW_HOURS allows,
 * the same staleness window src/components/JobTable.astro's client-side
 * check already uses (imported from data-contract.ts, not restated as a
 * second number here, for the reason that file's own comment gives: two
 * copies of a threshold is how a page ends up looking fresh while the
 * alarm rings). A stale overlay is not withheld; it is shown with its own
 * honesty about how old it is, exactly like the rest of the site.
 */
export type PostingFate =
  | { kind: 'posting_live'; observedByUs: true; asOf: string; staleSweep: boolean }
  | { kind: 'posting_aging'; observedByUs: true; asOf: string; staleSweep: boolean }
  | { kind: 'posting_came_down'; observedByUs: true; asOf: string; staleSweep: boolean }
  | { kind: 'posting_killed_by_rule'; observedByUs: true; asOf: string; staleSweep: boolean; rule: KillRule }
  | { kind: 'posting_reposted'; observedByUs: true; asOf: string; staleSweep: boolean };

function isStaleSweep(asOfISO: string, now: Date): boolean {
  const observed = Date.parse(asOfISO);
  // An unparseable observation timestamp cannot be trusted to be fresh:
  // treat it as stale rather than assume the best case for data this
  // function cannot itself verify.
  if (Number.isNaN(observed)) return true;
  const hours = (now.getTime() - observed) / 3_600_000;
  return hours > FRESH_WINDOW_HOURS;
}

/**
 * Computes the posting-fate overlay from published sweep data only.
 *
 * `job` is the verified posting this application points at, or `null` for
 * an external, unverified URL (F4.2: "external ones are labeled not
 * verified by us, plainly"). There is nothing for this function to observe
 * about a posting we never swept, so it returns `null`: an honest absence,
 * the same shape ageOf() in data.ts returns when it has no basis for a
 * number, never a guessed fate.
 *
 * `kill` is the kill record already matched to this job by the caller (by
 * company and title, the same identity killSlug() in data.ts is built
 * from), or `null` if none exists. This function does not search KILLS
 * itself: staying a function of its own arguments, rather than reading a
 * module-level array, is what keeps it testable with a handful of literal
 * Job and Kill values and no fixture loading.
 *
 * `now` is the caller's wall clock, used only to decide `staleSweep`
 * against `job.last_verified`; it never affects which `kind` is chosen,
 * because the sweep's own findings do not become a different finding
 * because time passed, only a possibly stale one.
 *
 * THE KIND, DECIDED FROM data.ts's OWN FIELDS, NOTHING INVENTED:
 *
 *   job.status === 'pre_posting'
 *     -> null. A prospect is not a posting yet; there is no posting fate
 *        to observe.
 *
 *   job.status is 'live' or 're_verified' ("two live states, one meaning,
 *   exactly as the mark legend has it", data.ts's own comment on
 *   verifiedJobs())
 *     -> 'posting_aging' when job.window is present AND
 *        job.window.day >= job.window.days: the posting has reached or
 *        passed the length of its OWN expiry window, a number the sweep
 *        already publishes per job (see data.ts's JobWindow), never a
 *        global day-count threshold invented here.
 *     -> 'posting_live' when job.window is absent. THIS IS AN HONEST
 *        ABSENCE, NOT A FALLBACK TO A DEFAULT AGE: 'posting_live' is not
 *        this function guessing at an age it does not have; it is exactly
 *        what job.status already establishes on its own (the posting is
 *        still open), independent of window entirely. The only thing a
 *        missing window withholds is the stronger, additional claim that
 *        the posting is specifically aging; without evidence for that
 *        stronger claim, this function makes the weaker, fully-evidenced
 *        one instead of inventing a threshold to manufacture the stronger
 *        one. It never reports an age, a day count, or any other number it
 *        was not given.
 *
 *   job.status === 'closed', read through data.ts's own publishedRuleOf(kill)
 *   rather than kill.kill_rule directly, so this function inherits the same
 *   "not every rule the machine ever fired is one this site still stands
 *   behind" decision data.ts already makes (evergreen, retired 2026-08-19,
 *   resolves to null there and here) instead of reimplementing it and
 *   risking the two disagreeing:
 *     -> 'posting_reposted' when publishedRuleOf(kill) is 'repost_churn'.
 *        KILL_RULES in data.ts documents this rule as firing specifically
 *        on repost behaviour, which is why it maps to its own overlay kind
 *        rather than the generic killed-by-rule one: MASTER-SPEC 3.5 lists
 *        posting_killed_by_rule(rule) and posting_reposted as siblings in
 *        the same union, and repost_churn is the one rule that IS the
 *        reposted finding, not a rule that merely accompanies it.
 *     -> 'posting_killed_by_rule' with that rule when publishedRuleOf(kill)
 *        names any other rule (misrepresented, zombie, phantom,
 *        touched_not_refreshed).
 *     -> 'posting_came_down' when the posting is closed but no matched
 *        kill was supplied, or publishedRuleOf(kill) is null (no kill_rule
 *        at all, data.ts's own `killed_unattributed`, or a rule the
 *        current taxonomy no longer stands behind). This is the honest
 *        middle ground F4's key story asks for by name: "the posting left
 *        the index" is knowable and said plainly, without inventing a rule
 *        this function was not given evidence for.
 */
export function fateOf(job: Job | null, kill: Kill | null, now: Date): PostingFate | null {
  if (job === null || job.status === 'pre_posting') return null;

  const asOf = job.last_verified;
  const staleSweep = isStaleSweep(asOf, now);

  if (job.status === 'closed') {
    const rule = kill ? publishedRuleOf(kill) : null;
    if (rule === 'repost_churn') {
      return { kind: 'posting_reposted', observedByUs: true, asOf, staleSweep };
    }
    if (rule !== null) {
      return { kind: 'posting_killed_by_rule', observedByUs: true, asOf, staleSweep, rule };
    }
    return { kind: 'posting_came_down', observedByUs: true, asOf, staleSweep };
  }

  // job.status is 'live' or 're_verified' here: JobStatus has exactly four
  // members and 'pre_posting' and 'closed' are both handled above.
  const aging = job.window !== null && job.window.day >= job.window.days;
  return { kind: aging ? 'posting_aging' : 'posting_live', observedByUs: true, asOf, staleSweep };
}

/* -------------------------------------------------------------------------
   Friction-aware timing (F4.1).
   ------------------------------------------------------------------------- */

export type PromptTiming = 'in_session' | 'next_visit';

/**
 * CHOICE, STATED PLAINLY: the boundary between an in-session prompt and a
 * next-visit one is a `minutes_estimate` of 10 minutes or less, with no
 * account wall. F4.1 gives the two ends of the shape by example ("a
 * 4-minute no-account posting resolves within the session; a 25-minute
 * account-wall posting gets a next-day prompt") but does not name the
 * number between 4 and 25 where the behaviour should flip, and this file
 * is not going to invent one out of nothing.
 *
 * 10 is derived from MASTER-SPEC 9.3's own approved number for this
 * feature: "applications that take more than 15 minutes see a 365 percent
 * degradation in completion" (Appcast). Fifteen minutes is where a person
 * has functionally given up, not a safe place to still be interrupting
 * them with a prompt. Setting the in-session boundary five minutes under
 * that failure point means nobody is ever prompted mid-session after
 * they have already crossed into the degradation zone the site's own
 * approved copy describes elsewhere. The spec supplies the two endpoints
 * and the 15-minute citation; it does not supply 10. That number is a
 * choice made here, once, so a test and a UI read the same constant
 * instead of two guesses.
 */
export const IN_SESSION_MAX_MINUTES = 10;

/**
 * When to prompt for confirmation, from the sweep's own per-posting ease
 * data (F4.1: "the sweep already computes minutes_estimate and
 * account_required per posting"). `ease === null` (a pre-posting row, or a
 * posting the sweep never measured) resolves to 'next_visit': an unknown
 * effort is never assumed to be short, the same "absent data yields an
 * honest default, never an optimistic guess" posture the rest of this file
 * takes with fateOf().
 */
export function promptTiming(ease: Ease | null): PromptTiming {
  if (ease === null) return 'next_visit';
  if (ease.account_required) return 'next_visit';
  if (ease.minutes_estimate === null) return 'next_visit';
  return ease.minutes_estimate <= IN_SESSION_MAX_MINUTES ? 'in_session' : 'next_visit';
}

/* -------------------------------------------------------------------------
   The 14-day reversible self-archive (F4.1).
   ------------------------------------------------------------------------- */

const MS_PER_DAY = 86_400_000;

/** F4.1: "After 14 days unconfirmed, the card self-archives." */
export const SELF_ARCHIVE_DAYS = 14;

/**
 * Whether a card should self-archive: true once `clickedAt` is at least
 * SELF_ARCHIVE_DAYS in the past AND `confirmedAt` is still null. Reads
 * `confirmedAt`, not the row's `state`, on purpose: 'still_working' is
 * itself a real answer to the confirm loop (F4.1's channel 1 lists it as
 * one of three resolutions), so a card the person told us they were still
 * working on must stop counting toward the 14 days the moment that answer
 * is given, even though its state is not 'applied'. db/006_desk.sql's
 * confirmed_at column is written whenever any of the three channels
 * resolves the card, which is what keeps this predicate and that column
 * telling the same story.
 *
 * A PURE PREDICATE OVER TIMESTAMPS ONLY, as asked: this function decides
 * nothing about what "self-archiving" DOES to a row (that is the store's
 * job: set archived_at, never delete anything). Reversibility is a
 * property of that shape, not of this predicate: db/006_desk.sql's
 * archived_at is a nullable timestamp a later confirmation clears back to
 * null, so "reversible" means the row this predicate was computed for is
 * still there, unchanged, ready to leave the archived state the same way
 * it entered it. isArchived() below is the other half of that shape, kept
 * pure for the same reason.
 */
export function shouldSelfArchive(clickedAt: Date, confirmedAt: Date | null, now: Date): boolean {
  if (confirmedAt !== null) return false;
  const elapsedDays = (now.getTime() - clickedAt.getTime()) / MS_PER_DAY;
  return elapsedDays >= SELF_ARCHIVE_DAYS;
}

/** Whether a card is currently archived, from db/006_desk.sql's
    archived_at alone. `null` is "never archived, or reversed back out of
    it": both read the same as "not archived" because a self-archive that
    was undone must look exactly like one that never happened, not like a
    row carrying a scar. */
export function isArchived(archivedAt: Date | null): boolean {
  return archivedAt !== null;
}
