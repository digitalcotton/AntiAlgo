/**
 * resume-parse-runner.ts: the seam between an upload and a stored parse. It
 * decides, gate by gate, whether a person's own provider key can read their
 * resume, opens a pending parse row, and fires the actual read into the
 * background so the upload endpoint can redirect at once. It is the resume
 * parse's exact analogue of generation-preference-store.ts's
 * triggerBackgroundGeneration()/renderInBackground(), and copies that file's
 * two load-bearing rules:
 *
 * RETURN QUICKLY. startResumeParse() awaits only the go/no-go gates and the
 * beginParse() write, then returns. It must never wait on a network call to a
 * person's own AI provider: a page POST cannot hold a tab open for a
 * multi-second read, which is the whole reason the parse is a background job
 * and a pending row, not an inline response.
 *
 * THE TWO-MOMENTS KEY RULE. The decrypt (getDecryptedKey) happens inside the
 * background function, at the one instant the read fires, never in the caller
 * and never stored. The plaintext key is a local, handed straight to
 * parseResumeWithProvider and closed over nowhere else.
 *
 * FAIL CLOSED, VISIBLY. Every path completes the row 'ready': a provider read
 * that works, a provider read that fails (falls back to the deterministic
 * reader with a reason the review page shows), and a plain no-key read. The
 * one honest dead end, both readers throwing, leaves the row pending and logs,
 * the same single dead end renderInBackground() names.
 */
import { deferWork } from './defer-work';
import { keyStorageIsConfigured } from './keychain';
import { isOn } from './flags';
import { getDecryptedKey, keyMeta } from './keychain-store';
import { GENERATION_PROVIDER_ORDER, PROVIDER_REGISTRY } from './generation-providers';
import { parseResumeDeterministic, parseResumeWithProvider } from './resume-parse';
import { beginParse, clearParse, completeParse, type StoredParseOutcome } from './resume-parse-store';
import { applyParsedProposals } from './resume-parse-apply';
import type { Provider } from './keychain';

/**
 * Opens a pending parse and starts reading. Awaits only the gates and the
 * beginParse() write; the read itself is fired, not awaited. `sourceText` is
 * the already-extracted plain text of the upload (src/lib/resume-extract.ts
 * ran in the request); it is held in memory and passed to the background read,
 * never written to the database.
 */
export async function startResumeParse(userId: string, sourceName: string | null, sourceText: string): Promise<void> {
  // The same gates generation-preference-store.ts runs, cheapest first, no key
  // table touched unless both pass. A person with byok off or no encryption
  // secret configured gets the deterministic reader, not an error.
  const keyStorageConfigured = keyStorageIsConfigured();
  const byokFlagOn = isOn('byok');

  let provider: Provider | null = null;
  if (keyStorageConfigured && byokFlagOn) {
    const stored = await keyMeta(userId);
    // First match in the fixed provider order wins, exactly as drafting picks.
    const chosen = GENERATION_PROVIDER_ORDER.map((id) => stored.find((row) => row.provider === id)).find(
      (row) => row !== undefined
    );
    provider = chosen ? chosen.provider : null;
  }

  await beginParse(userId, sourceName);

  // Deferred, not awaited, and DEFERRED THROUGH THE PLATFORM: a bare void
  // fire on Vercel can be frozen the moment the 303 goes out, leaving the row
  // 'pending' forever (src/lib/defer-work.ts). Never let a rejection escape:
  // a background job's failure is logged, never thrown into a caller that has
  // already returned.
  deferWork(
    parseInBackground(userId, sourceText, provider).catch((error) => {
      console.error(`resume-parse-runner: background parse for user ${userId} threw past its own guard.`, error);
    })
  );
}

/**
 * The background read. Exported for the unit tests to drive directly (there is
 * no other production caller than startResumeParse above). Decrypts the key at
 * the one moment it is needed, reads with the provider, and on any provider
 * failure falls back to the deterministic reader with the reason shown. Always
 * completes the row 'ready' unless BOTH readers throw, which cannot happen for
 * the deterministic one (it is pure) but is caught anyway.
 */
export async function parseInBackground(userId: string, sourceText: string, provider: Provider | null): Promise<void> {
  try {
    let outcome: StoredParseOutcome;

    if (provider) {
      const plaintext = await getDecryptedKey(userId, provider);
      if (!plaintext) {
        // The key was removed between the selection above and this decrypt (a
        // person deleting it in another tab). Not an error: read deterministically.
        outcome = deterministicOutcome(sourceText, 'the connected provider key was no longer available');
      } else {
        const result = await parseResumeWithProvider(sourceText, provider, plaintext);
        if (result.ok) {
          const def = PROVIDER_REGISTRY[provider];
          outcome = {
            method: 'llm',
            providerLabel: `${def.label} (${def.copyModel})`,
            fallbackReason: null,
            proposals: result.proposals,
            notes: result.notes
          };
        } else {
          // The row stores the person-facing sentence; the server log carries
          // the same sentence with the who and the which, so a failure in
          // production is diagnosable from the logs without asking the person
          // to reproduce it. The sentence is built only from facts our own
          // code minted (resume-parse.ts providerFailureReason), so this
          // cannot log a key.
          console.error(
            `resume-parse-runner: provider read failed for user ${userId} (${provider}): ${result.reason}`
          );
          outcome = deterministicOutcome(sourceText, result.reason);
        }
      }
    } else {
      outcome = deterministicOutcome(sourceText, null);
    }

    await completeParse(userId, outcome);

    // Land the read in the record straight away (resume-parse-apply.ts): the
    // owner wants an upload to become record rows without a confirm click. The
    // buffer is cleared only after the apply succeeds; if the apply itself
    // throws, the row stays 'ready' so the review screen still offers the
    // proposals rather than losing them.
    try {
      const applied = await applyParsedProposals(userId, outcome.proposals);
      console.log(
        `resume-parse-runner: applied the read for user ${userId}: ${applied.created} entries created, ${applied.failed} failed, ${applied.links} links, name ${applied.name ? 'set' : 'kept'}.`
      );
      await clearParse(userId);
    } catch (applyError) {
      console.error(`resume-parse-runner: could not apply the read for user ${userId}; leaving it for review.`, applyError);
    }
  } catch (error) {
    // The one honest dead end: the deterministic reader is pure and does not
    // throw, so reaching here means the decrypt or the completeParse write
    // itself failed. Leave the row pending (the review page keeps refreshing,
    // which is the truthful state) and log, the same dead end renderInBackground
    // names for a render that cannot finish either way.
    console.error(`resume-parse-runner: parse for user ${userId} could not complete; row left pending.`, error);
  }
}

/** Builds a deterministic outcome. `fallbackReason` is set only when a
    provider read was attempted and failed (so the review page can say the key
    could not be used); it is null for a plain no-key read, which is not a
    fallback, just the only reader a keyless person has. */
function deterministicOutcome(sourceText: string, fallbackReason: string | null): StoredParseOutcome {
  const { proposals, notes } = parseResumeDeterministic(sourceText);
  return {
    method: 'deterministic',
    providerLabel: null,
    fallbackReason,
    proposals,
    notes
  };
}
