import { describe, expect, it } from 'vitest';
import { decideGenerationTrigger, type GenerationTriggerGateInput } from './generation-preference';

// generation-preference.ts is the pure gate behind the background
// generation trigger: no database, no crypto, no network, so every branch
// below is exercised with plain booleans and no live provider key or
// KEY_ENCRYPTION_SECRET anywhere. This is the test the task's own brief
// asks for by name: "prove the gate (setting off, or no key, produces no
// generation and no error) with a test."

function allGo(overrides: Partial<GenerationTriggerGateInput> = {}): GenerationTriggerGateInput {
  return {
    keyStorageConfigured: true,
    byokFlagOn: true,
    preferenceEnabled: true,
    hasStoredKey: true,
    ...overrides
  };
}

describe('decideGenerationTrigger(): the four-gate decision, and nothing else', () => {
  it('says go only when all four inputs are true', () => {
    expect(decideGenerationTrigger(allGo())).toEqual({ go: true });
  });

  it('refuses when KEY_ENCRYPTION_SECRET is not configured, even with everything else true', () => {
    const decision = decideGenerationTrigger(allGo({ keyStorageConfigured: false }));
    expect(decision.go).toBe(false);
    expect(decision.go === false && decision.reason).toMatch(/KEY_ENCRYPTION_SECRET/);
  });

  it('refuses when the byok flag is off, even with everything else true', () => {
    const decision = decideGenerationTrigger(allGo({ byokFlagOn: false }));
    expect(decision.go).toBe(false);
    expect(decision.go === false && decision.reason).toMatch(/byok/);
  });

  it('refuses when the reader has not turned the preference on, even with everything else true', () => {
    const decision = decideGenerationTrigger(allGo({ preferenceEnabled: false }));
    expect(decision.go).toBe(false);
    expect(decision.go === false && decision.reason).toMatch(/draft on apply/);
  });

  it('refuses when the reader has no provider key on file, even with everything else true', () => {
    const decision = decideGenerationTrigger(allGo({ hasStoredKey: false }));
    expect(decision.go).toBe(false);
    expect(decision.go === false && decision.reason).toMatch(/no provider key/);
  });

  it('refuses with every input false, and reports the first gate (key storage), not the last', () => {
    const decision = decideGenerationTrigger({
      keyStorageConfigured: false,
      byokFlagOn: false,
      preferenceEnabled: false,
      hasStoredKey: false
    });
    expect(decision.go).toBe(false);
    expect(decision.go === false && decision.reason).toMatch(/KEY_ENCRYPTION_SECRET/);
  });

  it('never throws for any combination of inputs', () => {
    const values = [true, false];
    for (const keyStorageConfigured of values) {
      for (const byokFlagOn of values) {
        for (const preferenceEnabled of values) {
          for (const hasStoredKey of values) {
            expect(() =>
              decideGenerationTrigger({ keyStorageConfigured, byokFlagOn, preferenceEnabled, hasStoredKey })
            ).not.toThrow();
          }
        }
      }
    }
  });
});
