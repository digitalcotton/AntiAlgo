import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LockedFactSet, LetterStyleResult, LockedLetter, StyleResult } from './provider';
import { templateText } from './provider';
import {
  ANTHROPIC_ENDPOINT,
  DEEPSEEK_ENDPOINT,
  GENERATION_PROVIDER_ORDER,
  GenerationCallError,
  KIMI_ENDPOINT,
  LETTER_MAX_ATTEMPTS,
  MAX_STYLED_SLOT_LENGTH,
  OPENAI_ENDPOINT,
  PROVIDER_REGISTRY,
  generativeProvider,
  isKnownWritingModel,
  registryIsWellFormed,
  runGenerationAttempt,
  runLetterAttempt,
  verifyStyleResult,
  type RawGenerationCall,
  type RawLetterCall
} from './generation-providers';

// generation-providers.ts is the generative half of the seam provider.ts
// declares: a registry of four hardcoded providers, two wire adapters, a
// prompt built so instruction and data can never merge, and verification
// that fails the whole attempt closed (never silently) the moment a
// response cannot be trusted. These tests are written in the voice of
// provider.test.ts and tailor.test.ts: adversarial about the seam's own
// promises (fail closed, never leak a key, never touch a fourth endpoint),
// not a re-test of what an actual model would say, because nothing here
// calls a real model (constraint 6: zero spend, no network call to any
// real provider API).

const FAKE_KEY = 'sk-ant-test-key-not-a-real-credential-00000000';

function slot(overrides: Partial<LockedFactSet['slots'][number]> = {}) {
  return {
    slotId: 'PRF-0001#0',
    sourcePrfIds: ['PRF-0001'] as const,
    kind: 'role_held' as const,
    fragments: ['Shipped the checkout redesign', 'Cut page weight by half'],
    ...overrides
  };
}

function lockedSet(slots: ReturnType<typeof slot>[] = [slot()]): LockedFactSet {
  return { slots };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------------------------------------------------------------------
   The registry: exactly the four endpoints MASTER-SPEC D7 names, and no
   argument anywhere in this file's public surface can reach a fifth.
   --------------------------------------------------------------------------- */

describe('PROVIDER_REGISTRY: exactly the four providers, the four fixed endpoints', () => {
  it('declares exactly anthropic, openai, kimi, deepseek, matching GENERATION_PROVIDER_ORDER', () => {
    expect(Object.keys(PROVIDER_REGISTRY).sort()).toEqual(['anthropic', 'deepseek', 'kimi', 'openai']);
    expect([...GENERATION_PROVIDER_ORDER].sort()).toEqual(['anthropic', 'deepseek', 'kimi', 'openai']);
  });

  it('pins each provider to its own hardcoded endpoint constant, none shared', () => {
    expect(PROVIDER_REGISTRY.anthropic.endpoint).toBe(ANTHROPIC_ENDPOINT);
    expect(PROVIDER_REGISTRY.openai.endpoint).toBe(OPENAI_ENDPOINT);
    expect(PROVIDER_REGISTRY.kimi.endpoint).toBe(KIMI_ENDPOINT);
    expect(PROVIDER_REGISTRY.deepseek.endpoint).toBe(DEEPSEEK_ENDPOINT);
  });

  it('the four endpoints are exactly the URLs MASTER-SPEC D7 names, byte for byte', () => {
    expect(ANTHROPIC_ENDPOINT).toBe('https://api.anthropic.com/v1/messages');
    expect(OPENAI_ENDPOINT).toBe('https://api.openai.com/v1/chat/completions');
    expect(KIMI_ENDPOINT).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(DEEPSEEK_ENDPOINT).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('anthropic speaks the anthropic wire with the x-api-key auth shape; the other three speak openai-chat with bearer', () => {
    expect(PROVIDER_REGISTRY.anthropic.wire).toBe('anthropic');
    expect(PROVIDER_REGISTRY.anthropic.authHeaderShape).toBe('anthropic-x-api-key');
    for (const id of ['openai', 'kimi', 'deepseek'] as const) {
      expect(PROVIDER_REGISTRY[id].wire).toBe('openai-chat');
      expect(PROVIDER_REGISTRY[id].authHeaderShape).toBe('bearer');
    }
  });

  it('GenerationOptions has no way to reach a fifth endpoint: generativeProvider() with an endpoint-shaped option still calls the registry URL', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }), { status: 200 });
      })
    );
    const provider = generativeProvider(
      'anthropic',
      FAKE_KEY,
      // @ts-expect-error GenerationOptions declares no `endpoint` field; this line proves one cannot be smuggled in at the type level, and the runtime assertion below proves it changes nothing even if the type check is bypassed.
      { endpoint: 'https://evil.example.com/steal', model: 'claude-sonnet-5' }
    );
    await provider.style(lockedSet());
    expect(calls).toEqual([ANTHROPIC_ENDPOINT]);
  });
});

/* ---------------------------------------------------------------------------
   The two model tiers. The registry is the only place in this codebase that
   names a model, so these are the checks that catch a half-finished update to
   it, which is a failure this file has already suffered once.
   --------------------------------------------------------------------------- */

describe('PROVIDER_REGISTRY: a copy tier and a writing list, per provider', () => {
  it('is well formed: every provider has a copy tier, a writing list, and a default that is in its own list', () => {
    expect(registryIsWellFormed()).toBe(true);
  });

  it('offers every provider at least one writing model, each with an id and a label', () => {
    for (const id of GENERATION_PROVIDER_ORDER) {
      const def = PROVIDER_REGISTRY[id];
      expect(def.writingModels.length).toBeGreaterThan(0);
      for (const model of def.writingModels) {
        expect(model.id.trim()).not.toBe('');
        expect(model.label.trim()).not.toBe('');
        expect(model.note.trim()).not.toBe('');
      }
    }
  });

  it('names a copy tier for every provider, and never leaves it blank', () => {
    for (const id of GENERATION_PROVIDER_ORDER) {
      expect(PROVIDER_REGISTRY[id].copyModel.trim()).not.toBe('');
    }
  });

  it('lists no duplicate model ids within one provider', () => {
    for (const id of GENERATION_PROVIDER_ORDER) {
      const ids = PROVIDER_REGISTRY[id].writingModels.map((model) => model.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('isKnownWritingModel accepts what the registry offers and refuses everything else', () => {
    for (const id of GENERATION_PROVIDER_ORDER) {
      const def = PROVIDER_REGISTRY[id];
      expect(isKnownWritingModel(id, def.defaultWritingModel)).toBe(true);
      for (const model of def.writingModels) {
        expect(isKnownWritingModel(id, model.id)).toBe(true);
      }
      // The refusals a settings endpoint leans on: an invented id, an empty
      // string, and, importantly, a real model id belonging to a DIFFERENT
      // provider, which is the plausible-looking value a hand-edited form
      // would post.
      expect(isKnownWritingModel(id, 'not-a-model-we-offer')).toBe(false);
      expect(isKnownWritingModel(id, '')).toBe(false);
    }
    expect(isKnownWritingModel('anthropic', PROVIDER_REGISTRY.openai.defaultWritingModel)).toBe(false);
    expect(isKnownWritingModel('openai', PROVIDER_REGISTRY.anthropic.defaultWritingModel)).toBe(false);
  });

  it('the copy tier is not silently the same choice as the writing default for the big two', () => {
    // Not a style rule: the whole point of the split is that transcription
    // runs cheaper than writing. Anthropic and OpenAI both sell a tier below
    // their writing default, so if these ever match, the split has been
    // undone by an edit rather than by a provider's catalog.
    expect(PROVIDER_REGISTRY.anthropic.copyModel).not.toBe(PROVIDER_REGISTRY.anthropic.defaultWritingModel);
    expect(PROVIDER_REGISTRY.openai.copyModel).not.toBe(PROVIDER_REGISTRY.openai.defaultWritingModel);
  });
});

/* ---------------------------------------------------------------------------
   Each wire adapter against a mocked fetch.
   --------------------------------------------------------------------------- */

describe('the anthropic wire', () => {
  it('POSTs to ANTHROPIC_ENDPOINT with x-api-key, anthropic-version, and a system/user split', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenInit = init;
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ 'PRF-0001#0': 'Rephrased line.' }) }] }),
          { status: 200 }
        );
      })
    );
    const provider = generativeProvider('anthropic', FAKE_KEY);
    const result = await provider.style(lockedSet());

    expect(seenUrl).toBe(ANTHROPIC_ENDPOINT);
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(FAKE_KEY);
    expect(headers['anthropic-version']).toBeTruthy();
    expect(headers.authorization).toBeUndefined();

    const body = JSON.parse(String(seenInit?.body));
    expect(typeof body.system).toBe('string');
    expect(body.system).not.toContain(FAKE_KEY);
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('DATA') }]);
    expect(body.messages[0].content).not.toBe(body.system);

    expect(result.styledSlots).toEqual([{ slotId: 'PRF-0001#0', text: 'Rephrased line.' }]);
  });
});

describe('the openai-chat wire, shared by openai, kimi and deepseek', () => {
  it.each(['openai', 'kimi', 'deepseek'] as const)('%s POSTs to its own endpoint with a bearer token and a system/user message split', async (id) => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenInit = init;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ 'PRF-0001#0': 'Rephrased line.' }) } }] }),
          { status: 200 }
        );
      })
    );
    const provider = generativeProvider(id, FAKE_KEY);
    const result = await provider.style(lockedSet());

    expect(seenUrl).toBe(PROVIDER_REGISTRY[id].endpoint);
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers['x-api-key']).toBeUndefined();

    const body = JSON.parse(String(seenInit?.body));
    expect(body.messages[0]).toEqual({ role: 'system', content: expect.any(String) });
    expect(body.messages[1]).toEqual({ role: 'user', content: expect.stringContaining('DATA') });
    expect(body.messages[0].content).not.toContain(FAKE_KEY);
    expect(body.messages[1].content).not.toContain(FAKE_KEY);

    expect(result.styledSlots).toEqual([{ slotId: 'PRF-0001#0', text: 'Rephrased line.' }]);
  });
});

/* ---------------------------------------------------------------------------
   Verification: verifyStyleResult() directly, no network involved.
   --------------------------------------------------------------------------- */

describe('verifyStyleResult(): extra slot rejected, the whole attempt, not filtered', () => {
  it('fails closed when a returned slotId is absent from the locked set', () => {
    const locked = lockedSet([slot({ slotId: 'a' }), slot({ slotId: 'b' })]);
    const result: StyleResult = {
      styledSlots: [
        { slotId: 'a', text: 'Honest rephrase.' },
        { slotId: 'not-a-real-slot', text: 'Injected content.' }
      ]
    };
    const attempt = verifyStyleResult(locked, result);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.reason).toContain('not-a-real-slot');
    }
  });

  it('accepts a clean response that styles exactly the locked slots', () => {
    const locked = lockedSet([slot({ slotId: 'a' })]);
    const attempt = verifyStyleResult(locked, { styledSlots: [{ slotId: 'a', text: 'Honest rephrase.' }] });
    expect(attempt).toEqual({ ok: true, result: { styledSlots: [{ slotId: 'a', text: 'Honest rephrase.' }] } });
  });

  it('fills a locked slot the response was silent on with templateText(), never dropping it', () => {
    const s = slot({ slotId: 'a', kind: 'role_held', fragments: ['Led the migration', 'Wrote the runbook'] });
    const locked = lockedSet([s]);
    const attempt = verifyStyleResult(locked, { styledSlots: [] });
    expect(attempt.ok).toBe(true);
    if (attempt.ok) {
      expect(attempt.result.styledSlots).toEqual([{ slotId: 'a', text: templateText('role_held', s.fragments) }]);
    }
  });

  it('fails closed when a returned slot carries a hidden character', () => {
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    const locked = lockedSet([slot({ slotId: 'a' })]);
    const attempt = verifyStyleResult(locked, {
      styledSlots: [{ slotId: 'a', text: `Honest rephrase${zeroWidthSpace}with a hidden character.` }]
    });
    expect(attempt.ok).toBe(false);
  });

  it('fails closed when a returned slot exceeds MAX_STYLED_SLOT_LENGTH', () => {
    const locked = lockedSet([slot({ slotId: 'a' })]);
    const attempt = verifyStyleResult(locked, {
      styledSlots: [{ slotId: 'a', text: 'x'.repeat(MAX_STYLED_SLOT_LENGTH + 1) }]
    });
    expect(attempt.ok).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
   runGenerationAttempt(): the thrower and the hanger, driven with mock raw
   calls, no fetch involved at all.
   --------------------------------------------------------------------------- */

describe('runGenerationAttempt(): fails closed without ever throwing past it', () => {
  it('a thrower falls back: ok is false, reason names a failure, nothing is thrown out of this function', async () => {
    const thrower: RawGenerationCall = async () => {
      throw new Error('the provider exploded');
    };
    const attempt = await runGenerationAttempt(lockedSet(), null, thrower, 1000);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.reason).toContain('the provider exploded');
  });

  it('a hanger falls back once the timeout elapses, and does not wait for the real timeout to prove it', async () => {
    const hanger: RawGenerationCall = () => new Promise<never>(() => {});
    const started = Date.now();
    const attempt = await runGenerationAttempt(lockedSet(), null, hanger, 25);
    const elapsed = Date.now() - started;
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.reason).toContain('timed out');
    expect(elapsed).toBeLessThan(1000);
  });

  it('a well-behaved raw call succeeds', async () => {
    const good: RawGenerationCall = async (locked) => ({
      styledSlots: locked.slots.map((s) => ({ slotId: s.slotId, text: 'Honest rephrase.' }))
    });
    const attempt = await runGenerationAttempt(lockedSet(), null, good, 1000);
    expect(attempt.ok).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
   generativeProvider(): the whole seam, fallback bookkeeping, and the key.
   --------------------------------------------------------------------------- */

describe('generativeProvider(): fail closed end to end, through style() itself', () => {
  it('falls back to the deterministic template and records a fallback reason on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const s = slot({ fragments: ['Led the migration', 'Wrote the runbook'] });
    const provider = generativeProvider('anthropic', FAKE_KEY);
    const result = await provider.style(lockedSet([s]));
    expect(result.styledSlots).toEqual([{ slotId: s.slotId, text: templateText(s.kind, s.fragments) }]);
    expect(provider.fallbackReasons().length).toBe(1);
  });

  it('falls back on malformed JSON from the provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'not json{{{' }] }), { status: 200 }))
    );
    const provider = generativeProvider('anthropic', FAKE_KEY);
    const result = await provider.style(lockedSet());
    expect(result.styledSlots[0].text).toBe(templateText('role_held', slot().fragments));
    expect(provider.fallbackReasons().length).toBe(1);
  });

  it('falls back on an extra slot injected by the provider, discarding the whole response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [
                { type: 'text', text: JSON.stringify({ 'PRF-0001#0': 'Honest.', 'injected-slot': 'Fabricated fact.' }) }
              ]
            }),
            { status: 200 }
          )
      )
    );
    const s = slot();
    const provider = generativeProvider('anthropic', FAKE_KEY);
    const result = await provider.style(lockedSet([s]));
    // Not "Honest.": the whole attempt was discarded, including the
    // slot that looked fine, because the response also invented one that
    // was never sent to it. See verifyStyleResult()'s own comment.
    expect(result.styledSlots).toEqual([{ slotId: s.slotId, text: templateText(s.kind, s.fragments) }]);
    expect(provider.fallbackReasons()[0]).toContain('injected-slot');
  });

  it('falls back on a hidden character in the provider\'s own returned text', async () => {
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ 'PRF-0001#0': `Hidden${zeroWidthSpace}text.` }) }] }),
            { status: 200 }
          )
      )
    );
    const s = slot();
    const provider = generativeProvider('anthropic', FAKE_KEY);
    const result = await provider.style(lockedSet([s]));
    expect(result.styledSlots).toEqual([{ slotId: s.slotId, text: templateText(s.kind, s.fragments) }]);
  });

  it('falls back when the raw call throws (a network-level failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    const s = slot();
    const provider = generativeProvider('anthropic', FAKE_KEY);
    const result = await provider.style(lockedSet([s]));
    expect(result.styledSlots).toEqual([{ slotId: s.slotId, text: templateText(s.kind, s.fragments) }]);
    expect(provider.fallbackReasons().length).toBe(1);
  });

  it('falls back when the provider hangs past the configured timeout, without waiting for the real default', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})));
    const s = slot();
    const provider = generativeProvider('anthropic', FAKE_KEY, { timeoutMs: 25 });
    const started = Date.now();
    const result = await provider.style(lockedSet([s]));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.styledSlots).toEqual([{ slotId: s.slotId, text: templateText(s.kind, s.fragments) }]);
  });

  it('style() itself never rejects, whatever the raw call does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      })
    );
    const provider = generativeProvider('anthropic', FAKE_KEY);
    await expect(provider.style(lockedSet())).resolves.toBeDefined();
  });

  it('never puts the API key in name, in fallbackReasons(), or in any thrown/caught error string', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error text mentioning nothing sensitive', { status: 500 })));
    const provider = generativeProvider('anthropic', FAKE_KEY);
    expect(provider.name).not.toContain(FAKE_KEY);
    await provider.style(lockedSet());
    for (const reason of provider.fallbackReasons()) {
      expect(reason).not.toContain(FAKE_KEY);
    }
  });

  it('name is diagnostic: provider id and model, nothing else', () => {
    const provider = generativeProvider('deepseek', FAKE_KEY, { model: 'deepseek-v4-flash' });
    expect(provider.name).toBe('deepseek/deepseek-v4-flash');
  });

  it('accumulates the usage the wire billed, exposed via usage(), and sums across calls', async () => {
    // db/203: the provider reads the response's own usage block and totals it on
    // the instance. A generative call that returned is real spend, so usage()
    // reports it; a second call adds to the running total.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [{ type: 'text', text: JSON.stringify({ 'PRF-0001#0': 'A real rephrase.' }) }],
              usage: { input_tokens: 120, output_tokens: 45 }
            }),
            { status: 200 }
          )
      )
    );
    const provider = generativeProvider('anthropic', FAKE_KEY);
    expect(provider.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
    await provider.style(lockedSet());
    expect(provider.usage()).toEqual({ inputTokens: 120, outputTokens: 45 });
    await provider.style(lockedSet());
    expect(provider.usage()).toEqual({ inputTokens: 240, outputTokens: 90 });
    // Usage never turns a real reply into a fallback: this was a clean pass.
    expect(provider.fallbackReasons()).toEqual([]);
  });

  it('maps the openai-chat wire prompt_tokens/completion_tokens onto usage()', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ 'PRF-0001#0': 'A real rephrase.' }) } }],
              usage: { prompt_tokens: 200, completion_tokens: 60 }
            }),
            { status: 200 }
          )
      )
    );
    const provider = generativeProvider('openai', FAKE_KEY);
    await provider.style(lockedSet());
    expect(provider.usage()).toEqual({ inputTokens: 200, outputTokens: 60 });
  });

  it('records no usage when the wire never returns (a non-2xx that falls back stays at zero)', async () => {
    // The invariant: a call whose wire never came back adds nothing, so a purely
    // failed render honestly reports zero rather than inheriting a prior count.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const provider = generativeProvider('anthropic', FAKE_KEY);
    await provider.style(lockedSet());
    expect(provider.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(provider.fallbackReasons().length).toBe(1);
  });

  it('counts the spend of a call the verifier then rejected: the wire still billed for it', async () => {
    // An extra slot fails verification and forces a fallback, but the wire call
    // that produced it consumed tokens, so usage() reflects that real spend even
    // though the document shipped is the deterministic one.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [
                { type: 'text', text: JSON.stringify({ 'PRF-0001#0': 'Honest.', 'injected-slot': 'Fabricated.' }) }
              ],
              usage: { input_tokens: 80, output_tokens: 30 }
            }),
            { status: 200 }
          )
      )
    );
    const provider = generativeProvider('anthropic', FAKE_KEY);
    await provider.style(lockedSet());
    expect(provider.fallbackReasons().length).toBe(1);
    expect(provider.usage()).toEqual({ inputTokens: 80, outputTokens: 30 });
  });

  it('a well-formed response is used as-is, with no fallback recorded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ 'PRF-0001#0': 'A real rephrase.' }) }] }), {
            status: 200
          })
      )
    );
    const provider = generativeProvider('anthropic', FAKE_KEY);
    const result = await provider.style(lockedSet());
    expect(result.styledSlots).toEqual([{ slotId: 'PRF-0001#0', text: 'A real rephrase.' }]);
    expect(provider.fallbackReasons()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   runLetterAttempt(): the letter counterpart of runGenerationAttempt. Same
   fail-closed contract, verified by letter-verify.ts. Driven here with mock
   raw calls, each built to misbehave one way, so the guard is exercised
   without a network.
   ------------------------------------------------------------------------- */

function lockedLetterFixture(): LockedLetter {
  return {
    document: 'cover_letter',
    slots: [
      { role: 'opener', sourcePrfIds: [], fragments: [] },
      { role: 'proof', sourcePrfIds: ['PRF-0001'], fragments: ['Staff Designer at Acme Corp, March 2021 to Present', 'Led the checkout redesign that lifted conversion 12 percent.'] },
      { role: 'fit', sourcePrfIds: ['PRF-0002'], fragments: ['Product Designer at Beta, January 2019 to February 2021', 'Ran the design system.'] },
      { role: 'close', sourcePrfIds: [], fragments: [] }
    ],
    target: { company: 'OpenAI', title: 'Product Designer', requirements: ['You have shipped a checkout flow end to end.'], register: 'tech' },
    reason: 'I admire your work on creative tools.'
  };
}

const GOOD_LETTER: LetterStyleResult = {
  opener: 'I am applying for the Product Designer role at OpenAI. I admire your work on creative tools.',
  proof: 'At Acme Corp I led the checkout redesign, and it lifted conversion 12 percent over the prior version. Your posting asks for someone who has shipped a checkout flow end to end, and that is exactly the work I owned there from the first sketch through launch and the weeks of tuning after it went live to real traffic.',
  fit: 'At Beta I ran the design system and kept it honest across every surface we shipped. That systems focus is close to how your team builds its own tools. I like small groups that ship and then listen, and I would bring the same habit of small, testable steps to the role you posted.',
  close: 'The resume with this letter carries the full record. I would welcome a short call to walk through where I could help first and how you are thinking about the year ahead of you.'
};

describe('runLetterAttempt(): fail closed, verified by letter-verify', () => {
  it('accepts a good letter and returns its paragraphs', async () => {
    const raw: RawLetterCall = async () => GOOD_LETTER;
    const attempt = await runLetterAttempt(lockedLetterFixture(), null, 'create', raw, 1000);
    expect(attempt.ok, attempt.ok ? '' : attempt.reason).toBe(true);
    if (attempt.ok) expect(attempt.paragraphs.proof).toContain('12 percent');
  });

  it('rejects a letter with a fabricated number, resolving to a reason (no throw)', async () => {
    const raw: RawLetterCall = async () => ({ ...GOOD_LETTER, proof: GOOD_LETTER.proof.replace('12 percent', '40 percent') });
    const attempt = await runLetterAttempt(lockedLetterFixture(), null, 'create', raw, 1000);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.reason).toMatch(/number/i);
  });

  it('resolves a raw call that throws to a fallback reason, never a rejection', async () => {
    const raw: RawLetterCall = async () => { throw new Error('boom'); };
    const attempt = await runLetterAttempt(lockedLetterFixture(), null, 'create', raw, 1000);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.reason).toMatch(/failed/i);
  });

  it('cuts off a hung raw call at the timeout and falls back', async () => {
    const raw: RawLetterCall = () => new Promise(() => {});
    const attempt = await runLetterAttempt(lockedLetterFixture(), null, 'create', raw, 20);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.reason).toMatch(/timed out|failed/i);
  });
});

describe('runLetterAttempt(): retries inside the window before falling back', () => {
  it('retries a transient failure and then succeeds', async () => {
    let calls = 0;
    const raw: RawLetterCall = async () => {
      calls += 1;
      if (calls === 1) throw new Error('connection reset'); // transient, no status
      return GOOD_LETTER;
    };
    const attempt = await runLetterAttempt(lockedLetterFixture(), null, 'create', raw, 2000);
    expect(attempt.ok, attempt.ok ? '' : attempt.reason).toBe(true);
    expect(calls).toBe(2);
  });

  it('after a verifier rejection, retries once with the reason fed back as a correction', async () => {
    let calls = 0;
    let sawCorrection: string | null = null;
    const raw: RawLetterCall = async (_locked, _voice, _mode, correction) => {
      calls += 1;
      if (calls === 1) return { ...GOOD_LETTER, proof: GOOD_LETTER.proof.replace('12 percent', '40 percent') };
      sawCorrection = correction;
      return GOOD_LETTER;
    };
    const attempt = await runLetterAttempt(lockedLetterFixture(), null, 'create', raw, 2000);
    expect(attempt.ok, attempt.ok ? '' : attempt.reason).toBe(true);
    expect(calls).toBe(2);
    expect(sawCorrection).toMatch(/number/i);
  });

  it('takes a second corrective retry: two rejections, then a clean third draft', async () => {
    let calls = 0;
    let lastCorrection: string | null = null;
    const bad = { ...GOOD_LETTER, proof: GOOD_LETTER.proof.replace('12 percent', '40 percent') };
    const raw: RawLetterCall = async (_locked, _voice, _mode, correction) => {
      calls += 1;
      lastCorrection = correction;
      return calls < 3 ? bad : GOOD_LETTER;
    };
    const attempt = await runLetterAttempt(lockedLetterFixture(), null, 'create', raw, 3000);
    expect(attempt.ok, attempt.ok ? '' : attempt.reason).toBe(true);
    expect(calls).toBe(3);
    expect(lastCorrection).toMatch(/fact check/i);
  });

  it('stops after LETTER_MAX_ATTEMPTS rejections and falls back with the last reason', async () => {
    let calls = 0;
    const raw: RawLetterCall = async () => {
      calls += 1;
      return { ...GOOD_LETTER, proof: GOOD_LETTER.proof.replace('12 percent', '40 percent') };
    };
    const attempt = await runLetterAttempt(lockedLetterFixture(), null, 'create', raw, 3000);
    expect(attempt.ok).toBe(false);
    expect(calls).toBe(LETTER_MAX_ATTEMPTS);
    if (!attempt.ok) expect(attempt.reason).toMatch(/number/i);
  });

  it('does not retry a permanent provider error (a bad model id)', async () => {
    let calls = 0;
    const raw: RawLetterCall = async () => {
      calls += 1;
      throw new GenerationCallError('the model id is wrong', { status: 400 });
    };
    const attempt = await runLetterAttempt(lockedLetterFixture(), null, 'create', raw, 2000);
    expect(attempt.ok).toBe(false);
    expect(calls).toBe(1);
  });
});
