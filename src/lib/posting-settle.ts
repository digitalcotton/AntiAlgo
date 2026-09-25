/**
 * posting-settle.ts: finishing a read, once, for both readers.
 *
 * WHY THIS EXISTS. Settling a posting read is two steps that must not come
 * apart: the `desk_posting_fetch` row records what was read, and the Desk card
 * behind it gets its snapshot filled so the card stops saying "Reading the
 * posting from". Until now only `/machine/posting-fetch/result` did that, so
 * the sequence lived inline there and one copy was the whole population. There
 * are two readers now — the mini, and the site itself through
 * `posting-read.ts` — and two copies of a two-step sequence is precisely the
 * thing that drifts: someone fixes the snapshot rule in one route, the other
 * keeps the old one, and a card fills correctly or not depending on which
 * machine happened to read the page. So the sequence moved here and both
 * callers point at it.
 *
 * THE ROW IS THE SOURCE FOR THE SNAPSHOT, NOT THE CALLER'S VALUES. Note that
 * the fill below reads `settled`, the row as the database actually wrote it,
 * rather than the input that was handed in. The store caps and trims on the way
 * in (`NAME_MAX_CHARS`, `DESCRIPTION_MAX_CHARS`), so the row can legitimately
 * hold something shorter than what the caller passed, and a snapshot built from
 * the caller's copy would disagree with the posting page beside it. Reading it
 * back is one fewer way for the card and the page to tell different stories.
 *
 * COMPANY COMES THROUGH addedPostingToJob(), NOT OFF THE ROW. That function
 * already owns the fallback for a posting whose page never named a company —
 * the URL's own hostname — and the card should say the same thing the posting
 * page says. Taking `row.company` directly here would leave the card blank
 * where the page reads "the company site".
 */
import { SNAPSHOT_MAX_CHARS, settlePostingFetch, type SettleInput, type StoredPostingFetch } from './posting-fetch-store';
import { fillApplicationSnapshot } from './desk-store';
import { addedPostingToJob } from './added-posting';
import { plainTextFromHtml } from './vocabulary';

/**
 * Settles a claimed row and, when the read was good, fills the card behind it.
 *
 * Returns the settled row, or null when there was nothing to settle — a row
 * that was not claimed, which both callers answer as "already settled" rather
 * than as an error, because a duplicate result is the expected shape of a
 * retry, not a fault.
 */
export async function settlePostingAndFillSnapshot(
  id: string,
  input: SettleInput
): Promise<(StoredPostingFetch & { userId: string }) | null> {
  const settled = await settlePostingFetch(id, input);
  if (!settled) return null;

  if (input.outcome === 'ready') {
    const job = addedPostingToJob(settled);
    await fillApplicationSnapshot(settled.userId, settled.applicationId, {
      title: settled.title,
      company: job.company,
      description: settled.descriptionHtml
        ? plainTextFromHtml(settled.descriptionHtml).slice(0, SNAPSHOT_MAX_CHARS)
        : null
    });
  }

  return settled;
}
