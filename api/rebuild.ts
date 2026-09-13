/**
 * The daily freshness check: the half of the staleness pair that does not need
 * a reader to be looking.
 *
 * WHAT WAS HERE BEFORE, WHICH WAS NOTHING.
 *
 * vercel.json has declared a cron against this path since the deploy was set
 * up, and this file did not exist. A Vercel cron against a path with no
 * function behind it does not rebuild anything: it is a scheduled GET that
 * either 404s or, once the /jobs rewrite has had its say, returns a page. The
 * guard the comment in vercel.json described was a comment. That is worse than
 * having no guard, because the reason for not building one was already written
 * down as done.
 *
 * WHY A REBUILD WAS THE WRONG MECHANISM ANYWAY.
 *
 * The plan was: rebuild every day, and the 48 hour check in the data contract
 * fails the build on a silent night. That works, but it buys one subtraction
 * with a full install, a full Astro build and a deploy. And a failed build
 * changes nothing a visitor sees, because Vercel keeps serving the last good
 * deployment. So the rebuild was never the fix. It was only ever the alarm.
 *
 * WHAT THIS DOES INSTEAD.
 *
 * The deployment carries its own stats.json, bundled at build time, so this
 * function already knows the exact instant the data behind the currently live
 * pages was swept. It subtracts that from now and answers with a status code:
 *
 *   200  the live deployment's data is inside the reader's freshness window
 *   503  it is not, which means a sweep did not run or a push did not land
 *
 * Vercel records the status of every cron invocation, so a silent night turns
 * the cron log red the next morning and it stays red until a push fixes it.
 * That costs no credential, no key and no build, which is the point: an alarm
 * that waits on something Ryan has not set up yet is an alarm that does not
 * exist, and this repository has just spent a day proving how that ends.
 *
 * THE REBUILD IS STILL AVAILABLE, AND IS NOW THE LOUDER SECOND STEP.
 *
 * Set VERCEL_DEPLOY_HOOK_URL and CRON_SECRET, and a stale answer also fires a
 * deployment, which the data contract then fails at 48 hours with a readable
 * sentence, which Vercel emails. Without them this endpoint still knows and
 * still says so; it just says so somewhere only the dashboard shows. See
 * DECISIONS.md under Blocked for what creating those two involves.
 *
 * WHY THE THRESHOLD IS THE READER'S 36 AND NOT THE BUILD'S 48.
 *
 * Both numbers live in src/lib/data-contract.ts and they answer different
 * questions. 48 is the point past which a build refuses to render a push. 36 is
 * the point past which the index band stops telling a reader that every row was
 * verified this sweep. This alarm has to fire no later than the page stops
 * making the claim, so it takes the reader's number. In practice that is one
 * missed night rather than two.
 *
 * WHY A FIXTURE NEVER ALARMS.
 *
 * src/data/ still holds the labelled sweep 001 fixture, which is a photograph
 * of one night and is stale by construction the day after it was taken. The
 * data contract makes exactly this exception for exactly this reason. An alarm
 * that is red every day between now and the first successful push is not an
 * alarm, it is a light nobody looks at, so a file that declares itself a
 * fixture reports its age and returns 200.
 *
 * WHY THE DECISION IS A SEPARATE PURE FUNCTION.
 *
 * `assess()` takes the sweep instant, whether the file is labelled a fixture,
 * and the instant to judge it at, and returns the status and the body. It
 * touches no environment, no network and no clock. That is what lets
 * scripts/prove-staleness-pair.mjs put it at four chosen instants and check all
 * four states, including the two nobody can reach by waiting. `handler()` is
 * then only the wiring: the bundled data, the real clock, and the deploy hook.
 */

import stats from '../src/data/stats.json';
import { FRESH_WINDOW_HOURS, isFixture } from '../src/lib/data-contract';

export const config = { runtime: 'edge' };

const MS_PER_HOUR = 3_600_000;

export type FreshnessState = 'fresh' | 'stale' | 'fixture' | 'unreadable';

export interface Assessment {
  status: number;
  state: FreshnessState;
  body: Record<string, unknown>;
}

/**
 * The whole decision, with no world attached.
 *
 * Hours are floored so the number printed is never ahead of the truth: an age
 * of 35.9 reports as 35 and does not alarm, which is the same rounding the band
 * in the reader's browser does.
 */
export function assess(sweptAtUtc: string, fixture: boolean, nowMs: number): Assessment {
  const sweptAt = Date.parse(sweptAtUtc);
  if (Number.isNaN(sweptAt)) {
    // Not staleness. The deployment shipped a clock it cannot read, which is a
    // defect in the push rather than a missed night, and it says which.
    return {
      status: 500,
      state: 'unreadable',
      body: {
        state: 'unreadable',
        swept_at_utc: sweptAtUtc,
        detail: 'stats.swept_at_utc is not a date this deployment can parse.'
      }
    };
  }

  const ageHours = Math.floor((nowMs - sweptAt) / MS_PER_HOUR);
  const base = {
    swept_at_utc: sweptAtUtc,
    age_hours: ageHours,
    fresh_window_hours: FRESH_WINDOW_HOURS
  };

  if (fixture) {
    return {
      status: 200,
      state: 'fixture',
      body: {
        ...base,
        state: 'fixture',
        detail:
          'This deployment is serving the labelled build fixture, which is a photograph of one night and ages on purpose. No alarm until the first real push lands.'
      }
    };
  }

  if (ageHours < FRESH_WINDOW_HOURS) {
    return { status: 200, state: 'fresh', body: { ...base, state: 'fresh' } };
  }

  return {
    status: 503,
    state: 'stale',
    body: {
      ...base,
      state: 'stale',
      detail: `The live deployment's data was swept ${ageHours} hours ago, past the ${FRESH_WINDOW_HOURS} hour window the index band promises. A sweep did not run, or a push did not land.`
    }
  };
}

const answer = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // The whole point is the answer at this instant. A cached one is the bug
      // this endpoint exists to catch, wearing the endpoint's own clothes.
      'Cache-Control': 'no-store'
    }
  });

/**
 * Whether this request may cause a deployment.
 *
 * Vercel attaches `Authorization: Bearer $CRON_SECRET` to a cron invocation
 * whenever CRON_SECRET is set on the project, and attaches nothing when it is
 * not. So the rule is: firing the hook requires the secret to exist and to
 * match. Reading the answer does not, because the answer contains only the
 * sweep instant the site's own footer already publishes.
 *
 * With no secret configured the endpoint still reports and still raises the
 * cron alarm; it simply cannot be used by a stranger to spend build minutes.
 */
function mayDeploy(request: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? '').trim();
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export default async function handler(request: Request): Promise<Response> {
  const verdict = assess(stats.swept_at_utc, isFixture(stats), Date.now());
  if (verdict.state !== 'stale') return answer(verdict.status, verdict.body);

  // Stale. The 503 goes out whatever happens next; the hook is the second,
  // louder channel and its outcome is reported rather than swallowed.
  let rebuild: string;
  const hook = (process.env.VERCEL_DEPLOY_HOOK_URL ?? '').trim();
  if (!hook) {
    rebuild = 'no VERCEL_DEPLOY_HOOK_URL on this project, so nothing was triggered';
  } else if (!mayDeploy(request)) {
    rebuild = 'refused: this request did not carry the cron secret';
  } else {
    try {
      const hit = await fetch(hook, { method: 'POST' });
      rebuild = hit.ok
        ? 'deploy hook fired, so the build will now run the 48 hour contract check'
        : `deploy hook answered ${hit.status}`;
    } catch {
      rebuild = 'deploy hook unreachable';
    }
  }

  return answer(verdict.status, { ...verdict.body, rebuild });
}
