import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderInBackground,
  renderOneDocument,
  triggerBackgroundGeneration,
  triggerJobDraft,
  writingModelFor
} from './generation-preference-store';
import { generativeProvider } from './generation-providers';
import { _resetMasterSecretForTests } from './keychain';
import type { Job } from './data';

/** The mocked generativeProvider, typed for reading its recorded calls. */
const generativeProviderMock = vi.mocked(generativeProvider);

// The header-passthrough tests below reach renderInBackground() directly,
// with every I/O boundary it touches (record-store's reads, the tailor
// engine, the render store, the keychain) replaced by a mock. No db() is
// ever called, matching this suite's stated "reach the logic, open no
// connection" discipline: the mocks stand at the module boundary, not in
// place of this file's own database calls, so the real gathering logic
// (which header gets built, and that it is handed to both renders) runs for
// real. The named record-store reads are the new dependency this change
// adds, so this is where they are pinned.
const {
  renderResume,
  renderCover,
  listEntries,
  personName,
  listLinks,
  resolveResumeEmail,
  getDecryptedKey,
  completeDraft,
  failDraft,
  claimJobRender,
  getWritingModel
} = vi.hoisted(() => ({
  renderResume: vi.fn(),
  renderCover: vi.fn(),
  // One placeholder entry by default: enough to pass renderOneDocument's
  // empty-record guard so every suite below exercises the render path it was
  // written for. The mocked renderResume/renderCover never read it. The
  // empty-record suite overrides this to [] per call.
  listEntries: vi.fn(async () => [{ prfId: 'prf-1', kind: 'role_held' } as unknown]),
  personName: vi.fn(),
  listLinks: vi.fn(),
  resolveResumeEmail: vi.fn(),
  getDecryptedKey: vi.fn(),
  completeDraft: vi.fn(),
  failDraft: vi.fn(),
  claimJobRender: vi.fn(),
  getWritingModel: vi.fn()
}));

vi.mock('./record-store', () => ({
  listEntries,
  personName,
  listLinks,
  resolveResumeEmail,
  // No letter on file in these tests: the cover render gets no voice sample,
  // the same default the app carries until a person uploads one.
  getCoverLetter: vi.fn(async () => null)
}));

/** Render payloads WITH a body, the shape pdf-resume.ts's resumeHasBody() /
    coverHasBody() accept: renderOneDocument now fails a bodyless document
    instead of shipping it 'ready', so the fixtures the existing suites hand it
    must carry at least one section entry (resume) or a proof paragraph (cover). */
const resumeWithBody = { kind: 'resume', sections: [{ heading: 'Experience', entries: [{ bullets: [] }] }] };
const coverWithBody = { kind: 'cover', paragraphs: [{ role: 'proof', text: 'A proof paragraph.' }] };

vi.mock('./tailor', () => ({
  renderResume,
  renderCover
}));

const { beginJobDraft, beginJobDraftDocument, dispatchJobDraftRuns } = vi.hoisted(() => ({
  beginJobDraft: vi.fn(async () => ({ resumeId: 'job-resume-1', coverId: 'job-cover-1' })),
  beginJobDraftDocument: vi.fn(async () => ({ id: 'job-cover-2', reason: null as string | null })),
  // triggerJobDraft's hand-off and its deferral are the seams under test in the
  // triggerJobDraft describe below; mocked so no fetch and no waitUntil run.
  dispatchJobDraftRuns: vi.fn(async (_origin: string, _docs: readonly unknown[]) => [] as readonly unknown[])
}));
vi.mock('./generated-render-store', () => ({
  beginDraft: vi.fn(async () => ({ resumeId: 'resume-1', coverId: 'cover-1' })),
  beginJobDraft,
  beginJobDraftDocument,
  completeDraft,
  failDraft,
  claimJobRender
}));
vi.mock('./draft-run-dispatch', () => ({
  dispatchJobDraftRuns: (...args: [string, readonly unknown[]]) => dispatchJobDraftRuns(...args),
  selfOrigin: () => 'https://deployment.example'
}));
vi.mock('./defer-work', () => ({ deferWork: vi.fn() }));

vi.mock('./keychain-store', () => ({
  getDecryptedKey,
  keyMeta: vi.fn(async () => []),
  // Returns null unless a test says otherwise (see the beforeEach), so
  // writingModelFor() falls through to the mocked registry's
  // defaultWritingModel and these suites keep asserting the behaviour they
  // were written for.
  getWritingModel
}));

vi.mock('./generation-providers', () => ({
  generativeProvider: vi.fn(() => ({
    style: vi.fn(),
    styleLetter: vi.fn(),
    fallbackReasons: () => [],
    letterWarnings: () => [],
    usage: () => ({ inputTokens: 0, outputTokens: 0 })
  })),
  GENERATION_PROVIDER_ORDER: ['anthropic'],
  PROVIDER_REGISTRY: {
    anthropic: {
      label: 'Anthropic',
      copyModel: 'claude-copy-test',
      defaultWritingModel: 'claude-test',
      writingModels: [{ id: 'claude-test', label: 'Test', note: 'test' }]
    }
  }
}));

// generation-preference-store.ts is the impure half of the background
// generation trigger: getGenerationPreference(), setGenerationPreference()
// and the bulk of triggerBackgroundGeneration() all open a database
// connection, which is exactly the thing a worker in this repository is
// not allowed to do (constraint 3), so none of that is exercised here.
//
// WHAT IS SAFE TO PROVE WITH NO CONNECTION AT ALL, AND WHY IT MATTERS.
// triggerBackgroundGeneration() checks src/lib/keychain.ts's
// keyStorageIsConfigured() and src/lib/flags.ts's isOn('byok') FIRST,
// before ever calling db() (see that function's own header). With
// KEY_ENCRYPTION_SECRET deleted, exactly the state RUN-MASTER's own README
// describes for every environment this task could reach, that first check
// fails and the function returns without touching the database at all.
// This is the actual, honest shape of "the trigger is a no-op with no key
// configured, and shows no error" that the task's own brief asks be
// proved: not a mock standing in for a real gate, but the real gate,
// exercised for real, with the one environment variable it depends on
// deliberately unset the same way src/pages/account/keys/save.test.ts's
// own header explains doing for the identical function
// (keyStorageIsConfigured()/keyStorageIsConfigured-adjacent checks) one
// layer up.
//
// THE PREFERENCE-OFF AND NO-KEY BRANCHES ARE PROVED AT THE PURE LAYER
// INSTEAD. Both of those branches need a database read
// (getGenerationPreference(), keyMeta()) to even learn the answer they are
// branching on, so they cannot be reached from here without a live
// connection or a mock of this file's own database calls; this suite does
// neither, matching desk-store.test.ts's and record-store.test.ts's own
// stated discipline of leaving a store's I/O-touching functions untested
// beyond what runs before the first db() call. Those two branches, and
// the "everything is on" branch, are proved instead as plain boolean logic
// in generation-preference.test.ts, which is what decideGenerationTrigger()
// actually is: this file only ever gathers inputs for it and gets out of
// the way.

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

describe('triggerBackgroundGeneration(): fails safe with no database at all', () => {
  const priorSecret = process.env.KEY_ENCRYPTION_SECRET;

  afterEach(() => {
    if (priorSecret === undefined) delete process.env.KEY_ENCRYPTION_SECRET;
    else process.env.KEY_ENCRYPTION_SECRET = priorSecret;
    _resetMasterSecretForTests();
  });

  it('is a no-op, and never touches the database, when KEY_ENCRYPTION_SECRET is unset', async () => {
    delete process.env.KEY_ENCRYPTION_SECRET;
    _resetMasterSecretForTests();

    // No database connection exists in this test environment at all
    // (constraint 3); if triggerBackgroundGeneration() called db() here,
    // this test would hang or throw on a missing connection string
    // instead of resolving cleanly. Resolving is the proof.
    // applicationId (the second argument, added alongside db/012_drafting.sql's
    // generated_render table) is never read on this path: the two free
    // gates return before beginDraft() or renderInBackground() would ever
    // see it, so any number here proves the same thing a real application
    // id would.
    const outcome = await triggerBackgroundGeneration('user_1', 1, job());

    expect(outcome.go).toBe(false);
    expect(outcome.go === false && outcome.reason).toMatch(/KEY_ENCRYPTION_SECRET/);
  });

  it('never throws or rejects for that same case, matching "no error shown"', async () => {
    delete process.env.KEY_ENCRYPTION_SECRET;
    _resetMasterSecretForTests();

    await expect(triggerBackgroundGeneration('user_1', 1, job())).resolves.toBeDefined();
  });
});

describe('renderInBackground(): the contact header reaches both documents, both paths', () => {
  const HEADER = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    links: [{ label: 'GitHub', url: 'https://github.com/ada' }]
  };

  beforeEach(() => {
    vi.clearAllMocks();
    personName.mockResolvedValue({ firstName: 'Ada', lastName: 'Lovelace' });
    listLinks.mockResolvedValue([
      { id: 'link-1', platform: 'github', url: 'https://github.com/ada', createdAt: new Date(0) }
    ]);
    resolveResumeEmail.mockResolvedValue('ada@example.com');
    renderResume.mockResolvedValue(resumeWithBody);
    renderCover.mockResolvedValue(coverWithBody);
    getWritingModel.mockResolvedValue(null);
  });

  it('happy path: the header built from personName()/listLinks() is the trailing arg to both renders', async () => {
    getDecryptedKey.mockResolvedValue('a-decrypted-key');

    await renderInBackground('user_1', 1, job(), 'anthropic', 'resume-1', 'cover-1');

    // renderResume(entries, target, provider, header): header is arg index 3.
    expect(renderResume).toHaveBeenCalledTimes(1);
    expect(renderResume.mock.calls[0][3]).toEqual(HEADER);
    // The email resolved by resolveResumeEmail() rides on that same header.
    expect(renderResume.mock.calls[0][3].email).toBe('ada@example.com');

    // renderCover(entries, target, provider, voice, header): header is arg index 4.
    expect(renderCover).toHaveBeenCalledTimes(1);
    expect(renderCover.mock.calls[0][4]).toEqual(HEADER);
    expect(renderCover.mock.calls[0][4].email).toBe('ada@example.com');
  });

  it('fallback path: a key that will not decrypt still yields a header-carrying deterministic re-render', async () => {
    // getDecryptedKey() returning null is the "key removed between two reads"
    // case renderInBackground() throws on, sending it into the catch block's
    // one deterministic re-render. That path must not render a header-less
    // document while the happy path renders one: it re-fetches and re-attaches.
    getDecryptedKey.mockResolvedValue(null);

    await renderInBackground('user_1', 1, job(), 'anthropic', 'resume-1', 'cover-1');

    expect(renderResume).toHaveBeenCalledTimes(1);
    // Deterministic re-render: provider left as the default (undefined), header
    // still handed in as the trailing arg.
    expect(renderResume.mock.calls[0][2]).toBeUndefined();
    expect(renderResume.mock.calls[0][3]).toEqual(HEADER);
    expect(renderResume.mock.calls[0][3].email).toBe('ada@example.com');

    expect(renderCover).toHaveBeenCalledTimes(1);
    expect(renderCover.mock.calls[0][2]).toBeUndefined();
    expect(renderCover.mock.calls[0][4]).toEqual(HEADER);
    expect(renderCover.mock.calls[0][4].email).toBe('ada@example.com');
  });

  it('a person with neither name part set renders header.name as null, links still carried', async () => {
    personName.mockResolvedValue({ firstName: '', lastName: '' });
    getDecryptedKey.mockResolvedValue('a-decrypted-key');

    await renderInBackground('user_1', 1, job(), 'anthropic', 'resume-1', 'cover-1');

    expect(renderResume.mock.calls[0][3]).toEqual({
      name: null,
      email: 'ada@example.com',
      links: [{ label: 'GitHub', url: 'https://github.com/ada' }]
    });
  });
});

describe('the one-click button drafts each document, key or no key', () => {
  // These once went through renderJobDraftInBackground(), a pair helper now
  // removed; the button drafts each document through its own renderOneDocument()
  // (dispatched or in-process), so the two calls here are that pair.
  beforeEach(() => {
    vi.clearAllMocks();
    personName.mockResolvedValue({ firstName: 'Ada', lastName: 'Lovelace' });
    listLinks.mockResolvedValue([]);
    resolveResumeEmail.mockResolvedValue('ada@example.com');
    renderResume.mockResolvedValue(resumeWithBody);
    renderCover.mockResolvedValue(coverWithBody);
    completeDraft.mockResolvedValue(undefined);
    getWritingModel.mockResolvedValue(null);
  });

  it('no key: drafts deterministically and labels both documents fallback, provider null', async () => {
    // provider === null is the no-key case: the button drafts anyway, which is
    // the difference from the apply path (that one would have skipped).
    await renderOneDocument({ userId: 'user_1', job: job(), kind: 'resume', renderId: 'r-1', provider: null, reason: null });
    await renderOneDocument({ userId: 'user_1', job: job(), kind: 'cover', renderId: 'c-1', provider: null, reason: null });

    // Deterministic: the provider argument is left as tailor.ts's own default.
    expect(renderResume).toHaveBeenCalledTimes(1);
    expect(renderResume.mock.calls[0][2]).toBeUndefined();
    expect(renderCover).toHaveBeenCalledTimes(1);
    expect(renderCover.mock.calls[0][2]).toBeUndefined();

    // Both rows complete as 'fallback' with no provider named, which is what the
    // result page reads as "the built-in writer drafted this".
    const statuses = completeDraft.mock.calls.map((call) => (call[1] as { status: string }).status);
    expect(statuses).toEqual(['fallback', 'fallback']);
    for (const call of completeDraft.mock.calls) {
      expect((call[1] as { provider: string | null }).provider).toBeNull();
    }
    // The two ids the button minted are the two rows completed.
    expect(completeDraft.mock.calls.map((call) => call[0]).sort()).toEqual(['c-1', 'r-1']);
  });

  it('with a working key: drafts through the provider and labels both ready', async () => {
    getDecryptedKey.mockResolvedValue('a-decrypted-key');

    await renderOneDocument({ userId: 'user_1', job: job(), kind: 'resume', renderId: 'r-1', provider: 'anthropic', reason: null });
    await renderOneDocument({ userId: 'user_1', job: job(), kind: 'cover', renderId: 'c-1', provider: 'anthropic', reason: null });

    // The generative provider is handed in (arg index 2), not the deterministic
    // default, and with no fallback reasons the rows settle 'ready'.
    expect(renderResume.mock.calls[0][2]).toBeDefined();
    const statuses = completeDraft.mock.calls.map((call) => (call[1] as { status: string }).status);
    expect(statuses).toEqual(['ready', 'ready']);
    for (const call of completeDraft.mock.calls) {
      expect((call[1] as { provider: string | null }).provider).toBe('anthropic');
    }
  });
});

describe('renderOneDocument(): one document, one row, and the template never stands in for a tried key', () => {
  const base = { userId: 'user_1', job: job(), provider: 'anthropic' as const, reason: 'I like the craft.' };

  beforeEach(() => {
    vi.clearAllMocks();
    personName.mockResolvedValue({ firstName: 'Ada', lastName: 'Lovelace' });
    listLinks.mockResolvedValue([]);
    resolveResumeEmail.mockResolvedValue('ada@example.com');
    renderResume.mockResolvedValue(resumeWithBody);
    renderCover.mockResolvedValue(coverWithBody);
    completeDraft.mockResolvedValue(undefined);
    failDraft.mockResolvedValue(undefined);
    getWritingModel.mockResolvedValue(null);
    getDecryptedKey.mockResolvedValue('a-decrypted-key');
  });

  it('cover: the person\'s note reaches renderCover in its inputs, with the provider; the resume never sees it', async () => {
    await renderOneDocument({ ...base, kind: 'cover', renderId: 'c-1' });
    expect(renderCover).toHaveBeenCalledTimes(1);
    expect(renderCover.mock.calls[0][2]).toBeDefined();
    expect(renderCover.mock.calls[0][5]).toEqual({ reason: 'I like the craft.' });
    expect(renderResume).not.toHaveBeenCalled();
    expect(completeDraft).toHaveBeenCalledWith('c-1', expect.objectContaining({ status: 'ready', provider: 'anthropic' }));

    vi.clearAllMocks();
    getDecryptedKey.mockResolvedValue('a-decrypted-key');
    await renderOneDocument({ ...base, kind: 'resume', renderId: 'r-1' });
    expect(renderResume).toHaveBeenCalledTimes(1);
    expect(renderCover).not.toHaveBeenCalled();
    expect(JSON.stringify(renderResume.mock.calls[0])).not.toContain('I like the craft.');
  });

  it('a tried provider that could not deliver FAILS the row with the reason, and never writes the template', async () => {
    generativeProviderMock.mockReturnValueOnce({
      style: vi.fn(),
      styleLetter: vi.fn(),
      fallbackReasons: () => ['the live provider call failed (timed out)'],
      letterWarnings: () => []
    } as never);

    await renderOneDocument({ ...base, kind: 'cover', renderId: 'c-1' });

    expect(failDraft).toHaveBeenCalledWith('c-1', 'the live provider call failed (timed out)');
    expect(completeDraft).not.toHaveBeenCalled();
  });

  it('a key that will not read back FAILS the row rather than drafting deterministically', async () => {
    getDecryptedKey.mockResolvedValue(null);
    await renderOneDocument({ ...base, kind: 'resume', renderId: 'r-1' });
    expect(failDraft).toHaveBeenCalledWith('r-1', 'the connected key could not be read back');
    expect(completeDraft).not.toHaveBeenCalled();
    expect(renderResume).not.toHaveBeenCalled();
  });

  it('no key at all (provider null) is the one path that still drafts with the built-in writer, as fallback', async () => {
    await renderOneDocument({ ...base, provider: null, kind: 'resume', renderId: 'r-1' });
    expect(renderResume.mock.calls[0][2]).toBeUndefined();
    expect(completeDraft).toHaveBeenCalledWith('r-1', expect.objectContaining({ status: 'fallback', provider: null, model: null }));
    expect(failDraft).not.toHaveBeenCalled();
  });

  it('a render that throws FAILS the row and never rejects', async () => {
    renderCover.mockRejectedValue(new Error('database gone'));
    await expect(renderOneDocument({ ...base, kind: 'cover', renderId: 'c-1' })).resolves.toBeUndefined();
    expect(failDraft).toHaveBeenCalledWith('c-1', 'the draft could not be rendered');
    expect(completeDraft).not.toHaveBeenCalled();
  });
});

describe('triggerJobDraft(): a per-document retry restarts only that one document', () => {
  const origin = new URL('https://deployment.example/jobs/desk/job-draft');

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchJobDraftRuns.mockResolvedValue([]);
    beginJobDraftDocument.mockResolvedValue({ id: 'job-cover-2', reason: null });
  });

  it('with kind cover: begins just the cover document, dispatches one doc, never touches the pair begin', async () => {
    const result = await triggerJobDraft('user_1', job(), { reason: 'the craft', origin, kind: 'cover' });

    expect(beginJobDraftDocument).toHaveBeenCalledTimes(1);
    expect(beginJobDraftDocument).toHaveBeenCalledWith('user_1', job().slug, 'cover', 'the craft');
    expect(beginJobDraft).not.toHaveBeenCalled();
    const dispatched = dispatchJobDraftRuns.mock.calls[0][1] as ReadonlyArray<{ kind: string; renderId: string }>;
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].kind).toBe('cover');
    expect(result).toEqual({ resumeId: null, coverId: 'job-cover-2' });
  });

  it('with no kind: begins the pair, dispatches both, never the single-document begin', async () => {
    await triggerJobDraft('user_1', job(), { reason: 'the craft', origin });
    expect(beginJobDraft).toHaveBeenCalledTimes(1);
    expect(beginJobDraftDocument).not.toHaveBeenCalled();
    const dispatched = dispatchJobDraftRuns.mock.calls[0][1] as ReadonlyArray<{ kind: string }>;
    expect(dispatched.map((d) => d.kind).sort()).toEqual(['cover', 'resume']);
  });
});

describe('writingModelFor(): the person chooses, and a retired choice heals itself', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWritingModel.mockResolvedValue(null);
  });

  it('returns the provider default when nothing was chosen', async () => {
    await expect(writingModelFor('user_1', 'anthropic')).resolves.toBe('claude-test');
  });

  it('returns the stored choice when there is one', async () => {
    getWritingModel.mockResolvedValue('claude-chosen');
    await expect(writingModelFor('user_1', 'anthropic')).resolves.toBe('claude-chosen');
  });

  it('falls back to the default when the stored choice is no longer offered', async () => {
    // getWritingModel() is the layer that validates a stored id against the
    // registry and answers null for one that has been retired. This is the
    // behaviour that matters on the day a provider drops a model: everyone
    // who picked it quietly returns to the default rather than having their
    // drafts fail against an id the API no longer knows.
    getWritingModel.mockResolvedValue(null);
    await expect(writingModelFor('user_1', 'anthropic')).resolves.toBe('claude-test');
  });
});

describe('the drafting audit row records the model that actually ran', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    personName.mockResolvedValue({ firstName: 'Ada', lastName: 'Lovelace' });
    listLinks.mockResolvedValue([]);
    resolveResumeEmail.mockResolvedValue('ada@example.com');
    renderResume.mockResolvedValue(resumeWithBody);
    renderCover.mockResolvedValue(coverWithBody);
    completeDraft.mockResolvedValue(undefined);
    getDecryptedKey.mockResolvedValue('a-decrypted-key');
  });

  // Before the model became a choice, both draft paths computed a model for
  // the audit row and never passed it to the provider: the recorded model and
  // the used model agreed only by coincidence. A person choosing their own
  // model breaks that coincidence, so these pin that one value goes to both
  // places. A provenance record that names a model that did not run is worse
  // than no record.
  it('apply path: the chosen model reaches the provider and the stored row', async () => {
    getWritingModel.mockResolvedValue('claude-chosen');

    await renderInBackground('user_1', 1, job(), 'anthropic', 'resume-1', 'cover-1');

    for (const call of generativeProviderMock.mock.calls) {
      // The apply path has no steer panel, so it passes steer: null alongside
      // the model (the field exists so this render site carries a steer the
      // same way the job-draft render site does).
      expect(call[2]).toEqual({ model: 'claude-chosen', steer: null });
    }
    for (const call of completeDraft.mock.calls) {
      expect((call[1] as { model: string | null }).model).toBe('claude-chosen');
    }
  });

  it('job draft path: the chosen model reaches the provider and the stored row', async () => {
    getWritingModel.mockResolvedValue('claude-chosen');

    await renderOneDocument({ userId: 'user_1', job: job(), kind: 'resume', renderId: 'r-1', provider: 'anthropic', reason: null });
    await renderOneDocument({ userId: 'user_1', job: job(), kind: 'cover', renderId: 'c-1', provider: 'anthropic', reason: null });

    for (const call of generativeProviderMock.mock.calls) {
      expect(call[2]).toEqual({ model: 'claude-chosen', steer: undefined });
    }
    for (const call of completeDraft.mock.calls) {
      expect((call[1] as { model: string | null }).model).toBe('claude-chosen');
    }
  });
});

describe('renderOneDocument(): an empty record fails honestly, before any provider call', () => {
  const base = { userId: 'user_1', job: job(), provider: 'anthropic' as const, reason: null };

  beforeEach(() => {
    vi.clearAllMocks();
    personName.mockResolvedValue({ firstName: 'Ada', lastName: 'Lovelace' });
    listLinks.mockResolvedValue([]);
    resolveResumeEmail.mockResolvedValue('ada@example.com');
    renderResume.mockResolvedValue(resumeWithBody);
    renderCover.mockResolvedValue(coverWithBody);
    completeDraft.mockResolvedValue(undefined);
    failDraft.mockResolvedValue(undefined);
    getWritingModel.mockResolvedValue(null);
    getDecryptedKey.mockResolvedValue('a-decrypted-key');
  });

  it('no entries + a connected key: fails the resume naming the Profile Record, and spends no tokens', async () => {
    listEntries.mockResolvedValueOnce([]);

    await renderOneDocument({ ...base, kind: 'resume', renderId: 'r-1' });

    expect(failDraft).toHaveBeenCalledTimes(1);
    expect(failDraft.mock.calls[0][0]).toBe('r-1');
    expect(failDraft.mock.calls[0][1]).toEqual(expect.stringContaining('Profile Record has no entries'));
    // The guard sits before the key is read and before the provider is built:
    // the whole point is that an empty record costs nothing.
    expect(getDecryptedKey).not.toHaveBeenCalled();
    expect(generativeProviderMock).not.toHaveBeenCalled();
    expect(renderResume).not.toHaveBeenCalled();
    expect(completeDraft).not.toHaveBeenCalled();
  });

  it('no entries, no key (deterministic writer): still fails, never renders', async () => {
    listEntries.mockResolvedValueOnce([]);

    await renderOneDocument({ ...base, provider: null, kind: 'resume', renderId: 'r-1' });

    expect(failDraft).toHaveBeenCalledTimes(1);
    expect(failDraft.mock.calls[0][1]).toEqual(expect.stringContaining('Profile Record has no entries'));
    expect(renderResume).not.toHaveBeenCalled();
    expect(completeDraft).not.toHaveBeenCalled();
  });

  it('no entries: the cover letter fails the same way, without a render', async () => {
    listEntries.mockResolvedValueOnce([]);

    await renderOneDocument({ ...base, kind: 'cover', renderId: 'c-1' });

    expect(failDraft).toHaveBeenCalledTimes(1);
    expect(failDraft.mock.calls[0][0]).toBe('c-1');
    expect(renderCover).not.toHaveBeenCalled();
    expect(completeDraft).not.toHaveBeenCalled();
  });

  it('entries present but the resume renders with no sections: fails as empty, never ships ready (deterministic path)', async () => {
    renderResume.mockResolvedValue({ kind: 'resume', sections: [] });

    await renderOneDocument({ ...base, provider: null, kind: 'resume', renderId: 'r-1' });

    expect(failDraft).toHaveBeenCalledTimes(1);
    expect(failDraft.mock.calls[0][1]).toEqual(expect.stringContaining('came out empty'));
    expect(completeDraft).not.toHaveBeenCalled();
  });

  it('entries present but the resume renders with no sections: fails as empty on the provider path too', async () => {
    renderResume.mockResolvedValue({ kind: 'resume', sections: [] });

    await renderOneDocument({ ...base, kind: 'resume', renderId: 'r-1' });

    expect(failDraft).toHaveBeenCalledTimes(1);
    expect(failDraft.mock.calls[0][1]).toEqual(expect.stringContaining('came out empty'));
    expect(completeDraft).not.toHaveBeenCalled();
  });

  it('entries present and a real body: ships ready exactly as before', async () => {
    await renderOneDocument({ ...base, kind: 'resume', renderId: 'r-1' });

    expect(failDraft).not.toHaveBeenCalled();
    expect(completeDraft).toHaveBeenCalledTimes(1);
    expect((completeDraft.mock.calls[0][1] as { status: string }).status).toBe('ready');
  });
});
