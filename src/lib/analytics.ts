/**
 * First-party funnel analytics, behind the `analytics` flag. One function,
 * recordEvent, called at the four milestones that answer "of the people who
 * sign up, how many build a profile, apply, and draft": signup, first_entry,
 * apply, first_draft. db/028_analytics_event.sql holds one row per (user,
 * milestone), so calling this on every entry or every apply is safe: the
 * ON CONFLICT keeps only the first.
 *
 * BEST EFFORT, ALWAYS, AND THAT IS THE WHOLE DESIGN. Analytics must never break
 * the thing it measures. A missing table (this migration has not run in an
 * environment yet), an unreachable database, a flag that is off, anything at
 * all: recordEvent swallows it and returns. A lost count is acceptable; a
 * failed signup or a failed apply because a count could not be written is not.
 * So every caller can `await recordEvent(...)` right beside the real write
 * without a try/catch of its own, and nothing it does can throw.
 *
 * NO THIRD PARTY. This writes to our own Postgres and nowhere else. There is no
 * script tag, no pixel, no external endpoint; the covenant's "no ad tech" line
 * is kept by there being nothing here that could reach one.
 */
import { db } from './db';
import { isOn } from './flags';

/** The fixed milestone vocabulary. A union rather than a free string so a typo
    cannot invent a milestone the funnel query will never look for. */
export type AnalyticsEvent = 'signup' | 'first_entry' | 'first_draft' | 'apply';

/**
 * Record that a user reached a funnel milestone, at most once per milestone.
 * A no-op when the flag is off or the user id is empty; otherwise a single
 * ON CONFLICT DO NOTHING insert whose every failure mode is swallowed.
 */
export async function recordEvent(userId: string, event: AnalyticsEvent): Promise<void> {
  if (!isOn('analytics')) return;
  if (!userId) return;
  try {
    await db().query(
      `INSERT INTO analytics_event (user_id, event) VALUES ($1, $2)
       ON CONFLICT (user_id, event) DO NOTHING`,
      [userId, event]
    );
  } catch {
    // Deliberately swallowed. See this file's header: analytics never breaks the
    // funnel action it observes. A missing table before the migration runs, an
    // unreachable database, a transient error: all end here, silently, so the
    // real write the caller just made stands on its own.
  }
}
