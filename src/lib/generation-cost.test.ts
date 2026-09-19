import { describe, expect, it } from 'vitest';
import { estimateDraftCost, formatCost, PRICES_AS_OF } from './generation-cost';

describe('estimateDraftCost', () => {
  it('prices a known provider by tokens, carrying the as-of date', () => {
    const c = estimateDraftCost({ provider: 'anthropic', model: null, inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(c).not.toBeNull();
    expect(c!.usd).toBeCloseTo(18, 6); // 3 per M in + 15 per M out
    expect(c!.asOf).toBe(PRICES_AS_OF);
  });

  it('is null for a deterministic draft (no provider)', () => {
    expect(estimateDraftCost({ provider: null, model: null, inputTokens: 100, outputTokens: 100 })).toBeNull();
  });

  it('is null for an unpriced provider', () => {
    expect(estimateDraftCost({ provider: 'mystery', model: null, inputTokens: 100, outputTokens: 100 })).toBeNull();
  });

  it('is null when no tokens were measured', () => {
    expect(estimateDraftCost({ provider: 'anthropic', model: null, inputTokens: null, outputTokens: null })).toBeNull();
    expect(estimateDraftCost({ provider: 'anthropic', model: null, inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});

describe('formatCost', () => {
  it('reads small drafting sums honestly, dollars once large', () => {
    expect(formatCost(0)).toBe('no model cost');
    expect(formatCost(0.004)).toBe('under a cent');
    expect(formatCost(0.02)).toBe('about 2 cents');
    expect(formatCost(1.5)).toBe('$1.50');
  });
});
