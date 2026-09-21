import { describe, it, expect } from 'vitest';
import { buildComeReady, editionFor, type ComeReadyFacts } from './come-ready';

const defaults: ComeReadyFacts = {
  edition: 'paid',
  emailVerified: true,
  coreTitles: [],
  key: null,
  entries: 0,
  links: 0,
  parsePending: false,
  letterOnFile: false,
  drafts: 0,
  requested: null
};

const facts = (overrides: Partial<ComeReadyFacts> = {}): ComeReadyFacts => ({ ...defaults, ...overrides });
const title = [{ title: 'Product Designer', liveCount: 77 }];
const key = { providerLabel: 'Anthropic', last4: '7Qk2' };
const statuses = (r: ReturnType<typeof buildComeReady>) => r.steps.map((s) => s.status);

describe('the paid flow', () => {
  it('arrives at 2 of 6 with step 3 next', () => {
    const r = buildComeReady(facts());
    expect(r.doneCount).toBe(2);
    expect(r.total).toBe(6);
    expect(statuses(r)).toEqual(['done', 'done', 'next', 'later', 'later', 'optional']);
    expect(r.active).toBe(3);
    expect(r.nextName).toBe('Name your titles');
    expect(r.steps[1].hint).toBe('Paid. $7.25 a month.');
  });

  it('checks off titles with the live count and moves to the key', () => {
    const r = buildComeReady(facts({ coreTitles: title }));
    expect(r.steps[2]).toEqual({
      n: 3,
      name: 'Name your titles',
      hint: 'Product Designer. 77 live tonight. The Desk turns on tonight.',
      stake: 'The Desk turns on tonight.',
      action: 'Name your titles',
      status: 'done',
      href: '/start?step=3'
    });
    expect(r.active).toBe(4);
  });

  it('checks off the key with its tail and moves to the resume', () => {
    const r = buildComeReady(facts({ coreTitles: title, key }));
    expect(r.steps[3].status).toBe('done');
    expect(r.steps[3].hint).toBe('Anthropic, key ends in 7Qk2.');
    expect(r.active).toBe(5);
  });

  it('reads the key as skipped and the resume as locked when the reader moved past it', () => {
    const r = buildComeReady(facts({ coreTitles: title, requested: '5' }));
    expect(r.steps[3].status).toBe('skipped');
    expect(r.steps[3].hint).toBe('Skipped. Reading and drafting wait on it.');
    expect(r.steps[4].status).toBe('locked');
    expect(r.steps[4].hint).toBe('Waits on a key.');
    expect(r.keySkipped).toBe(true);
    expect(r.active).toBe(5);
  });

  it('reads a resume in flight as reading', () => {
    const r = buildComeReady(facts({ coreTitles: title, key, parsePending: true }));
    expect(r.steps[4].status).toBe('reading');
    expect(r.steps[4].hint).toBe('Reading on your key.');
  });

  it('opens the door once titles, key and record are done, with the letter next', () => {
    const r = buildComeReady(facts({ coreTitles: title, key, entries: 9, links: 3 }));
    expect(r.steps[4].status).toBe('done');
    expect(r.steps[4].hint).toBe('9 entries, 3 links.');
    expect(r.steps[5].status).toBe('next');
    expect(r.active).toBe(6);
    expect(r.doorOpen).toBe(true);
    expect(r.complete).toBe(false);
  });

  it('is complete after the first draft', () => {
    const r = buildComeReady(facts({ coreTitles: title, key, entries: 9, links: 3, drafts: 1 }));
    expect(r.complete).toBe(true);
  });

  it('checks off the letter and lands on the door', () => {
    const r = buildComeReady(facts({ coreTitles: title, key, entries: 9, letterOnFile: true }));
    expect(r.steps[5].status).toBe('done');
    expect(r.steps[5].hint).toBe('Cover letter on file.');
    expect(r.active).toBe('door');
    expect(r.nextName).toBe('draft your first application');
  });

  it('pluralises one entry and one link', () => {
    const r = buildComeReady(facts({ coreTitles: title, key, entries: 1, links: 1 }));
    expect(r.steps[4].hint).toBe('1 entry, 1 link.');
  });

  it('follows a requested step and ignores an unknown one', () => {
    expect(buildComeReady(facts({ requested: 'door' })).active).toBe('door');
    expect(buildComeReady(facts({ requested: '9' })).active).toBe(3);
  });
});

describe('the free flow', () => {
  it('arrives at 3 of 4 with titles next when the email is verified', () => {
    const r = buildComeReady(facts({ edition: 'free' }));
    expect(r.total).toBe(4);
    expect(statuses(r)).toEqual(['done', 'done', 'done', 'next']);
    expect(r.active).toBe(4);
    expect(r.nextName).toBe('Name your titles');
    expect(r.steps[2].hint).toBe('Verified.');
  });

  it('puts the email first when it is not verified', () => {
    const r = buildComeReady(facts({ edition: 'free', emailVerified: false }));
    expect(r.steps[2].status).toBe('next');
    expect(r.active).toBe(3);
  });

  it("names the title with its live count in the board's menu, and the titles step is the last one", () => {
    const r = buildComeReady(facts({ edition: 'free', coreTitles: title }));
    expect(r.steps[3].hint).toBe("Product Designer. 77 live tonight, in the board's menu.");
    expect(r.steps).toHaveLength(4);
    expect(r.steps[3].status).toBe('done');
  });

  it('lands on the door once the titles are named, with nothing after them', () => {
    // 'Add a job by link' was removed as a step (owner, 2026-09-20), so naming
    // a title is the last thing the free flow asks for.
    const r = buildComeReady(facts({ edition: 'free', coreTitles: title }));
    expect(r.active).toBe('door');
    expect(r.nextStep).toBeNull();
    expect(r.nextName).toBe('what the paid account opens');
    expect(r.complete).toBe(false);
  });

  it('refuses a step 5 that no longer exists and falls back to the door', () => {
    const r = buildComeReady(facts({ edition: 'free', coreTitles: title, requested: '5' }));
    expect(r.active).toBe('door');
  });
});

describe('the waitlisted edition', () => {
  it('holds at 1 of 4 with admission waiting and no step to open', () => {
    const r = buildComeReady(facts({ edition: 'waitlisted', requested: '4' }));
    expect(statuses(r)).toEqual(['done', 'waiting', 'later', 'later']);
    expect(r.doneCount).toBe(1);
    expect(r.active).toBe('wait');
    expect(r.steps.every((s) => s.href === null)).toBe(true);
  });
});

describe('editionFor', () => {
  it('maps the ladder onto the three editions', () => {
    expect(editionFor('paid')).toBe('paid');
    expect(editionFor('internal')).toBe('paid');
    expect(editionFor('waitlisted')).toBe('waitlisted');
    expect(editionFor('member')).toBe('free');
    expect(editionFor('public')).toBe('free');
  });
});

describe("the band's next action", () => {
  // The Desk's band prints the model's own next name, stake and action, so
  // these three move together and a step can never be advertised with another
  // step's button.
  it('carries the next step on the paid flow', () => {
    const r = buildComeReady(facts({ coreTitles: title }));
    expect(r.nextName).toBe('Connect your key');
    expect(r.nextStake).toBe('Unlocks the resumé reader and drafting.');
    expect(r.nextAction).toBe('Connect your key');
    expect(r.nextHref).toBe('/start?step=4');
  });

  it('points at the door when the paid run has nothing left to check off', () => {
    // Every step done but no draft written: the run is not complete, and the
    // door is otherwise only reachable by typing its address.
    const r = buildComeReady(facts({ coreTitles: title, key, entries: 4, letterOnFile: true }));
    expect(r.nextStep).toBeNull();
    expect(r.complete).toBe(false);
    expect(r.nextAction).toBe('Draft your first application');
    expect(r.nextHref).toBe('/start?step=door');
  });

  it('carries the next step on the free flow', () => {
    const r = buildComeReady(facts({ edition: 'free' }));
    expect(r.nextName).toBe('Name your titles');
    expect(r.nextStake).toBe("The board's search cell learns your titles.");
    expect(r.nextHref).toBe('/start?step=4');
  });

  it('asks a finished free account to upgrade, since that is all it has left', () => {
    const r = buildComeReady(facts({ edition: 'free', coreTitles: title }));
    expect(r.nextStep).toBeNull();
    expect(r.doneCount).toBe(4);
    expect(r.total).toBe(4);
    expect(r.nextName).toBe('what the paid account opens');
    expect(r.nextAction).toBe('What paid opens');
    expect(r.nextHref).toBe('/the-account');
  });
});
