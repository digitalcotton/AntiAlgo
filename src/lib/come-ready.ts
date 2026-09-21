/**
 * come-ready.ts: the step model behind /start ("Come ready"), the member's
 * first run, from the owner's two designs of 2026-09-20 ("Come ready -
 * onboarding.html" for the paid account, "Come ready - free account
 * onboarding.html" for a waitlisted or free account).
 *
 * PURE. Every status is a function of facts the page already holds (tier,
 * titles, key, record, letter, links, drafts, the requested step), so a step
 * checks itself off on every load with no client state and no stored
 * "onboarding progress" column. Completion is the dismissal: when the paid
 * flow's door has been walked through (one draft exists) the tracker leaves
 * the Desk, the header and this page for good. There is no dismiss button.
 *
 * NOTHING IS MARKED DONE THAT DID NOT HAPPEN. "Account created" and "Place
 * held" are true of any signed-in account; "Membership active" reads the
 * tier; "Verify your email" reads the account's own verified flag. No paid
 * date and no admitted date exist in any table, so no hint prints one.
 */

export type Edition = 'waitlisted' | 'free' | 'paid';

/** The design's row states, one word each, printed as the row's tag. */
export type StepStatus = 'done' | 'next' | 'later' | 'optional' | 'skipped' | 'locked' | 'reading' | 'waiting';

export interface ComeReadyStep {
  /** 1-based, as printed. */
  n: number;
  name: string;
  hint: string;
  /** One clause on what taking this step turns on, for the Desk's band. The
      hint explains the step; this says what it is worth. */
  stake: string;
  /** The band's button label: an imperative shorter than the row's name. */
  action: string;
  status: StepStatus;
  /** The step's own view, when the page has one (the rows for 1 and 2 have none). */
  href: string | null;
}

/** The step the right column shows: a paid step 3 to 6 or the door; a free
    step 3 or 4, the door, or the waitlisted panel. */
export type ActiveStep = 3 | 4 | 5 | 6 | 'door' | 'wait';

export interface ComeReadyFacts {
  edition: Edition;
  /** Better Auth's own flag on the account. */
  emailVerified: boolean;
  /** Core titles with the live count the Desk measures for each; null when
      the sweep could not be read this request (the title is still real). */
  coreTitles: readonly { title: string; liveCount: number | null }[];
  /** The connected provider, first in the drafting order, or null. */
  key: { providerLabel: string; last4: string } | null;
  /** Profile Record entries. */
  entries: number;
  links: number;
  /** A resumé read is in flight. */
  parsePending: boolean;
  letterOnFile: boolean;
  /** Job drafts ever written (the paid door has been walked through). */
  drafts: number;
  /** The ?step= the reader asked for, raw. */
  requested: string | null;
}

export interface ComeReady {
  edition: Edition;
  steps: ComeReadyStep[];
  /** How many rows read done, the "N of M done" numerator. */
  doneCount: number;
  /** M: six on the paid account, four on the free one. */
  total: number;
  /** The row tagged next, or null when none is. */
  nextStep: ComeReadyStep | null;
  /** What the band prints after "Next:". */
  nextName: string;
  /** The clause after the name, and the button beside it. With no step left
      these carry the run's own ending: the paid door, or the free account's
      one remaining choice. */
  nextStake: string;
  nextAction: string;
  nextHref: string;
  active: ActiveStep;
  /** Paid: steps 3, 4 and 5 done, so the door shows a role. Free: never. */
  doorOpen: boolean;
  /** The tracker has nothing left to do and leaves every page. */
  complete: boolean;
  /** Paid step 4 was passed over without a key (the reader moved on). */
  keySkipped: boolean;
}

const PAID_STEP_HREFS: Record<number, string> = { 3: '/start?step=3', 4: '/start?step=4', 5: '/start?step=5', 6: '/start?step=6' };
const FREE_STEP_HREFS: Record<number, string> = { 3: '/start?step=3', 4: '/start?step=4' };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function requestedStep(raw: string | null, allowed: readonly ActiveStep[]): ActiveStep | null {
  if (raw === null) return null;
  const asNumber = Number(raw);
  const value: ActiveStep | null = raw === 'door' ? 'door' : Number.isInteger(asNumber) ? (asNumber as ActiveStep) : null;
  return value !== null && allowed.includes(value) ? value : null;
}

function buildPaid(facts: ComeReadyFacts): ComeReady {
  const requested = requestedStep(facts.requested, [3, 4, 5, 6, 'door']);
  const hasTitle = facts.coreTitles.length > 0;
  const hasKey = facts.key !== null;
  const hasRecord = facts.entries > 0;
  // The letter, not the links: a resumé read adds links on its own, and a
  // step the reader never took must not read done (the design's resume-done
  // frame shows 3 links with step 6 still next).
  const hasLetter = facts.letterOnFile;
  const first = facts.coreTitles[0] ?? null;

  // The reader walked past the key: they are looking at a later step with no
  // key on file. The row reads skipped and the resumé step is locked.
  const keySkipped = !hasKey && (requested === 5 || requested === 6 || requested === 'door');

  // Statuses for 3, 4, 5 in order: done, or a special state, or the first
  // undone is next and the rest are later.
  let nextAssigned = false;
  const ordered = (done: boolean, special: StepStatus | null): StepStatus => {
    if (done) return 'done';
    if (special) return special;
    if (!nextAssigned) {
      nextAssigned = true;
      return 'next';
    }
    return 'later';
  };
  const s3 = ordered(hasTitle, null);
  const s4 = ordered(hasKey, keySkipped ? 'skipped' : null);
  const s5 = ordered(hasRecord, facts.parsePending ? 'reading' : keySkipped ? 'locked' : null);
  const s6: StepStatus = hasLetter ? 'done' : s3 === 'done' && s4 === 'done' && s5 === 'done' ? 'next' : 'optional';

  const keyHint = facts.key
    ? `${facts.key.providerLabel}, key ends in ${facts.key.last4}.`
    : keySkipped
      ? 'Skipped. Reading and drafting wait on it.'
      : 'One trip to your provider. Unlocks reading and drafting.';
  const recordHint =
    s5 === 'done'
      ? [plural(facts.entries, 'entry', 'entries'), plural(facts.links, 'link', 'links')].join(', ') + '.'
      : s5 === 'reading'
        ? 'Reading on your key.'
        : s5 === 'locked'
          ? 'Waits on a key.'
          : 'Read on your own model. The record fills itself.';
  const letterHint = s6 === 'done' ? 'Cover letter on file.' : 'Recommended, not required. Voice for the letter, links on every draft.';

  const steps: ComeReadyStep[] = [
    { n: 1, name: 'Account created', hint: 'You are in.', stake: '', action: '', status: 'done', href: null },
    { n: 2, name: 'Membership active', hint: 'Paid. $7.25 a month.', stake: '', action: '', status: 'done', href: null },
    {
      n: 3,
      name: 'Name your titles',
      stake: 'The Desk turns on tonight.',
      action: 'Name your titles',
      hint: first
        ? `${first.title}. ${first.liveCount !== null ? `${first.liveCount} live tonight. ` : ''}The Desk turns on tonight.`
        : 'Pays back in seconds. The Desk turns on tonight.',
      status: s3,
      href: PAID_STEP_HREFS[3]
    },
    {
      n: 4,
      name: 'Connect your key',
      hint: keyHint,
      stake: 'Unlocks the resumé reader and drafting.',
      action: 'Connect your key',
      status: s4,
      href: PAID_STEP_HREFS[4]
    },
    {
      n: 5,
      name: 'Bring your resumé',
      hint: recordHint,
      stake: 'Unlocks drafting.',
      action: 'Bring your resumé',
      status: s5,
      href: PAID_STEP_HREFS[5]
    },
    {
      n: 6,
      name: 'Add your cover letter and links',
      hint: letterHint,
      stake: 'Voice for the letter, links on every draft.',
      action: 'Add your letter',
      status: s6,
      href: PAID_STEP_HREFS[6]
    }
  ];

  const doorOpen = hasTitle && hasKey && hasRecord;
  const complete = doorOpen && facts.drafts > 0;
  const active: ActiveStep =
    requested ?? (!hasTitle ? 3 : !hasKey ? 4 : !hasRecord ? 5 : !hasLetter ? 6 : 'door');
  const nextStep = steps.find((s) => s.status === 'next') ?? null;

  return {
    edition: 'paid',
    steps,
    doneCount: steps.filter((s) => s.status === 'done').length,
    total: 6,
    nextStep,
    nextName: nextStep ? nextStep.name : 'draft your first application',
    // Nothing left to check off but no draft written: the band's action is the
    // door, which is otherwise only reachable by typing its address.
    nextStake: nextStep ? nextStep.stake : 'The last thing the run asks for.',
    nextAction: nextStep ? nextStep.action : 'Draft your first application',
    nextHref: nextStep?.href ?? '/start?step=door',
    active,
    doorOpen,
    complete,
    keySkipped
  };
}

function buildFree(facts: ComeReadyFacts): ComeReady {
  const waitlisted = facts.edition === 'waitlisted';
  const requested = waitlisted ? null : requestedStep(facts.requested, [3, 4, 'door']);
  const hasTitle = facts.coreTitles.length > 0;
  const first = facts.coreTitles[0] ?? null;

  let nextAssigned = false;
  const ordered = (done: boolean, special: StepStatus | null): StepStatus => {
    if (done) return 'done';
    if (special) return special;
    if (!nextAssigned) {
      nextAssigned = true;
      return 'next';
    }
    return 'later';
  };
  const s2 = ordered(!waitlisted, waitlisted ? 'waiting' : null);
  const s3 = waitlisted ? 'later' : ordered(facts.emailVerified, null);
  const s4 = waitlisted ? 'later' : ordered(hasTitle, null);

  const steps: ComeReadyStep[] = [
    { n: 1, name: 'Place held', hint: 'Joined the waitlist.', stake: '', action: '', status: 'done', href: null },
    {
      n: 2,
      name: 'Admitted',
      stake: '',
      action: '',
      hint: s2 === 'done' ? 'Sign-in is open.' : 'By hand, one at a time. We write once, the day it happens.',
      status: s2,
      href: null
    },
    {
      n: 3,
      name: 'Verify your email',
      hint: s3 === 'done' ? 'Verified.' : 'One message, the night something you watch changes.',
      stake: 'One message, the night something you watch changes.',
      action: 'Verify your email',
      status: s3,
      href: waitlisted ? null : FREE_STEP_HREFS[3]
    },
    {
      n: 4,
      name: 'Name your titles',
      hint: first
        ? `${first.title}. ${first.liveCount !== null ? `${first.liveCount} live tonight, ` : ''}in the board's menu.`
        : "A title menu in the board's search cell. Pays back in seconds.",
      stake: "The board's search cell learns your titles.",
      action: 'Name your titles',
      status: s4,
      href: waitlisted ? null : FREE_STEP_HREFS[4]
    }
  ];

  const active: ActiveStep = waitlisted ? 'wait' : (requested ?? (!facts.emailVerified ? 3 : !hasTitle ? 4 : 'door'));
  const nextStep = steps.find((s) => s.status === 'next') ?? null;

  return {
    edition: facts.edition,
    steps,
    doneCount: steps.filter((s) => s.status === 'done').length,
    total: 4,
    nextStep,
    nextName: nextStep ? nextStep.name : 'what the paid account opens',
    // The free run's last step is naming titles, so with none left the band
    // carries the one choice the account has after it (owner, 2026-09-21).
    nextStake: nextStep ? nextStep.stake : 'One price, and it does not move.',
    nextAction: nextStep ? nextStep.action : 'What paid opens',
    nextHref: nextStep?.href ?? '/the-account',
    active,
    doorOpen: false,
    // The free flow has no completion: its door is a choice, not a task, so
    // the tracker stays until the account is paid (then the paid model rules).
    complete: false,
    keySkipped: false
  };
}

export function buildComeReady(facts: ComeReadyFacts): ComeReady {
  return facts.edition === 'paid' ? buildPaid(facts) : buildFree(facts);
}

/** Which edition a tier gets. Internal counts as paid, the same rank rule
    isPaidViewer applies. */
export function editionFor(tier: 'public' | 'waitlisted' | 'member' | 'paid' | 'internal'): Edition {
  if (tier === 'paid' || tier === 'internal') return 'paid';
  if (tier === 'waitlisted') return 'waitlisted';
  return 'free';
}
