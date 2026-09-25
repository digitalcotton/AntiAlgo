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
 * WHY THE VIEWPORT IS 1360x1113 AT deviceScaleFactor 2. That is 2720x2226, the
 * size the existing captures already are, so a new shot drops into the same
 * <img width/height> the page declares and nothing reflows.
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
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'public', 'screens');
const WIDTH = 1360;
const HEIGHT = 1113;

const argv = process.argv.slice(2);
const baseFlag = argv.indexOf('--base');
const BASE = baseFlag === -1 ? 'https://www.antialgo.ai' : argv[baseFlag + 1];
const only = argv.filter((a, i) => !a.startsWith('--') && i !== baseFlag + 1);

/**
 * One shot per entry. `prepare` runs after load and before the picture, and is
 * where a disclosure gets opened or a banner dismissed: whatever the reader
 * would have to do to be looking at what the step is describing.
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
    }
  }
];

/** A live posting with a posted pay range, so the stats row is not half empty. */
async function pickPosting(page) {
  await page.goto(`${BASE}/board?per=25&sort=fit`, { waitUntil: 'domcontentloaded' });
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

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const wanted = SHOTS.filter((s) => only.length === 0 || only.includes(s.id));
  if (wanted.length === 0) throw new Error(`capture: no shot named ${only.join(', ')}`);

  for (const shot of wanted) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 2,
        colorScheme: theme
      });
      // The site's own switch, written before the first paint so the page is
      // never captured mid-flip.
      await context.addInitScript((t) => {
        try {
          localStorage.setItem('theme', t);
        } catch {}
      }, theme);

      const page = await context.newPage();
      const slug = shot.needsLivePosting ? await pickPosting(page) : null;
      const url = `${BASE}${typeof shot.url === 'function' ? shot.url(slug) : shot.url}`;

      await page.goto(url, { waitUntil: 'networkidle' });
      if (shot.prepare) await shot.prepare(page);

      const file = path.join(OUT, `${shot.id}-${theme}.png`);
      await page.screenshot({ path: file });
      console.log(`${shot.id}-${theme}.png  <-  ${url}`);
      await context.close();
    }
  }

  await browser.close();
}

await main();
