import { describe, expect, it } from 'vitest';
import type { Job, Kill } from './data';
import {
  ABANDON_REASONS,
  APPLICATION_STATES,
  APPLICATION_TRANSITIONS,
  CLOSED_REASONS,
  IN_SESSION_MAX_MINUTES,
  SELF_ARCHIVE_DAYS,
  canTransition,
  fateOf,
  isArchived,
  promptTiming,
  recordPersonConfirmation,
  shouldSelfArchive,
  transition,
  type ApplicationState,
  type PersonConfirmation,
  type PostingFate
} from './desk';

// desk.ts is the pure state machine behind the Desk: no database, no clock
// read internally, same inputs always the same answer. These tests pin the
// contracts that matter most: STM-0002's transition table is exhaustive and
// every state is reachable, a click can never become an applied without the
// person's own confirmation, the posting-fate overlay never guesses where
// it lacks evidence, an abandon reason is required and bounded to the six
// F4.1 names, the 14-day self-archive predicate lands on the right side of
// its own boundary and is reversible by construction, and the two tracks
// (what the person did, what the sweep observed) never merge into one
// value.

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    slug: 'acme-staff-designer',
    company: 'Acme Corp',
    title: 'Staff Product Designer',
    kind: 'posted',
    prospect: null,
    comp_posted: null,
    comp_range: null,
    published_at: null,
    location: 'Remote',
    remote: true,
    source_system: 'greenhouse',
    source_url: 'https://boards.example.com/acme/staff-designer',
    apply_url: 'https://boards.example.com/acme/staff-designer/apply',
    first_observed: '2026-08-01T00:00:00Z',
    last_verified: '2026-08-20T00:00:00Z',
    published_date: '2026-08-01',
    age_days: 19,
    status: 'live',
    window: null,
    risk: 'LOW',
    ease: { friction: 'EASY', minutes_estimate: 10, account_required: false, destination: 'acme.com' },
    fit: { total: 80, title_scope: 20, remote_geo: 20, comp: 20, freshness: 10, apply_friction: 10 },
    description_html: '<p>We need someone who can redesign checkout.</p>',
    ...overrides
  };
}

function kill(overrides: Partial<Kill> = {}): Kill {
  return {
    company: 'Acme Corp',
    title: 'Staff Product Designer',
    reason: 'The listing stopped resolving.',
    first_published: '2026-08-01',
    killed_on: '2026-08-15',
    duration_open_days: 14,
    ...overrides
  };
}

const NOW = new Date('2026-08-20T00:00:00Z');

/* -------------------------------------------------------------------------
   STM-0002: every state reachable, the table exhaustive.
   ------------------------------------------------------------------------- */

describe('APPLICATION_STATES and APPLICATION_TRANSITIONS: exhaustive by construction', () => {
  it('every declared state other than clicked is reachable as a transition target', () => {
    for (const state of APPLICATION_STATES) {
      if (state === 'clicked') continue; // clicked is the entry point, never a target
      const reachable = APPLICATION_TRANSITIONS.some((edge) => edge.to === state);
      expect(reachable, `${state} is never the target of any transition`).toBe(true);
    }
  });

  it('every declared state appears somewhere in the transition table, so a new state cannot be added half-declared', () => {
    for (const state of APPLICATION_STATES) {
      const wiredIn = APPLICATION_TRANSITIONS.some((edge) => edge.from === state || edge.to === state);
      expect(wiredIn, `${state} appears in APPLICATION_STATES but never in APPLICATION_TRANSITIONS`).toBe(true);
    }
  });

  it('every transition edge names states that are actually declared', () => {
    const declared = new Set<ApplicationState>(APPLICATION_STATES);
    for (const edge of APPLICATION_TRANSITIONS) {
      expect(declared.has(edge.from)).toBe(true);
      expect(declared.has(edge.to)).toBe(true);
    }
  });

  it('closed and abandoned are terminal: neither is the source of any transition', () => {
    for (const terminal of ['closed', 'abandoned'] as const) {
      const outgoing = APPLICATION_TRANSITIONS.filter((edge) => edge.from === terminal);
      expect(outgoing).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------
   CLICK IS NOT APPLIED.
   ------------------------------------------------------------------------- */

describe('click is not applied: transition() refuses clicked -> applied without a real confirmation', () => {
  it('refuses clicked -> applied when no confirmation is supplied at all', () => {
    const result = transition({ from: 'clicked', to: 'applied' });
    expect(result.ok).toBe(false);
  });

  it('the refusal names confirmation as the reason, not a generic illegal-edge message', () => {
    const result = transition({ from: 'clicked', to: 'applied' });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/confirmation/i);
  });

  it('the same refusal holds from still_working, the other legal source of applied', () => {
    const result = transition({ from: 'still_working', to: 'applied' });
    expect(result.ok).toBe(false);
  });

  it('refuses clicked -> applied when a PersonConfirmation is present but answers something else', () => {
    // A real, properly constructed confirmation, just not the right answer:
    // this proves transition() checks the answer inside the branded value,
    // not merely that some PersonConfirmation object was handed over.
    const result = transition({
      from: 'clicked',
      to: 'applied',
      confirmation: recordPersonConfirmation('still_working', NOW)
    });
    expect(result.ok).toBe(false);
  });

  it('accepts clicked -> applied only when a PersonConfirmation carrying answer applied is supplied', () => {
    const result = transition({ from: 'clicked', to: 'applied', confirmation: recordPersonConfirmation('applied', NOW) });
    expect(result).toEqual({ ok: true, state: 'applied' });
  });

  it('canTransition() alone says clicked -> applied is a legal edge: the guard lives in transition(), not in the graph', () => {
    // This is the structural point spelled out: the edge is real (an
    // applied card is a legal destination from clicked), so a caller
    // cannot get safety from canTransition() alone. Only transition()
    // checks the confirmation, which is why UI and store code must call
    // transition(), never re-implement the check against canTransition().
    expect(canTransition('clicked', 'applied')).toBe(true);
  });

  it('a plain object literal shaped like a PersonConfirmation does not type-check: only recordPersonConfirmation() produces one', () => {
    // Same fields as a real PersonConfirmation (answer, confirmedAt), never
    // passed through recordPersonConfirmation(), so it lacks the module-
    // private PERSON_CONFIRMATION_BRAND symbol key and is not structurally
    // assignable to PersonConfirmation. THE PROOF IS THE DIRECTIVE ITSELF:
    // TypeScript reports an "unused @ts-expect-error directive" error if
    // the line below does NOT actually fail to compile, so `npx tsc
    // --noEmit` fails this file outright if the brand is ever removed or
    // weakened, with no separate assertion required to notice it.
    // @ts-expect-error: missing the module-private brand; see above.
    const forged: PersonConfirmation = { answer: 'applied', confirmedAt: NOW };
    // The line only reaches here because of the directive above; this
    // assertion is a readability aid, not the real check.
    expect(forged.answer).toBe('applied');
  });

  it('does not accidentally also gate a transition that was never asked to reach applied', () => {
    const result = transition({ from: 'clicked', to: 'still_working' });
    expect(result).toEqual({ ok: true, state: 'still_working' });
  });
});

describe('transition(): illegal edges refused regardless of confirmation', () => {
  it('refuses clicked -> offer, which STM-0002 never permits directly, even carrying a real confirmation', () => {
    const result = transition({ from: 'clicked', to: 'offer', confirmation: recordPersonConfirmation('applied', NOW) });
    expect(result.ok).toBe(false);
  });

  it('refuses a transition out of closed: closed is terminal, even carrying a real confirmation', () => {
    const result = transition({ from: 'closed', to: 'applied', confirmation: recordPersonConfirmation('applied', NOW) });
    expect(result.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   Abandon reason: required, and bounded to the six.
   ------------------------------------------------------------------------- */

describe('abandoned applications keep their reason', () => {
  it('refuses clicked -> abandoned with no reason at all', () => {
    const result = transition({ from: 'clicked', to: 'abandoned' });
    expect(result.ok).toBe(false);
  });

  it('refuses a reason outside the six F4.1 chips', () => {
    const result = transition({
      from: 'clicked',
      to: 'abandoned',
      // @ts-expect-error: deliberately outside AbandonReason, exercising the runtime guard
      abandonReason: 'ghosted'
    });
    expect(result.ok).toBe(false);
  });

  it('accepts each of the six named reasons, and returns exactly the abandoned state', () => {
    for (const reason of ABANDON_REASONS) {
      const result = transition({ from: 'clicked', to: 'abandoned', abandonReason: reason });
      expect(result).toEqual({ ok: true, state: 'abandoned' });
    }
  });

  it('ABANDON_REASONS is exactly the six named in F4.1, no more and no fewer', () => {
    expect([...ABANDON_REASONS].sort()).toEqual(
      ['account_wall', 'changed_my_mind', 'form_too_long', 'other', 'posting_dead', 'salary_missing'].sort()
    );
  });
});

describe('closed applications carry one of the five named reasons', () => {
  it('refuses applied -> closed with no reason', () => {
    const result = transition({ from: 'applied', to: 'closed' });
    expect(result.ok).toBe(false);
  });

  it('accepts each of the five closed reasons', () => {
    for (const reason of CLOSED_REASONS) {
      const result = transition({ from: 'offer', to: 'closed', closedReason: reason });
      expect(result).toEqual({ ok: true, state: 'closed' });
    }
  });
});

/* -------------------------------------------------------------------------
   fateOf(): honest absence, never a guess.
   ------------------------------------------------------------------------- */

describe('fateOf(): honest absence for data it was never given', () => {
  it('returns null for an external, unverified application: no job to observe a fate for', () => {
    expect(fateOf(null, null, NOW)).toBeNull();
  });

  it('returns null for a pre-posting row: there is no posting yet for a fate to describe', () => {
    expect(fateOf(job({ status: 'pre_posting' }), null, NOW)).toBeNull();
  });

  it('does not call a live posting aging when the sweep published no window to measure it against', () => {
    const fate = fateOf(job({ status: 'live', window: null }), null, NOW);
    expect(fate?.kind).toBe('posting_live');
  });

  it('calls a live posting aging only from the sweeps own per-job window, never an invented day count', () => {
    const notYet = fateOf(job({ status: 'live', window: { days: 30, day: 10 } }), null, NOW);
    expect(notYet?.kind).toBe('posting_live');

    const atWindow = fateOf(job({ status: 'live', window: { days: 30, day: 30 } }), null, NOW);
    expect(atWindow?.kind).toBe('posting_aging');
  });

  it('re_verified reads the same as live: two live states, one meaning', () => {
    const fate = fateOf(job({ status: 're_verified', window: null }), null, NOW);
    expect(fate?.kind).toBe('posting_live');
  });
});

describe('fateOf(): the two tracks a closed posting can take', () => {
  it('a closed posting with no matched kill reads as came down, not silently blamed on a rule', () => {
    const fate = fateOf(job({ status: 'closed' }), null, NOW);
    expect(fate?.kind).toBe('posting_came_down');
  });

  it('a closed posting whose matched kill carries no kill_rule also reads as came down', () => {
    const fate = fateOf(job({ status: 'closed' }), kill({ kill_rule: undefined }), NOW);
    expect(fate?.kind).toBe('posting_came_down');
  });

  it('a closed posting whose matched kill fired repost_churn reads as reposted, its own overlay kind', () => {
    const fate = fateOf(job({ status: 'closed' }), kill({ kill_rule: 'repost_churn' }), NOW);
    expect(fate?.kind).toBe('posting_reposted');
  });

  it('a closed posting whose matched kill fired any other named rule carries that rule', () => {
    const fate = fateOf(job({ status: 'closed' }), kill({ kill_rule: 'zombie' }), NOW);
    expect(fate).toMatchObject({ kind: 'posting_killed_by_rule', rule: 'zombie' });
  });

  it('a kill_rule the current taxonomy does not publish (retired evergreen) reads as came down, not fabricated as a rule', () => {
    const fate = fateOf(job({ status: 'closed' }), kill({ kill_rule: 'evergreen' }), NOW);
    expect(fate?.kind).toBe('posting_came_down');
  });
});

describe('fateOf(): every value carries its own provenance and freshness', () => {
  it('observedByUs is true on every non-null overlay', () => {
    const fate = fateOf(job({ status: 'live' }), null, NOW);
    expect(fate?.observedByUs).toBe(true);
  });

  it('staleSweep is false when the sweep is well inside the freshness window', () => {
    const fate = fateOf(job({ status: 'live', last_verified: '2026-08-19T23:00:00Z' }), null, NOW);
    expect(fate?.staleSweep).toBe(false);
  });

  it('staleSweep is true once the sweep is older than the site-wide freshness window', () => {
    const fate = fateOf(job({ status: 'live', last_verified: '2026-08-01T00:00:00Z' }), null, NOW);
    expect(fate?.staleSweep).toBe(true);
  });
});

/* -------------------------------------------------------------------------
   Friction-aware timing: the boundary is a stated choice.
   ------------------------------------------------------------------------- */

describe('promptTiming(): the friction-aware timing rule', () => {
  it('a short, no-account posting resolves in session (the 4-minute example in F4.1)', () => {
    expect(promptTiming({ friction: 'EASY', minutes_estimate: 4, account_required: false, destination: 'x' })).toBe(
      'in_session'
    );
  });

  it('a long, account-wall posting waits for the next visit (the 25-minute example in F4.1)', () => {
    expect(
      promptTiming({ friction: 'HARD', minutes_estimate: 25, account_required: true, destination: 'x' })
    ).toBe('next_visit');
  });

  it('an account wall alone forces next_visit even under the in-session minute boundary', () => {
    expect(promptTiming({ friction: 'MEDIUM', minutes_estimate: 3, account_required: true, destination: 'x' })).toBe(
      'next_visit'
    );
  });

  it('an unmeasured effort is never assumed short', () => {
    expect(promptTiming({ friction: 'EASY', minutes_estimate: null, account_required: false, destination: 'x' })).toBe(
      'next_visit'
    );
  });

  it('null ease (no posting to measure) also waits for the next visit', () => {
    expect(promptTiming(null)).toBe('next_visit');
  });

  it('sits exactly on the stated, named boundary: IN_SESSION_MAX_MINUTES minutes is still in session, one more is not', () => {
    expect(
      promptTiming({ friction: 'EASY', minutes_estimate: IN_SESSION_MAX_MINUTES, account_required: false, destination: 'x' })
    ).toBe('in_session');
    expect(
      promptTiming({
        friction: 'EASY',
        minutes_estimate: IN_SESSION_MAX_MINUTES + 1,
        account_required: false,
        destination: 'x'
      })
    ).toBe('next_visit');
  });
});

/* -------------------------------------------------------------------------
   The 14-day reversible self-archive.
   ------------------------------------------------------------------------- */

describe('shouldSelfArchive(): the 14-day boundary, and reversibility', () => {
  const clickedAt = new Date('2026-08-01T00:00:00Z');

  it('is false at 13 days unconfirmed', () => {
    const thirteenDaysLater = new Date('2026-08-14T00:00:00Z');
    expect(shouldSelfArchive(clickedAt, null, thirteenDaysLater)).toBe(false);
  });

  it('is true at exactly 14 days unconfirmed', () => {
    const fourteenDaysLater = new Date('2026-08-15T00:00:00Z');
    expect(shouldSelfArchive(clickedAt, null, fourteenDaysLater)).toBe(true);
  });

  it('SELF_ARCHIVE_DAYS is the named F4.1 number, 14, not a magic literal duplicated in the test alone', () => {
    expect(SELF_ARCHIVE_DAYS).toBe(14);
  });

  it('never archives a card the person has already confirmed, no matter how old', () => {
    const confirmedAt = new Date('2026-08-02T00:00:00Z');
    const wayLater = new Date('2027-01-01T00:00:00Z');
    expect(shouldSelfArchive(clickedAt, confirmedAt, wayLater)).toBe(false);
  });

  it('still_working counts as confirmed for this predicate: it is a real answer to the confirm loop', () => {
    // shouldSelfArchive only ever looks at confirmedAt, never at the row's
    // state, precisely so a 'still_working' card (whose confirmedAt the
    // store sets the moment the person gives that answer) stops the clock
    // exactly like an 'applied' one would.
    const confirmedAt = new Date('2026-08-03T00:00:00Z');
    expect(shouldSelfArchive(clickedAt, confirmedAt, new Date('2026-09-01T00:00:00Z'))).toBe(false);
  });

  it('archiving is reversible: isArchived() reads only the current archivedAt, so clearing it back to null undoes the archive completely', () => {
    const archived = isArchived(new Date('2026-08-15T00:00:00Z'));
    expect(archived).toBe(true);

    const reversed = isArchived(null);
    expect(reversed).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The two tracks never merge.
   ------------------------------------------------------------------------- */

describe('the two tracks never merge into one status', () => {
  // This module's real guarantee is structural: TransitionResult's only
  // success shape is `{ ok: true; state: ApplicationState }` and
  // PostingFate's discriminant field is `kind`, never `state`, so the two
  // types have no field in common that a value could straddle. That is a
  // claim about the TYPES, and a runtime test cannot fully prove a type
  // was never widened to include both; `npx tsc --noEmit` is what actually
  // holds the types to this shape, run alongside this suite. What follows
  // is the runtime half: neither function's actual output, for a range of
  // inputs, ever carries the other track's discriminant or field names, and
  // no exported name in this module suggests a combined status was built
  // to sit beside them.

  const POSTING_FATE_KINDS = new Set<PostingFate['kind']>([
    'posting_live',
    'posting_aging',
    'posting_came_down',
    'posting_killed_by_rule',
    'posting_reposted'
  ]);

  it('transition() results never carry a posting-fate field', () => {
    const results = [
      transition({ from: 'clicked', to: 'applied', confirmation: recordPersonConfirmation('applied', NOW) }),
      transition({ from: 'clicked', to: 'abandoned', abandonReason: 'other' }),
      transition({ from: 'clicked', to: 'still_working' }),
      transition({ from: 'clicked', to: 'offer', confirmation: recordPersonConfirmation('applied', NOW) }) // illegal, still checked
    ];
    for (const result of results) {
      expect(Object.prototype.hasOwnProperty.call(result, 'kind')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result, 'observedByUs')).toBe(false);
      if ('state' in result) {
        expect(POSTING_FATE_KINDS.has(result.state as PostingFate['kind'])).toBe(false);
      }
    }
  });

  it('fateOf() results never carry an application-state field', () => {
    const fates = [
      fateOf(job({ status: 'live' }), null, NOW),
      fateOf(job({ status: 'closed' }), kill({ kill_rule: 'zombie' }), NOW),
      fateOf(job({ status: 'closed' }), kill({ kill_rule: 'repost_churn' }), NOW)
    ];
    for (const fate of fates) {
      expect(fate).not.toBeNull();
      expect(Object.prototype.hasOwnProperty.call(fate, 'state')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(fate, 'confirmation')).toBe(false);
    }
  });

  it('no exported member of this module names a combined or merged status', async () => {
    const desk = await import('./desk');
    const suspicious = Object.keys(desk).filter((name) => /combined|merged|unified|overall/i.test(name));
    expect(suspicious).toEqual([]);
  });
});
