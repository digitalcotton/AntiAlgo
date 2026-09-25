/**
 * capture-screens.mjs: the marketing captures on /how-it-works, taken from the
 * running product rather than drawn.
 *
 * WHY THIS EXISTS HERE NOW. The old captures were taken with the index repo's
 * Playwright and hand-copied into public/screens/. That was fine until the
 * product moved: Job Detail v2 shipped on 2026-09-18 and the step 01 capture
 * kept showing the retired layout (a "Back to the index" crumb, a PROVENANCE
 * sidebar, a "New here?" strip), so the page was advertising a site that no
 * longer exists. Playwright lives in this repo now, so the capture does too,
 * and re-taking a stale shot is one command instead of an archaeology project.
 *
 * WHY IT SHOOTS PRODUCTION BY DEFAULT. These are pictures of the real thing.
 * A local dev capture would show whatever seed rows the local database happens
 * to hold, and a marketing page carrying invented postings is the one thing
 * this whole site is against. Pass --base to point it somewhere else.
 *
 * AND WHY ONE SHOT CANNOT. A step that only exists for a signed-in paid reader
 * holding a provider key cannot be photographed on production without signing
 * into somebody's real account and photographing their real record. So
 * hiw-tailor is marked `local` and runs the whole harness itself: it resets and
 * seeds antialgo_test, starts a dev server on that database, has
 * test/sweep/auth.setup.ts mint the `capture` session (a paid account with a
 * provider key on file), takes the picture and tears the server down again.
 * That posting is a fixture, not a crawled job, and that is a real cost — it is
 * named in this file, in the page's own header, and in the figcaption under the
 * image, because a seeded posting presented as a live one would be the same lie
 * this script was written to stop.
 *
 * WHY THE VIEWPORT IS 1360x1113 AT deviceScaleFactor 2. That is 2720x2226, the
 * size the existing captures already are, so a new shot drops into the same
 * <img width/height> the page declares and nothing reflows. A shot may name its
 * own height when the thing it is describing does not fit in that one; it must
 * then agree with the <img width/height> in how-it-works.astro, or the page
 * reflows as the image loads.
 *
 * Theme is set by writing localStorage.theme before the first paint, which is
 * the same switch the site's own inline script reads (BaseLayout.astro), so the
 * capture goes through the real code path rather than a forced media emulation.
 *
 *   node scripts/capture-screens.mjs                 # every shot
 *   node scripts/capture-screens.mjs hiw-01          # one
 *   node scripts/capture-screens.mjs --base http://localhost:4321
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sweepEnv } from '../test/sweep/env.mjs';

const OUT = path.join(process.cwd(), 'public', 'screens');
const WIDTH = 1360;
const HEIGHT = 1113;

/** Where the local harness serves. Deliberately not 4321: the owner usually has
 *  a dev server open there against antialgo_dev, and a capture that quietly
 *  attached to it would be a picture of whatever last night's crawl left in that
 *  database, taken as a signed-out visitor because the session was signed with a
 *  different secret. Its own port, its own database, every time. */
const LOCAL_ORIGIN = 'http://localhost:4319';

const argv = process.argv.slice(2);
const baseFlag = argv.indexOf('--base');
const BASE_OVERRIDE = baseFlag === -1 ? null : argv[baseFlag + 1];
const PROD_BASE = BASE_OVERRIDE ?? 'https://www.antialgo.ai';
const only = argv.filter((a, i) => !a.startsWith('--') && i !== baseFlag + 1);

/**
 * One shot per entry. `prepare` runs after load and before the picture, and is
 * where a disclosure gets opened or a banner dismissed: whatever the reader
 * would have to do to be looking at what the step is describing.
 *
 * `verify` runs last, immediately before the shutter, and its only job is to
 * refuse. Every capture in this file is of a conditional surface, and the
 * conditions fail SILENTLY — a rejected session renders a perfectly good
 * signed-out page, an account with no key renders a perfectly good link where
 * the form should be. Both would produce a screenshot that looks fine and says
 * the wrong thing, on the one page of this site whose whole subject is not
 * saying the wrong thing. So each shot states what has to be on the screen and
 * this script throws rather than write a file that does not show it.
 */
const SHOTS = [
  {
    id: 'hiw-01',
    // Step 01 is "Find one that's real": the provenance, open, on a posting a
    // stranger can read without an account. Signed out on purpose, so the Fit
    // cell shows the sign-in prompt and the capture does not promise a reading
    // the reader has not earned yet.
    url: (slug) => `/board/${slug}`,
    needsLivePosting: true,
    async prepare(page) {
      const history = page.locator('details.jd-history');
      if (await history.count()) await history.first().evaluate((el) => (el.open = true));
      // Let the disclosure finish before the shutter.
      await page.waitForTimeout(150);
    },
    async verify(page) {
      // The signed-OUT reading, which is the whole point of this shot: fit is a
      // signed-in reading and this capture must show the prompt, not a score.
      await page.locator('#jd-actions').first().waitFor({ state: 'attached' });
    }
  },
  {
    id: 'hiw-tailor',
    // Step 03 is "Tailor in minutes, on your key", and the screen it describes
    // is JobDetailV2's action rail in its real state: the reason field, the
    // orange primary, and beside it the fit card with the score and the five
    // components that add up to it. That state is `signedIn && hasKey` inside
    // `paid` (JobDetailV2.astro), which is why this one runs locally as the
    // `capture` role rather than against production.
    local: true,
    session: 'capture',
    // scripts/test-db.mjs's fixture-001: Figma, Senior Product Designer,
    // $150,000-$210,000, fit 92 over five real components. Named here rather
    // than discovered, because a marketing capture should be the same picture
    // every time it is re-taken, not whichever row sorted first that day.
    url: () => '/board/figma-senior-product-designer',
    // Taller than the default frame: the rail and the fit card are in different
    // rows of JobDetailV2's layout (row 1 is posting + rail, row 2 is
    // description + fit), and the step is about both.
    height: 1430,
    async prepare(page) {
      // The fit card renders server-side; wait for it rather than for a timer,
      // then make sure the frame starts at the top of the page.
      await page.locator('.jd-fit-total').first().waitFor({ state: 'attached' });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(250);
    },
    async verify(page) {
      const rail = page.locator('#jd-actions');
      // THE FORM, not the keyless link. Both carry the same label, so the label
      // proves nothing; the textarea is the one element that exists only for a
      // reader the session actually signed in and whose key actually decrypted.
      const reason = rail.locator('#jd-reason');
      if ((await reason.count()) === 0) {
        throw new Error(
          'capture hiw-tailor: no #jd-reason on the page, so this would have been a ' +
            'picture of the keyless link, not the tailoring rail. Either the session ' +
            'did not sign in (check that the dev server and auth.setup.ts share ' +
            'BETTER_AUTH_SECRET — test/sweep/env.mjs) or the capture account has no ' +
            'readable provider key (KEY_ENCRYPTION_SECRET, same file).'
        );
      }
      // And the fit card showing a real reading rather than the signed-out prompt.
      // Two checks, because they fail differently: the prompt being present means
      // the session did not sign in, and the score being absent means the fit slot
      // rendered some third thing this shot was not written for.
      if ((await page.getByText('Sign in to see your fit').count()) > 0) {
        throw new Error(
          'capture hiw-tailor: the fit slot is still showing the signed-out prompt, so ' +
            'the page does not believe this session is signed in.'
        );
      }
      const score = await page.locator('.jd-fit-total').first().innerText();
      if (!/\d/.test(score)) {
        throw new Error(`capture hiw-tailor: the fit card shows no score (read "${score}").`);
      }
    }
  }
];

/** A live posting with a posted pay range, so the stats row is not half empty. */
async function pickPosting(page, base) {
  await page.goto(`${base}/board?per=25&sort=fit`, { waitUntil: 'domcontentloaded' });
  const slug = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-job-row]'));
    for (const row of rows) {
      const href = row.querySelector('a[href*="/board/"]')?.getAttribute('href');
      if (!href) continue;
      // A row that prints a currency somewhere has a posted range.
      if (/\$\s?\d/.test(row.textContent ?? '')) return href.split('/').pop();
    }
    const first = rows[0]?.querySelector('a[href*="/board/"]')?.getAttribute('href');
    return first ? first.split('/').pop() : null;
  });
  if (!slug) throw new Error('capture: no posting on the board to shoot');
  return slug;
}

/** Runs a command to completion, inheriting stdio, and rejects on a non-zero exit
 *  rather than carrying on with a half-built database. */
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`capture: \`${command} ${args.join(' ')}\` exited ${code}`))
    );
  });
}

/** True once the origin answers something that is not a server error. */
async function serving(origin) {
  try {
    const response = await fetch(origin, { redirect: 'manual' });
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Everything a `local` shot needs, built here and torn down by the returned
 * function: a freshly seeded antialgo_test, a dev server reading it, and a
 * minted session for every sweep role (including `capture`, the paid account
 * carrying a provider key).
 *
 * The order matters. The database is reset first, because auth.setup.ts writes
 * accounts into it and a reset afterwards would delete the session it just
 * minted. The dev server is started before the minting only so the two are not
 * racing for the same migration lock on first boot.
 */
async function startLocalHarness() {
  const env = sweepEnv(LOCAL_ORIGIN);
  const url = new URL(env.DATABASE_URL);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(
      `capture refuses to build its harness against ${url.hostname}. It drops and ` +
        'recreates a database and writes accounts into it; that only ever happens on localhost.'
    );
  }

  // NOT under `env`. scripts/test-db.mjs reads DATABASE_URL as "your normal local
  // development database", snapshots its table and row counts, and asserts at the
  // end that it stayed untouched; handed antialgo_test there it refuses outright
  // and says so. It knows the name of the database it builds — that is the whole
  // point of it — so it gets the ordinary environment, the same one
  // `npm run db:test:reset` gives it.
  console.log('capture: resetting antialgo_test');
  await run('node', ['scripts/test-db.mjs', 'reset'], {});
  await run('node', ['scripts/test-db.mjs', 'seed'], {});

  console.log(`capture: starting a dev server on ${LOCAL_ORIGIN}`);
  // detached, so the child gets a process group of its own and `stop` can kill
  // the whole tree. `npm run dev` is a shell that spawns astro; killing the npm
  // process alone leaves astro holding port 4319 and the next capture attaches to
  // a server built from the previous run's code.
  const server = spawn('npm', ['run', 'dev', '--', '--port', new URL(LOCAL_ORIGIN).port], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // Already gone, which is the outcome we wanted.
    }
  };
  process.on('exit', stop);

  const deadline = Date.now() + 120_000;
  while (!(await serving(LOCAL_ORIGIN))) {
    if (Date.now() > deadline) {
      stop();
      throw new Error(
        `capture: the dev server never came up on ${LOCAL_ORIGIN} within 120s. A 500 here is ` +
          'usually src/lib/data-contract.ts refusing stale src/data/stats.json — but DATA_CONTRACT_NOW ' +
          'is pinned from that same file, so check the server output above for the real reason.'
      );
    }
    if (server.exitCode !== null) {
      throw new Error(`capture: the dev server exited ${server.exitCode} before it served anything.`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // E2E_BASE_URL set means playwright.config.ts treats this as a remote sweep and
  // does NOT start (and then tear down) a webServer of its own — which is exactly
  // right: the server it would kill is the one we are about to photograph.
  console.log('capture: minting the signed-in sessions');
  await run('npx', ['playwright', 'test', '--project=setup', '--reporter=line'], {
    ...env,
    E2E_BASE_URL: LOCAL_ORIGIN
  });

  return stop;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const wanted = SHOTS.filter((s) => only.length === 0 || only.includes(s.id));
  if (wanted.length === 0) throw new Error(`capture: no shot named ${only.join(', ')}`);

  let stopHarness = null;
  if (wanted.some((s) => s.local)) stopHarness = await startLocalHarness();

  const browser = await chromium.launch();
  try {
    for (const shot of wanted) {
      const base = shot.local ? LOCAL_ORIGIN : PROD_BASE;
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width: WIDTH, height: shot.height ?? HEIGHT },
          deviceScaleFactor: 2,
          colorScheme: theme,
          ...(shot.session ? { storageState: `.sweep/auth/${shot.session}.json` } : {})
        });
        // The site's own switch, written before the first paint so the page is
        // never captured mid-flip.
        await context.addInitScript((t) => {
          try {
            localStorage.setItem('theme', t);
          } catch {}
        }, theme);

        const page = await context.newPage();
        const slug = shot.needsLivePosting ? await pickPosting(page, base) : null;
        const url = `${base}${typeof shot.url === 'function' ? shot.url(slug) : shot.url}`;

        await page.goto(url, { waitUntil: 'networkidle' });
        if (shot.local) {
          // The Astro dev toolbar is the dev SERVER's furniture, not the
          // product's: it is injected by `astro dev` and exists on no deployed
          // page. It sits bottom-centre, which is inside every frame this file
          // takes. Hidden rather than configured away, because disabling it in
          // astro.config.mjs would take it off the owner's own dev server too.
          await page.addStyleTag({ content: 'astro-dev-toolbar { display: none !important; }' });
        }
        if (shot.prepare) await shot.prepare(page);
        if (shot.verify) await shot.verify(page);

        const file = path.join(OUT, `${shot.id}-${theme}.png`);
        await page.screenshot({ path: file });
        console.log(`${shot.id}-${theme}.png  <-  ${url}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    if (stopHarness) stopHarness();
  }
}

await main();
