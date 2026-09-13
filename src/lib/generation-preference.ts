/**
 * generation-preference.ts: the pure gate behind "draft my resume and
 * cover letter when I apply" (this task's own brief; the setting lives on
 * db/011_generation_on_apply.sql's generate_on_apply column, written from
 * a new panel on src/pages/account/settings.astro). No database, no
 * crypto, no network, in the same spirit as desk.ts and entitlement.ts:
 * this is what lets the one question that matters, "should a click just
 * now try to generate anything for this person", be answered and tested
 * with nothing running.
 *
 * FOUR GATES, ALL FOUR REQUIRED, CHECKED IN A FIXED ORDER. decideGenerationTrigger()
 * below is the only place that answers this question; the impure half
 * (src/lib/generation-preference-store.ts's triggerBackgroundGeneration())
 * gathers the four inputs and then defers to this function rather than
 * re-deciding anything itself, the same split desk.ts's transition() and
 * desk-store.ts's transitionApplication() already draw for the Desk.
 *
 *   1. keyStorageConfigured: KEY_ENCRYPTION_SECRET is set on this
 *      deployment and decodes to something usable
 *      (src/lib/keychain.ts's keyStorageIsConfigured()). False on every
 *      environment this task was built and verified in, which is why the
 *      "everything is on" branch below could not be exercised end to end
 *      here; see generation-preference-store.ts's own header and this
 *      task's report for what that does and does not prove.
 *   2. byokFlagOn: the `byok` kill switch (src/lib/flags.ts's
 *      isOn('byok')), the identical flag the draft room's own trigger
 *      (src/lib/generation-preference-store.ts's triggerBackgroundGeneration(),
 *      called from src/pages/desk/application.ts's 'click' intent) gates a
 *      live render behind, re-checked here rather than assumed, because a
 *      background trigger firing while the kill switch is off would make
 *      the switch a lie.
 *   3. preferenceEnabled: the reader's own opt-in,
 *      db/011_generation_on_apply.sql's column. ON BY DEFAULT for every
 *      account as of db/012_drafting.sql: this run predates anyone
 *      deliberately turning it off, and the owner asked for on-by-default
 *      while the feature is alpha. A click still never turns generation on
 *      by itself; it is only ever a stored column this gate reads, never a
 *      decision made at click time. A person may still turn it off from
 *      Settings.
 *   4. hasStoredKey: at least one provider key on file
 *      (src/lib/keychain-store.ts's keyMeta(), matched against
 *      generation-providers.ts's GENERATION_PROVIDER_ORDER, the same
 *      provider-selection rule generation-preference-store.ts's own
 *      triggerBackgroundGeneration() applies). A person can turn the
 *      preference on with no key connected yet; this gate is what keeps
 *      that state a safe no-op instead of a broken attempt.
 *
 * FAILS SAFE, NEVER LOUD. Every branch below returns `{ go: false, reason }`,
 * never throws: a function that could throw past this one would be exactly
 * the kind of thing that could turn "the setting happens to be off" into a
 * broken apply click, which this task's own brief rules out by name ("It
 * never blocks the apply action or the page"). `reason` is for a server
 * log and a test assertion, never rendered to a reader: there is nothing
 * here a reader did wrong, so there is nothing here to tell them.
 */

export interface GenerationTriggerGateInput {
  /** src/lib/keychain.ts's keyStorageIsConfigured(). */
  readonly keyStorageConfigured: boolean;
  /** src/lib/flags.ts's isOn('byok'). */
  readonly byokFlagOn: boolean;
  /** The reader's own opt-in: db/011's generate_on_apply column. */
  readonly preferenceEnabled: boolean;
  /** Whether this person has at least one provider key on file, in
      GENERATION_PROVIDER_ORDER's preference order. */
  readonly hasStoredKey: boolean;
}

export type GenerationTriggerDecision =
  | { readonly go: true }
  | { readonly go: false; readonly reason: string };

/**
 * The one function this file exists for. The four gates are checked in the
 * fixed order the file header lists them in, and this function returns on
 * the FIRST one that fails: a caller that hands in more than one false
 * input always gets back the same reason for the same combination, never
 * whichever check happened to be looked at last. See
 * generation-preference.test.ts for that order pinned as a contract, not
 * merely an implementation detail.
 */
export function decideGenerationTrigger(input: GenerationTriggerGateInput): GenerationTriggerDecision {
  if (!input.keyStorageConfigured) {
    return {
      go: false,
      reason: 'generation-preference: KEY_ENCRYPTION_SECRET is not configured on this deployment.'
    };
  }
  if (!input.byokFlagOn) {
    return { go: false, reason: "generation-preference: the 'byok' flag is off." };
  }
  if (!input.preferenceEnabled) {
    return { go: false, reason: 'generation-preference: this account has not turned on "draft on apply".' };
  }
  if (!input.hasStoredKey) {
    return { go: false, reason: 'generation-preference: this account has no provider key on file.' };
  }
  return { go: true };
}
