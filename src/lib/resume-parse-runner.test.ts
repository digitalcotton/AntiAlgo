import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provider } from './keychain';
import type { ResumeProposals } from './resume-parse';
import type { StoredParseOutcome } from './resume-parse-store';

// parseInBackground() is the background read at the heart of the resume parse:
// it decrypts the key at the one moment it is needed, reads with the provider,
// and on any provider failure falls back to the deterministic reader with the
// reason shown. It is exported for exactly this test (there is no other
// production caller than startResumeParse). Every module it touches that would
// open a database connection or a network socket is mocked here (constraint 3:
// no pg connection, no network from this worker); PROVIDER_REGISTRY is left
// real, because parseInBackground reads .label/.copyModel off it and those
// are the real strings the review page's provider note is built from. The
// resume read uses copyModel (the pinned low tier), never a writing model:
// see the two-tier note in generation-providers.ts.

const getDecryptedKey = vi.fn(async (..._args: unknown[]) => null as string | null);
const keyMeta = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock('./keychain-store', () => ({
  getDecryptedKey: (...args: unknown[]) => getDecryptedKey(...args),
  keyMeta: (...args: unknown[]) => keyMeta(...args)
}));

const parseResumeWithProvider = vi.fn(async (..._args: unknown[]) => ({ ok: false, reason: 'not set' }) as unknown);
const parseResumeDeterministic = vi.fn(
  (..._args: unknown[]) => ({ proposals: { entries: [], links: [], name: null }, notes: [] }) as unknown
);
vi.mock('./resume-parse', () => ({
  parseResumeWithProvider: (...args: unknown[]) => parseResumeWithProvider(...args),
  parseResumeDeterministic: (...args: unknown[]) => parseResumeDeterministic(...args)
}));

const beginParse = vi.fn(async (..._args: unknown[]) => {});
const completeParse = vi.fn(async (..._args: unknown[]) => {});
const clearParse = vi.fn(async (..._args: unknown[]) => {});
vi.mock('./resume-parse-store', () => ({
  beginParse: (...args: unknown[]) => beginParse(...args),
  completeParse: (...args: unknown[]) => completeParse(...args),
  clearParse: (...args: unknown[]) => clearParse(...args)
}));

// The read now lands in the record the moment it completes
// (resume-parse-apply.ts). Mocked so no createEntry/addLink opens a
// connection; what is proved here is the ORDER: complete, apply, then clear,
// and that a failed apply leaves the row for review rather than clearing it.
const applyParsedProposals = vi.fn(
  async (..._args: unknown[]) => ({ created: 0, failed: 0, links: 0, name: false, createdIds: [] as string[] })
);
vi.mock('./resume-parse-apply', () => ({
  applyParsedProposals: (...args: unknown[]) => applyParsedProposals(...args)
}));

// The import is deferred until after the mock-backing vi.fns above are
// initialized, the same shape test/pages/desk/application.test.ts uses so its
// own non-async mock factories can close over the outer vi.fns without a
// temporal-dead-zone read. generation-providers is NOT mocked at all, which is
// how PROVIDER_REGISTRY stays real.
const { parseInBackground } = await import('./resume-parse-runner');

/** A distinct object per test, so an assertion that an outcome carried THIS
    deterministic proposal set (toBe, by reference) proves it came from
    parseResumeDeterministic and not from anywhere else. */
function freshDeterministic(): { proposals: ResumeProposals; notes: readonly string[] } {
  return { proposals: { entries: [], links: [], name: null }, notes: [] };
}

function outcomeFromLastComplete(): StoredParseOutcome {
  expect(completeParse).toHaveBeenCalledTimes(1);
  const [, outcome] = completeParse.mock.calls[0] as [string, StoredParseOutcome];
  return outcome;
}

describe('parseInBackground', () => {
  beforeEach(() => {
    getDecryptedKey.mockReset();
    parseResumeWithProvider.mockReset();
    parseResumeDeterministic.mockReset();
    beginParse.mockReset();
    completeParse.mockReset();
    // Safe defaults; each test overrides what it cares about.
    getDecryptedKey.mockResolvedValue(null);
    parseResumeDeterministic.mockReturnValue(freshDeterministic());
  });

  it('a: a provider read that works completes an llm outcome with the provider label and no fallback', async () => {
    const proposals: ResumeProposals = { entries: [], links: [], name: null };
    const notes = ['Read 0 entries from your resume.'];
    getDecryptedKey.mockResolvedValue('sk-ant-a-real-enough-key-000000');
    parseResumeWithProvider.mockResolvedValue({ ok: true, proposals, notes });

    await parseInBackground('user_1', 'a resume', 'anthropic' as Provider);

    const outcome = outcomeFromLastComplete();
    const [userId] = completeParse.mock.calls[0] as [string, StoredParseOutcome];
    expect(userId).toBe('user_1');
    expect(outcome.method).toBe('llm');
    // The label is the real PROVIDER_REGISTRY['anthropic'].label, folded into
    // the "provider (model)" string the review page renders.
    expect(typeof outcome.providerLabel).toBe('string');
    expect(outcome.providerLabel).toContain('Anthropic');
    expect((outcome.providerLabel ?? '').length).toBeGreaterThan(0);
    expect(outcome.fallbackReason).toBeNull();
    expect(outcome.proposals).toBe(proposals);
    expect(outcome.notes).toBe(notes);
  });

  it('b: a provider read that fails falls back to deterministic with the failure reason surfaced', async () => {
    const deterministic = freshDeterministic();
    getDecryptedKey.mockResolvedValue('sk-ant-a-real-enough-key-000000');
    parseResumeWithProvider.mockResolvedValue({ ok: false, reason: 'nope' });
    parseResumeDeterministic.mockReturnValue(deterministic);

    await parseInBackground('user_1', 'a resume', 'anthropic' as Provider);

    const outcome = outcomeFromLastComplete();
    expect(outcome.method).toBe('deterministic');
    expect(outcome.providerLabel).toBeNull();
    expect(outcome.fallbackReason).toBe('nope');
    expect(outcome.proposals).toBe(deterministic.proposals);
    expect(outcome.notes).toBe(deterministic.notes);
  });

  it('c: a key removed between selection and decrypt falls back with a non-null reason, never calling the provider', async () => {
    const deterministic = freshDeterministic();
    getDecryptedKey.mockResolvedValue(null);
    parseResumeDeterministic.mockReturnValue(deterministic);

    await parseInBackground('user_1', 'a resume', 'anthropic' as Provider);

    const outcome = outcomeFromLastComplete();
    expect(outcome.method).toBe('deterministic');
    expect(typeof outcome.fallbackReason).toBe('string');
    expect(outcome.fallbackReason).not.toBeNull();
    expect(outcome.proposals).toBe(deterministic.proposals);
    // The provider read never fired: there was no key to fire it with.
    expect(parseResumeWithProvider).not.toHaveBeenCalled();
  });

  it('d: no provider at all is a plain deterministic read, which is not a fallback (reason null)', async () => {
    const deterministic = freshDeterministic();
    parseResumeDeterministic.mockReturnValue(deterministic);

    await parseInBackground('user_1', 'a resume', null);

    const outcome = outcomeFromLastComplete();
    expect(outcome.method).toBe('deterministic');
    expect(outcome.fallbackReason).toBeNull();
    expect(outcome.proposals).toBe(deterministic.proposals);
    // No provider means no decrypt attempt at all.
    expect(getDecryptedKey).not.toHaveBeenCalled();
  });

  it('e: the no-key path completes exactly the proposals and notes parseResumeDeterministic returned', async () => {
    const deterministic = { proposals: { entries: [], links: [], name: null } as ResumeProposals, notes: [] as string[] };
    parseResumeDeterministic.mockReturnValue(deterministic);

    await parseInBackground('user_1', 'a resume', null);

    const outcome = outcomeFromLastComplete();
    expect(outcome.proposals).toBe(deterministic.proposals);
    expect(outcome.notes).toBe(deterministic.notes);
    expect(parseResumeDeterministic).toHaveBeenCalledTimes(1);
    expect(parseResumeDeterministic).toHaveBeenCalledWith('a resume');
  });
});

describe('parseInBackground: a finished read lands in the record, then the buffer clears', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseResumeDeterministic.mockImplementation(() => freshDeterministic());
    applyParsedProposals.mockResolvedValue({ created: 2, failed: 0, links: 1, name: true, createdIds: ['a', 'b'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('f: applies the completed outcome proposals, and only then clears the parse', async () => {
    await parseInBackground('user_1', 'some resume text', null);

    const outcome = outcomeFromLastComplete();
    expect(applyParsedProposals).toHaveBeenCalledTimes(1);
    expect(applyParsedProposals.mock.calls[0][0]).toBe('user_1');
    expect(applyParsedProposals.mock.calls[0][1]).toBe(outcome.proposals);
    expect(clearParse).toHaveBeenCalledTimes(1);
    // Order: complete, apply, clear.
    const order = [
      completeParse.mock.invocationCallOrder[0],
      applyParsedProposals.mock.invocationCallOrder[0],
      clearParse.mock.invocationCallOrder[0]
    ];
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it('g: a failed apply leaves the row for review: completed, never cleared', async () => {
    applyParsedProposals.mockRejectedValueOnce(new Error('write failed'));

    await parseInBackground('user_1', 'some resume text', null);

    expect(completeParse).toHaveBeenCalledTimes(1);
    expect(clearParse).not.toHaveBeenCalled();
  });
});
