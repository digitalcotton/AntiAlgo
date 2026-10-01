/**
 * The daily freshness check: the half of the staleness pair that does not need
 * a reader to be looking.
 *
 * WHAT WAS WRITTEN HERE BEFORE, WHICH WAS NOT TRUE.
 *
 * The paragraph that used to sit here said vercel.json had declared a cron
 * against this path since the deploy was set up. It never had.
 * `git log --oneline -- vercel.json` returns one commit, and that commit carries
 * no `crons` key, so from the day this function shipped until 2026-10-01 nothing
 * invoked it. The function was correct the entire time. It answered correctly to
 * anyone who typed the URL, which was nobody.
 *
 * That sentence is why five consecutive nights of pipeline failures went
 * unnoticed. Every other alarm in this system runs ON the machine being watched,
 * so a mini that is off, asleep or wedged raises none of them; this endpoint is
 * the only one that survives the mini, and it was not running either. A comment
 * claiming a wire exists is worse than no wire, because it closes the question:
 * nobody checks a thing already written down as done.
 *
 * So, as of 2026-10-01, vercel.json carries
 * `"crons": [{ "path": "/api/rebuild", "schedule": "0 22 * * *" }]`. The
 * acceptance test for that is an invocation appearing in the Vercel cron log,
 * not this paragraph. Read the log once before trusting it.
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
 * the cron log red that same evening and it stays red until a push fixes it.
 * That costs no credential, no key and no build, which is the point: an alarm
 * that waits on something Ryan has not set up yet is an alarm that does not
 * exist, and this repository has just spent a day proving how that ends.
 *
 * READING THE ANSWER IS DELIBERATELY UNAUTHENTICATED, AND THAT IS THE WIRING.
 *
 * `handler()` assesses and answers before it looks at a single header. Nothing
 * about the 200 or the 503 depends on CRON_SECRET, on an Authorization header,
 * or on any env var existing. A Vercel cron therefore cannot 401 against this
 * route, which matters more than it sounds: a cron that authenticates against a
 * secret nobody has set yet would log a red 401 every night for a reason that
 * has nothing to do with the pipeline, and an alarm that cries wolf is an alarm
 * that gets ignored, which is where this file started. The secret gates only the
 * deploy hook below, because that is the only thing here that spends money.
 *
 * It follows that the user-agent Vercel puts on a cron request is not checked
 * for either, and must not be: `vercel-cron/1.0` is an ordinary request header
 * that any stranger can type, so treating it as proof of identity would hand the
 * internet the deploy button while protecting an answer the site's own footer
 * already publishes.
 *
 * THE REBUILD IS STILL AVAILABLE, AND IS NOW THE LOUDER SECOND STEP.
 *
 * Set VERCEL_DEPLOY_HOOK_URL and CRON_SECRET, and a stale answer also fires a
 * deployment, which the data contract then fails at 48 hours with a readable
 * sentence, which Vercel emails. Without them this endpoint still knows and
 * still says so; it just says so somewhere only the dashboard shows.
 *
 * Both are project settings rather than code: the hook is created in the Vercel
 * project's Git settings and is a URL to POST to, and CRON_SECRET is any value
 * added to the project's environment variables, which Vercel then starts
 * attaching to its own cron requests as `Authorization: Bearer <value>`. Neither
 * is set as far as this checkout can tell, and neither needs to be for the alarm
 * above to work. So that the first red invocation does not send a reader the
 * wrong way, the stale branch names which of the two is missing instead of
 * reporting a refusal that sounds like an intruder.
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
 * WHY THE CRON IS AT 22:00Z, AND WHY ONLY ONCE A DAY.
 *
 * swept_at_utc is the nightly's FIRE instant, not its finish. Fourteen of the
 * nineteen stamps ever committed to src/data/stats.json read 07:30:00Z through
 * 07:30:04Z, which is 03:30 local, which is the LaunchDaemon; a fifteenth reads
 * 07:41:59Z, the same daemon twelve minutes late. The other four are off-schedule
 * runs by hand: three in the afternoon, one late in the evening. So the live
 * deployment crosses the 36 hour line at 19:30Z on the day after a night that
 * did not publish — and after the 2026-11-01 clock change the mini fires at
 * 08:30Z and the line moves to 20:30Z. Vercel cron is UTC and does not follow a
 * local clock, so one declared time has to clear the later of the two. 22:00Z
 * clears it by an hour and a half in winter and two and a half in summer, which
 * is also the margin for a nightly that starts late: 2026-09-21 stamped
 * 07:41:59Z.
 *
 * In local terms the line always falls at half past three in the afternoon,
 * either half of the year, because the stamp follows the local clock and 36 hours
 * is 36 hours. 22:00Z is six and a half hours later: 18:00 in summer, 17:00 in
 * winter. That is chosen, not left over. The alarm goes red before dinner on the
 * same day the page stopped claiming every row was verified this sweep, rather
 * than at some hour when nobody is going to look at a dashboard. A single missed
 * night is known about roughly fourteen hours after the run that missed it, and
 * no sooner is possible: the 503 cannot exist before 36 hours have passed.
 *
 * One entry, one once-a-day expression, because a Hobby project is capped at two
 * cron jobs and at one invocation per job per day, and nothing in this checkout
 * says which plan the project is on. `"0 11,22 * * *"` would halve the worst-case
 * lag and would also be rejected on Hobby, which fails the deployment — a file
 * about an alarm that was never wired is the wrong place to gamble the deploy on
 * an unread setting. If the project is on Pro, adding the second hour is a safe
 * one-line change and the only thing it buys is a shorter wait.
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
  } else if (!(process.env.CRON_SECRET ?? '').trim()) {
    // Not a refusal, and worth separating from one. Vercel attaches the bearer
    // token only once CRON_SECRET exists on the project, so with no secret there
    // is nothing for mayDeploy() to match and every cron invocation lands here.
    // The first red night should name the setting that is missing rather than
    // read like somebody tried the door, which is the reading the single
    // "refused" sentence used to give it.
    rebuild = 'no CRON_SECRET on this project, so the hook cannot be authorised; set it to let a stale answer rebuild';
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
