/**
 * generation-cost.ts: the ONE place a token count becomes a dollar figure, and
 * the only file in this repo that ships a price.
 *
 * The covenant everywhere else (generation-providers.ts's PROVIDER_REGISTRY note)
 * is that a dollar figure is "a fact with an expiry date" and does not belong in
 * shipped copy. This file is the sanctioned exception: a real cost the person
 * pays their OWN provider is worth showing, but only if it is dated and
 * owner-maintained, so it reads as an estimate from a known day rather than a
 * live quote.
 *
 * EVERY RATE HERE IS OWNER-MAINTAINED AND APPROXIMATE. PRICES_AS_OF stamps when
 * they were last set against the providers' public pricing. Nothing here is
 * fetched or inferred; when a provider changes its pricing the owner edits the
 * rate and PRICES_AS_OF together, and any cost shown to a reader carries that
 * date. A model with no rate on file yields null, and the room then shows the
 * real token count and duration with no dollar figure rather than inventing one.
 */

/** When these rates were last set by the owner. Update this whenever a rate
    below changes. Shown next to any cost so a stale price reads as dated. */
export const PRICES_AS_OF = '2026-09-18';

interface Rate {
  /** US dollars per million input (prompt) tokens. */
  readonly inputPerM: number;
  /** US dollars per million output (completion) tokens. */
  readonly outputPerM: number;
}

/**
 * US dollars per MILLION tokens, per provider and (optionally) model id. '*' is
 * the provider's default writing-model rate; a specific model id overrides it.
 * APPROXIMATE published rates the owner must verify. Update alongside
 * PRICES_AS_OF. A provider or model absent here has no priced cost (null).
 */
const RATES: Record<string, Record<string, Rate>> = {
  anthropic: { '*': { inputPerM: 3, outputPerM: 15 } },
  openai: { '*': { inputPerM: 2.5, outputPerM: 10 } },
  kimi: { '*': { inputPerM: 0.6, outputPerM: 2.5 } },
  deepseek: { '*': { inputPerM: 0.3, outputPerM: 1.2 } }
};

function rateFor(provider: string | null, model: string | null): Rate | null {
  if (!provider) return null;
  const byModel = RATES[provider];
  if (!byModel) return null;
  return (model ? byModel[model] : null) ?? byModel['*'] ?? null;
}

export interface CostEstimate {
  readonly usd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The date the rate used was last set (PRICES_AS_OF), carried so the reader
      sees a cost is an estimate from a known day. */
  readonly asOf: string;
}

/**
 * The dollar cost of one draft's token usage, or null when there is no priced
 * rate (a deterministic draft with no provider, or a model not in RATES) or no
 * tokens were measured. Never throws; a null token count reads as zero, so a
 * render with no usage yields null rather than a fabricated charge.
 */
export function estimateDraftCost(input: {
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}): CostEstimate | null {
  const rate = rateFor(input.provider, input.model);
  if (!rate) return null;
  const inTok = input.inputTokens ?? 0;
  const outTok = input.outputTokens ?? 0;
  if (inTok <= 0 && outTok <= 0) return null;
  const usd = (inTok / 1_000_000) * rate.inputPerM + (outTok / 1_000_000) * rate.outputPerM;
  return { usd, inputTokens: inTok, outputTokens: outTok, asOf: PRICES_AS_OF };
}

/**
 * A dollar amount as a short, honest string: the room shows "under a cent" or
 * "about N cents" for small drafting sums rather than a false-precision
 * "$0.0037", and dollars-and-cents once it is a dollar or more. Never invents
 * precision the number does not carry.
 */
export function formatCost(usd: number): string {
  if (usd <= 0) return 'no model cost';
  if (usd < 0.01) return 'under a cent';
  if (usd < 1) return `about ${Math.round(usd * 100)} cents`;
  return `$${usd.toFixed(2)}`;
}
