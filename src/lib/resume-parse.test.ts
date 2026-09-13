import { describe, expect, it } from 'vitest';
import {
  buildProposalsFromModelJson,
  parseResumeDeterministic,
  parseResumeWithProvider,
  type ProviderCall
} from './resume-parse';
import {
  GENERATION_PROVIDER_ORDER,
  GenerationCallError,
  PROVIDER_REGISTRY
} from './generation-providers';

// resume-parse.ts's whole reason to exist is that a model can invent, and the
// person's record must never carry an invention. These tests drive crafted
// model output through the real verification with no network and no key, the
// same way generation-providers.test.ts drives verifyStyleResult(). The
// invariant every "evil" case asserts is the same: content that is not on the
// resume never reaches a proposal.

const RESUME = [
  'Ryan Payne',
  'Atlanta, GA',
  'github.com/ryanpayne  linkedin.com/in/ryanpayne',
  '',
  'Design Lead',
  'Digital Cotton',
  '2021 to Present',
  'Ran the design system.',
  'Built the agentic platform.',
  '',
  'Senior Product Designer',
  'Acme Corp',
  '2018 to 2021',
  'San Francisco',
  'Shipped checkout.'
].join('\n');

function honestModelReply(): string {
  return JSON.stringify({
    entries: [
      {
        kind: 'role_held',
        employerOrInstitution: 'Digital Cotton',
        officialTitle: 'Design Lead',
        startYear: 2021,
        startMonth: null,
        endYear: null,
        endMonth: null,
        location: null,
        description: 'Ran the design system.\nBuilt the agentic platform.'
      },
      {
        kind: 'role_held',
        employerOrInstitution: 'Acme Corp',
        officialTitle: 'Senior Product Designer',
        startYear: 2018,
        startMonth: null,
        endYear: 2021,
        endMonth: null,
        location: 'San Francisco',
        description: 'Shipped checkout.'
      }
    ],
    links: [
      { platform: 'github', url: 'https://github.com/ryanpayne' },
      { platform: 'linkedin', url: 'https://linkedin.com/in/ryanpayne' }
    ],
    name: { first: 'Ryan', last: 'Payne' }
  });
}

describe('buildProposalsFromModelJson: the honest case reads the whole resume', () => {
  const result = buildProposalsFromModelJson(RESUME, honestModelReply());

  it('succeeds and proposes both roles, both links, and the name', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals.entries).toHaveLength(2);
    expect(result.proposals.links).toHaveLength(2);
    expect(result.proposals.name).toEqual({ first: 'Ryan', last: 'Payne' });
  });

  it('carries the verbatim values through, kind inferred as role_held', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.proposals.entries[0].candidate;
    expect(first.officialTitle).toBe('Design Lead');
    expect(first.employerOrInstitution).toBe('Digital Cotton');
    expect(first.start).toEqual({ year: 2021, month: null });
    expect(first.end).toBeNull();
    expect(first.classification).toBe('private');
    expect(first.artifacts).toEqual([]);
  });
});

describe('buildProposalsFromModelJson: a fabricating model never lands invented content in a proposal', () => {
  it('drops an entry whose employer was never on the resume, keeps the rest', () => {
    const reply = JSON.parse(honestModelReply());
    reply.entries[0].employerOrInstitution = 'Google'; // never appears in RESUME
    const result = buildProposalsFromModelJson(RESUME, JSON.stringify(reply));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fabricated entry is gone; the honest one survives.
    expect(result.proposals.entries).toHaveLength(1);
    expect(result.proposals.entries[0].candidate.officialTitle).toBe('Senior Product Designer');
    // "Google" reaches no proposal anywhere.
    const all = JSON.stringify(result.proposals);
    expect(all).not.toContain('Google');
    expect(result.notes.some((n) => /left out/i.test(n))).toBe(true);
  });

  it('drops an entry with a title that was never on the resume', () => {
    const reply = JSON.parse(honestModelReply());
    reply.entries[0].officialTitle = 'Chief Vibes Officer';
    const result = buildProposalsFromModelJson(RESUME, JSON.stringify(reply));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.proposals)).not.toContain('Chief Vibes Officer');
  });

  it('drops an entry whose year is not on the resume (a fabricated date)', () => {
    const reply = JSON.parse(honestModelReply());
    reply.entries[0].startYear = 1999; // not in RESUME
    const result = buildProposalsFromModelJson(RESUME, JSON.stringify(reply));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals.entries).toHaveLength(1);
    expect(result.proposals.entries[0].candidate.start.year).toBe(2018);
  });

  it('keeps only description lines that are on the page, dropping a summarised one', () => {
    const reply = JSON.parse(honestModelReply());
    reply.entries[0].description = 'Ran the design system.\nDrove 40% revenue growth across the org.';
    const result = buildProposalsFromModelJson(RESUME, JSON.stringify(reply));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const desc = result.proposals.entries[0].candidate.description;
    expect(desc).toContain('Ran the design system.');
    expect(desc).not.toContain('40% revenue growth');
  });

  it('drops a hidden-character injection: the tampered value is not verbatim on the page', () => {
    const reply = JSON.parse(honestModelReply());
    // A zero-width space spliced into the title makes it no longer verbatim.
    reply.entries[0].officialTitle = 'Design​Lead';
    const result = buildProposalsFromModelJson(RESUME, JSON.stringify(reply));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const all = JSON.stringify(result.proposals);
    expect(all).not.toContain('​');
  });

  it('drops a fabricated link and a link with a refused scheme', () => {
    const reply = JSON.parse(honestModelReply());
    reply.links = [
      { platform: 'github', url: 'https://github.com/ryanpayne' }, // real
      { platform: 'twitter', url: 'https://twitter.com/someone-else' }, // not on page
      { platform: 'website', url: 'javascript:alert(1)' } // refused scheme
    ];
    const result = buildProposalsFromModelJson(RESUME, JSON.stringify(reply));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals.links).toHaveLength(1);
    expect(result.proposals.links[0].url).toBe('https://github.com/ryanpayne');
    expect(JSON.stringify(result.proposals)).not.toContain('javascript:');
  });

  it('does not propose a name whose parts are not on the page', () => {
    const reply = JSON.parse(honestModelReply());
    reply.name = { first: 'Jordan', last: 'Nobody' };
    const result = buildProposalsFromModelJson(RESUME, JSON.stringify(reply));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals.name).toBeNull();
  });
});

describe('buildProposalsFromModelJson: structural betrayal fails the whole reply', () => {
  it('rejects a reply that is not valid JSON', () => {
    expect(buildProposalsFromModelJson(RESUME, 'I cannot help with that.').ok).toBe(false);
  });

  it('rejects a reply that is not an object', () => {
    expect(buildProposalsFromModelJson(RESUME, '["nope"]').ok).toBe(false);
  });

  it('rejects a reply with no entries array', () => {
    expect(buildProposalsFromModelJson(RESUME, JSON.stringify({ links: [] })).ok).toBe(false);
  });

  it('tolerates a markdown code fence around otherwise valid JSON', () => {
    const fenced = '```json\n' + honestModelReply() + '\n```';
    expect(buildProposalsFromModelJson(RESUME, fenced).ok).toBe(true);
  });

  it('drops an entry with an unknown kind enum rather than guessing', () => {
    const reply = JSON.parse(honestModelReply());
    reply.entries[0].kind = 'sabbatical';
    const result = buildProposalsFromModelJson(RESUME, JSON.stringify(reply));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals.entries).toHaveLength(1);
  });
});

describe('parseResumeWithProvider: fail-closed around the network', () => {
  const KEY = 'sk-ant-secret-key-value-that-must-never-leak';

  it('returns verified proposals when the injected call answers honestly', async () => {
    const call: ProviderCall = async () => honestModelReply();
    const result = await parseResumeWithProvider(RESUME, 'anthropic', KEY, { call });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals.entries).toHaveLength(2);
  });

  it('resolves to ok:false, never throws, when the call throws', async () => {
    const call: ProviderCall = async () => {
      throw new Error('boom from the provider');
    };
    const result = await parseResumeWithProvider(RESUME, 'openai', KEY, { call });
    expect(result.ok).toBe(false);
  });

  it('times out a hanging call and resolves to ok:false', async () => {
    const call: ProviderCall = (_p, _k, _m, _s, _d, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const result = await parseResumeWithProvider(RESUME, 'kimi', KEY, { call, timeoutMs: 30 });
    expect(result.ok).toBe(false);
  });

  it('never puts the api key in the failure reason', async () => {
    const call: ProviderCall = async () => {
      throw new Error(`upstream said ${KEY} is invalid`);
    };
    const result = await parseResumeWithProvider(RESUME, 'deepseek', KEY, { call });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain(KEY);
  });
});

describe('parseResumeWithProvider: reading a resume uses the copy tier, never the writing one', () => {
  const KEY = 'sk-ant-secret-key-value-that-must-never-leak';

  // The split this feature exists for: reading a resume is transcription
  // against a verifier that discards anything not already in the source, so it
  // runs on the cheapest model a provider sells. The person paying is the
  // key's owner, and nobody should pay frontier prices to have their own
  // resume retyped.
  it('asks for each provider own copyModel, not its writing default', async () => {
    for (const provider of GENERATION_PROVIDER_ORDER) {
      let asked = '';
      const call: ProviderCall = async (_p, _k, model) => {
        asked = model;
        return honestModelReply();
      };
      const result = await parseResumeWithProvider(RESUME, provider, KEY, { call });
      expect(result.ok).toBe(true);
      expect(asked).toBe(PROVIDER_REGISTRY[provider].copyModel);
    }
  });

  it('asks for something cheaper than the writing default where the provider sells one', async () => {
    // Not asserted for every provider: Kimi and DeepSeek's cheapest
    // general-purpose model is also the sensible writing default, so there
    // the two ids legitimately match. Anthropic and OpenAI both sell a tier
    // below their writing default, and there the split must be visible.
    for (const provider of ['anthropic', 'openai'] as const) {
      let asked = '';
      const call: ProviderCall = async (_p, _k, model) => {
        asked = model;
        return honestModelReply();
      };
      await parseResumeWithProvider(RESUME, provider, KEY, { call });
      expect(asked).not.toBe(PROVIDER_REGISTRY[provider].defaultWritingModel);
    }
  });
});

describe('parseResumeWithProvider: the failure reason names the failure', () => {
  const KEY = 'sk-ant-secret-key-value-that-must-never-leak';

  // 2026-09-01: the first real-world failure of this feature stored one fixed
  // sentence for every possible cause, which made the row it left behind
  // undiagnosable. These pin the mapping: each distinct failure produces its
  // own sentence, built only from facts our own code minted.

  it('a timeout names the timeout', async () => {
    const call: ProviderCall = (_p, _k, _m, _s, _d, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const result = await parseResumeWithProvider(RESUME, 'anthropic', KEY, { call, timeoutMs: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('timed out');
  });

  it('an HTTP status names the status, and a 401 says the key was not accepted', async () => {
    const call: ProviderCall = async () => {
      throw new GenerationCallError('Anthropic responded with status 401', { status: 401 });
    };
    const result = await parseResumeWithProvider(RESUME, 'anthropic', KEY, { call });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('401');
    expect(result.reason).toContain('key was not accepted');
  });

  it('a non-auth status carries the number and nothing invented', async () => {
    const call: ProviderCall = async () => {
      throw new GenerationCallError('Anthropic responded with status 529', { status: 529 });
    };
    const result = await parseResumeWithProvider(RESUME, 'anthropic', KEY, { call });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('the provider answered 529');
  });

  it('a token-ceiling cut-off names the cut-off, not "invalid JSON"', async () => {
    const call: ProviderCall = async () => {
      throw new GenerationCallError('Anthropic: the reply was cut off at the token ceiling before it finished');
    };
    const result = await parseResumeWithProvider(RESUME, 'anthropic', KEY, { call });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('the model reply was cut off before it finished');
  });

  it('an unknown throw stays generic and never echoes the thrown message', async () => {
    const call: ProviderCall = async () => {
      throw new Error(`upstream exploded holding ${KEY}`);
    };
    const result = await parseResumeWithProvider(RESUME, 'openai', KEY, { call });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('the provider call failed before it answered');
    expect(result.reason).not.toContain(KEY);
  });
});

describe('parseResumeDeterministic: the no-key fallback wraps the line parser', () => {
  it('returns the same proposal shape, with no links or name', () => {
    const threeLine = ['Design Lead', 'Digital Cotton', '2021 to Present', 'Ran the design system.'].join('\n');
    const { proposals } = parseResumeDeterministic(threeLine);
    expect(proposals.links).toEqual([]);
    expect(proposals.name).toBeNull();
    expect(proposals.entries.length).toBeGreaterThanOrEqual(0);
  });
});
