import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeProposals } from './resume-parse';

// applyParsedProposals() writes a finished read into the record without a
// confirm click. The store is mocked (no connection); validateEntry and the
// link validators run for real, because "re-validated from scratch" is the
// contract this module inherits from the confirm endpoint it replaces.

const { createEntry, addLink, personName, setPersonName } = vi.hoisted(() => ({
  createEntry: vi.fn(),
  addLink: vi.fn(),
  personName: vi.fn(),
  setPersonName: vi.fn()
}));
vi.mock('./record-store', () => ({ createEntry, addLink, personName, setPersonName }));

const { getParse, clearParse } = vi.hoisted(() => ({
  getParse: vi.fn(),
  clearParse: vi.fn()
}));
vi.mock('./resume-parse-store', () => ({ getParse, clearParse }));

import { applyParsedProposals, landReadyParse } from './resume-parse-apply';

function validCandidate(title: string) {
  return {
    kind: 'role_held' as const,
    employerOrInstitution: 'Acme Corp',
    officialTitle: title,
    start: { year: 2020, month: null },
    end: null,
    location: null,
    description: '',
    classification: 'private' as const,
    artifacts: []
  };
}

function proposals(over: Partial<ResumeProposals> = {}): ResumeProposals {
  return { entries: [], links: [], name: null, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  createEntry.mockImplementation(async (_userId: string, input: { officialTitle: string }) => ({ prfId: `prf-${input.officialTitle}` }));
  addLink.mockResolvedValue({});
  personName.mockResolvedValue(null);
  setPersonName.mockResolvedValue(true);
  getParse.mockResolvedValue(null);
  clearParse.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('landReadyParse(): a read still waiting in the buffer lands on the next visit', () => {
  function readyParse(entries: ReturnType<typeof validCandidate>[]) {
    return {
      status: 'ready',
      sourceName: 'resume.pdf',
      updatedAt: new Date(),
      outcome: {
        method: 'deterministic',
        providerLabel: null,
        fallbackReason: null,
        notes: [],
        proposals: proposals({
          entries: entries.map((candidate) => ({ candidate, sourceQuotes: {} })),
          links: [{ platform: 'portfolio', url: 'https://uxmonopoly.com/' }]
        })
      }
    };
  }

  it('applies a ready read, clears the buffer, and returns what landed', async () => {
    getParse.mockResolvedValue(readyParse([validCandidate('Designer'), validCandidate('Lead')]));
    const result = await landReadyParse('user_1');
    expect(result).not.toBeNull();
    expect(result?.created).toBe(2);
    expect(result?.links).toBe(1);
    expect(createEntry).toHaveBeenCalledTimes(2);
    expect(clearParse).toHaveBeenCalledWith('user_1');
    // Land, then clear: never the other way round.
    expect(createEntry.mock.invocationCallOrder[1]).toBeLessThan(clearParse.mock.invocationCallOrder[0]);
  });

  it('nothing waiting, or a read still running, touches nothing and returns null', async () => {
    getParse.mockResolvedValue(null);
    expect(await landReadyParse('user_1')).toBeNull();
    getParse.mockResolvedValue({ status: 'pending', sourceName: null, updatedAt: new Date(), outcome: null });
    expect(await landReadyParse('user_1')).toBeNull();
    expect(createEntry).not.toHaveBeenCalled();
    expect(clearParse).not.toHaveBeenCalled();
  });

  it('a buffer that cannot be read is logged and left, never thrown', async () => {
    getParse.mockRejectedValue(new Error('db down'));
    await expect(landReadyParse('user_1')).resolves.toBeNull();
    expect(clearParse).not.toHaveBeenCalled();
  });
});

describe('applyParsedProposals(): a finished read lands in the record', () => {
  it('creates one entry per valid proposal and returns their ids in order', async () => {
    const result = await applyParsedProposals('user_1', proposals({
      entries: [
        { candidate: validCandidate('Designer'), sourceQuotes: {} },
        { candidate: validCandidate('Lead'), sourceQuotes: {} }
      ]
    }));
    expect(createEntry).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.createdIds).toEqual(['prf-Designer', 'prf-Lead']);
  });

  it('a candidate that no longer validates is counted failed, not written, and never throws', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken = { ...validCandidate('Broken'), start: undefined } as any;
    const result = await applyParsedProposals('user_1', proposals({
      entries: [
        { candidate: broken, sourceQuotes: {} },
        { candidate: validCandidate('Fine'), sourceQuotes: {} }
      ]
    }));
    expect(createEntry).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('a write that throws is counted failed and the rest still land', async () => {
    createEntry
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce({ prfId: 'prf-2' });
    const result = await applyParsedProposals('user_1', proposals({
      entries: [
        { candidate: validCandidate('One'), sourceQuotes: {} },
        { candidate: validCandidate('Two'), sourceQuotes: {} }
      ]
    }));
    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.createdIds).toEqual(['prf-2']);
  });

  it('adds each link through the platform and url validators', async () => {
    const result = await applyParsedProposals('user_1', proposals({
      links: [
        { platform: 'portfolio', url: 'https://uxmonopoly.com/' },
        { platform: 'portfolio', url: 'javascript:alert(1)' }
      ]
    }));
    expect(addLink).toHaveBeenCalledTimes(1);
    expect(addLink.mock.calls[0][1]).toBe('portfolio');
    expect(result.links).toBe(1);
  });

  it('sets the name only when the profile has none', async () => {
    const first = await applyParsedProposals('user_1', proposals({ name: { first: 'Ada', last: 'Lovelace' } }));
    expect(setPersonName).toHaveBeenCalledWith('user_1', 'Ada', 'Lovelace');
    expect(first.name).toBe(true);

    vi.clearAllMocks();
    personName.mockResolvedValue({ firstName: 'Grace', lastName: 'Hopper' });
    const second = await applyParsedProposals('user_1', proposals({ name: { first: 'Ada', last: 'Lovelace' } }));
    expect(setPersonName).not.toHaveBeenCalled();
    expect(second.name).toBe(false);
  });
});
