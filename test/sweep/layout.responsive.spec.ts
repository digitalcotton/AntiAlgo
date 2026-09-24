import { expect, test, type Page } from 'playwright/test';
import { pageRoutes } from './manifest';
import { isOn } from '../../src/lib/flags';
import { reportIfAccepted, type Annotation } from './ratchet';

/**
 * The viewport dimension the plan did not have.
 *
 * regression-strategy.md Part Two says it outright, under "Still to build":
 * "Nothing in the plan had a viewport dimension until the critic pointed it
 * out: prove-styles.mjs never calls setViewportSize." That is checkable, not
 * just quotable —
 *
 *   grep -rn "setViewportSize\|viewport:" scripts/ test/
 *
 * returns nothing outside this file. scripts/prove-styles.mjs drives Chromium
 * and WebKit across every page, every theme, and diffs computed styles, and
 * it does all of that at whatever the default launch viewport happens to be.
 * A phone has never once loaded this site inside the whole gate.
 *
 * WHY THIS RUNS UNDER `mobile`, NOT A NEW PROJECT. playwright.config.ts
 * already has a `mobile` project on `devices['iPhone 14']` (390×844) matched
 * to `*.responsive.spec.ts`, with no storageState and no `dependencies` — it
 * was wired up for exactly this file and has been running zero specs. This
 * file is what makes it run something.
 *
 * MODELED ON tokenstoagent/site-index/scripts/responsive-audit.mjs, which a
 * reviewer of that repo's own harness called "the baseline-free geometry
 * instrument that died" — died in the sense that nothing runs it as a gate,
 * not that it is wrong. Its header names the two failures that a resize-the-
 * window glance never catches: a phone card printing a salary on top of a
 * location, and a list scrolling the body sideways at 320px, both needing a
 * particular row's data length to show up. This file borrows its two
 * measurements and turns them into assertions with a real pass/fail line,
 * rather than a report a person has to go read.
 *
 * TWO BASELINE-FREE ASSERTIONS. Deliberately not pixels: nothing here can go
 * red because a font shifted or a nightly crawl changed a headline. There is
 * nothing to `conform:accept`, which is the property that let Layer 1 (the
 * console/status sweep) survive where the pixel gate did not.
 *
 *   1. document.documentElement.scrollWidth must not exceed innerWidth. A
 *      page that scrolls sideways on a phone is the single most common
 *      mobile defect there is, and it needs no design opinion to catch — the
 *      document is either as wide as the viewport or it is not.
 *
 *   2. No text-holding leaf element may paint outside the nearest grid or
 *      flex ancestor that lays it out. Two cards side by side at 390px, or a
 *      label and a value in a flex row, are exactly the shape that a fixed
 *      desktop measure or an un-clamped font size breaks first, and exactly
 *      the shape a full-page screenshot diff is worst at localizing — a pixel
 *      diff says "something moved 4px," this says which element, in which
 *      container, by how much.
 *
 * WHAT IS DELIBERATELY NOT CHECKED. An element inside its own
 * `overflow-x: auto` panel (a table built to scroll on a phone) is exempt
 * from both checks, the same exemption responsive-audit.mjs makes: a table
 * that scrolls inside its own frame is a design decision, not a defect, and
 * flagging it would teach a reader to stop trusting the gate within a day.
 */

const ROLE = 'signed-out' as const;

/** iPhone 14's own width (playwright.config.ts's `mobile` project), read back
 *  off the page rather than hardcoded, so this file keeps telling the truth
 *  if that device is ever swapped for another one. */
async function viewportWidth(page: Page): Promise<number> {
  const width = page.viewportSize()?.width;
  if (!width) {
    throw new Error(
      "layout.responsive.spec.ts got no viewport size from Playwright, which means it ran " +
        "under a project with no device viewport configured. It must only run under the " +
        "'mobile' project (devices['iPhone 14']) — check testMatch in playwright.config.ts."
    );
  }
  return width;
}

/** Board- and kill-list rows are paginated client-side by setting `hidden` on
 *  the rows past the first page. A reader reaches every one of them with a
 *  click, so they are part of the page and this reveals them before either
 *  measurement runs — the same fix responsive-audit.mjs's header explains:
 *  the real defect it found lived on page 3, and a sweep that never turns the
 *  page never sees it. */
async function revealPaginatedRows(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const row of document.querySelectorAll('[hidden]')) {
      if (row.classList.contains('job-row') || row.classList.contains('kill-row')) {
        (row as HTMLElement).hidden = false;
      }
    }
  });
}

interface OverflowResult {
  overflow: boolean;
  scrollWidth: number;
  viewportWidth: number;
}

interface Spillover {
  sel: string;
  text: string;
  el: { left: number; right: number; top: number; bottom: number };
  container: { sel: string; left: number; right: number; top: number; bottom: number };
  overBy: number;
}

/** Assertion 1. A one-line measurement: is the document itself wider than the
 *  viewport it was asked to render at. */
function measureOverflow(): OverflowResult {
  const doc = document.documentElement;
  return {
    overflow: doc.scrollWidth > window.innerWidth,
    scrollWidth: doc.scrollWidth,
    viewportWidth: window.innerWidth
  };
}

/** Assertion 2, run inside the page. Walks every leaf that holds text, finds
 *  the nearest grid or flex ancestor laying it out, and reports any whose box
 *  extends past that container's own padding box by more than the tolerance.
 *
 *  ELEMENT-OWN BOX, NOT INK. Unlike responsive-audit.mjs's sibling-collision
 *  check (which needed a Range's unclipped client rects to tell a real
 *  collision from a tidy `text-overflow: ellipsis`), this only needs the
 *  element's own `getBoundingClientRect()`: a leaf with its own
 *  `overflow: hidden` and an ellipsis is, by definition, laid out inside its
 *  assigned box already, so it cannot itself trip this check. What trips it
 *  is a box whose OWN layout — not its clipped-off overflow — is bigger than
 *  the space its container gave it: an unclamped font size, a fixed min-width,
 *  a `white-space: nowrap` label next to something narrower than the label.
 */
function findSpillover(tolerancePx: number): Spillover[] {
  const round = (n: number) => Math.round(n * 100) / 100;
  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const cls =
      typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).join('.')}`
        : '';
    return `${tag}${cls}`.slice(0, 90);
  };

  const scrollsX = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    return (
      (cs.overflowX === 'auto' || cs.overflowX === 'scroll') &&
      (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1
    );
  };
  const insideScroller = (el: Element): boolean => {
    let p = el.parentElement;
    while (p) {
      if (scrollsX(p)) return true;
      p = p.parentElement;
    }
    return false;
  };

  const results: Spillover[] = [];

  for (const el of document.querySelectorAll('main *')) {
    if (el.children.length) continue; // leaf only: an ancestor's own box is the sum of its children's, and would always "overflow" trivially
    const text = (el.textContent ?? '').trim();
    if (!text) continue;

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if ((el as HTMLElement).closest('.visually-hidden')) continue;
    if (insideScroller(el)) continue; // a table built to scroll inside its own frame is a decision, not a defect

    const elRect = el.getBoundingClientRect();
    if (elRect.width === 0 && elRect.height === 0) continue;

    // Walk up to the nearest grid or flex container this leaf sits inside,
    // and check its box against THAT container's padding box. Only the
    // nearest one: a defect belongs to the layout that is actually
    // responsible for sizing this element, and checking every grid/flex
    // ancestor all the way to <body> would flag the same spillover once per
    // nested layer.
    let item: Element = el;
    while (item.parentElement && item.parentElement.tagName !== 'BODY') {
      const container = item.parentElement;
      const containerDisplay = getComputedStyle(container).display;
      if (containerDisplay.includes('grid') || containerDisplay.includes('flex')) {
        const ccs = getComputedStyle(container);
        const cRect = container.getBoundingClientRect();
        const box = {
          left: cRect.left + (parseFloat(ccs.borderLeftWidth) || 0),
          right: cRect.right - (parseFloat(ccs.borderRightWidth) || 0),
          top: cRect.top + (parseFloat(ccs.borderTopWidth) || 0),
          bottom: cRect.bottom - (parseFloat(ccs.borderBottomWidth) || 0)
        };

        const overRight = elRect.right - box.right;
        const overLeft = box.left - elRect.left;
        const overBottom = elRect.bottom - box.bottom;
        const overBy = Math.max(overRight, overLeft, overBottom);

        if (overBy > tolerancePx) {
          results.push({
            sel: describe(el),
            text: text.slice(0, 60),
            el: { left: round(elRect.left), right: round(elRect.right), top: round(elRect.top), bottom: round(elRect.bottom) },
            container: {
              sel: describe(container),
              left: round(box.left),
              right: round(box.right),
              top: round(box.top),
              bottom: round(box.bottom)
            },
            overBy: round(overBy)
          });
        }
        break;
      }
      item = container;
    }
  }

  return results.sort((a, b) => b.overBy - a.overBy);
}

test.describe('no page scrolls sideways on an iPhone 14', () => {
  for (const { path } of pageRoutes(ROLE).filter((r) => r.allowed)) {
    test(`${path} does not overflow horizontally`, async ({ page }) => {
      const width = await viewportWidth(page);
      await page.goto(path, { waitUntil: 'load' });
      await revealPaginatedRows(page);
      await page.evaluate(() => document.fonts.ready);

      const result = await page.evaluate(measureOverflow);

      expect(
        result.overflow,
        `${path} scrolls sideways on an iPhone 14 (${width}px): ` +
          `document.documentElement.scrollWidth is ${result.scrollWidth}px against an ` +
          `innerWidth of ${result.viewportWidth}px, ${result.scrollWidth - result.viewportWidth}px too wide. ` +
          'This is the most common mobile layout defect there is — something on this page ' +
          'does not shrink, wrap, or clamp below its own fixed size.'
      ).toBe(false);
    });
  }
});

/** Routes whose spillover is already recorded in test/conform/accepted.json, by id.
 *  A route not listed here has no accepted spillover and fails on any. */
const accepted: Record<string, string> = {
  '/evidence': 'responsive:src/components/DurationBar.astro:label-inside-overflow'
};

test.describe('no text paints outside its own grid or flex container on an iPhone 14', () => {
  // A pixel or two of tolerance: sub-pixel rounding differs between a flex
  // item's computed width and its rendered box, and a check that fires on
  // that is a check a reader stops trusting within a day — the same lesson
  // gallery.spec.ts's maxDiffPixelRatio was written to teach.
  const TOLERANCE_PX = 2;

  for (const { path } of pageRoutes(ROLE).filter((r) => r.allowed)) {
    test(`${path} keeps every label inside its container`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'load' });
      await revealPaginatedRows(page);
      await page.evaluate(() => document.fonts.ready);

      const spillovers = await page.evaluate(findSpillover, TOLERANCE_PX);

      const report = spillovers
        .slice(0, 5)
        .map(
          (s) =>
            `  ${s.sel} "${s.text}" — element box ${JSON.stringify(s.el)} extends ${s.overBy}px past ` +
            `its container ${s.container.sel}'s box ${JSON.stringify(s.container)}`
        )
        .join('\n');

      const detail =
        `${path} paints ${spillovers.length} text element(s) outside their grid/flex container ` +
        `at iPhone 14 width, beyond a ${TOLERANCE_PX}px tolerance:\n${report}` +
        (spillovers.length > 5 ? `\n  …and ${spillovers.length - 5} more` : '');

      // The ratchet. A spillover the owner has already seen and ruled on is
      // reported into the Playwright report and does not fail the gate; anything
      // else does. /evidence's duration-bar label is the one on the list — its fix
      // is a design decision on a published figure, not a repair, and a browser
      // tier that is red on the day it ships is a tier nobody runs.
      if (spillovers.length > 0) {
        const id = accepted[path];
        if (id && reportIfAccepted(id, detail, (a: Annotation) => test.info().annotations.push(a))) return;
      }

      expect(spillovers.length, detail).toBe(0);
    });
  }
});

/**
 * THE THIRD RENDERING MODE NOBODY CAPTURES: PRINT.
 *
 * src/styles/global.css:444 and src/pages/report.astro:614 and :692 all carry
 * `@media print` blocks, and /report is described in its own page as a
 * printable deliverable. Every check above, and everything `prove-styles.mjs`
 * does, loads the page in *screen* media. Nothing in this repository has ever
 * asked a browser to render /report as paper. A `global.css` edit — say,
 * removing the `!important` on `.hdr, .ftr { display: none }`, or a merge
 * that drops report.astro's dark-theme-to-paper override — has zero effect on
 * anything a screen sweep, a pixel baseline, or a person eyeballing the site
 * would ever see, and would only show up the day someone actually prints the
 * report and gets the site chrome or a black page.
 *
 * WHY /report'S OWN GLOBAL PRINT BLOCK IS THE ONE WORTH PROVING. It exists
 * because themes.css remaps every semantic colour under
 * `:root[data-theme='dark']`, so a reader who prints while the site is in
 * dark mode would otherwise get a sheet of ink instead of a sheet of paper —
 * report.astro's own comment says so. That gives this test an unambiguous,
 * viewport-independent computed value to check: force dark mode, confirm the
 * page actually rendered dark on screen, then emulate print and confirm the
 * background reverts. A grid column count would not do this — at an iPhone 14
 * width `.figure-grid` is already collapsed to one column by report.astro's
 * own *screen* `max-width: 64rem` rule, so print and screen would agree by
 * coincidence and prove nothing at this viewport. A forced-dark background is
 * never coincidentally equal to the forced-light print background.
 *
 * /report IS FLAG-DARK TODAY. flags.config.mjs's `report` flag is off in both
 * editions ("held back until it is ready to be a product surface"), so
 * pageRoutes() never lists it — manifest.ts's browsableRoutes() filters out
 * every `dark` route on purpose, and rightly so for the sweeps above: a 404 is
 * not a layout to check. But per this file's own instructions, a print gate
 * that cannot reach its target must say so loudly rather than quietly pass or
 * silently vanish. So this test always runs, always hits the real route, and:
 *   - if the flag is OFF, it asserts the 404 the flag registry promises,
 *     prints an unmissable warning naming the flag and the file, and STOPS
 *     ITSELF with `test.skip` and a stated reason — visible in the report as
 *     "skipped", never as a quiet pass.
 *   - if the flag is ON, it runs the real assertion: the page has visible
 *     content under print media, and the print block's colour override
 *     actually fired.
 */
const REPORT_PATHS = ['/report', '/report/cover'] as const;
const REPORT_FLAG_ON = isOn('report');

test.describe('print: /report and /report/cover render on paper, not just on screen', () => {
  for (const path of REPORT_PATHS) {
    test(`${path} still has content and the print rules fire under print media`, async ({ page }) => {
      // Forced dark BEFORE navigation, the same way gallery.spec.ts seeds a
      // theme: the pre-paint resolver in BaseLayout reads localStorage before
      // any component script runs, so there is no flash of the other theme
      // to race.
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem('theme', 'dark');
        } catch {
          /* private mode: BaseLayout's data-theme fallback still applies, and
             the assertions below only need document.documentElement to
             report the theme it actually rendered, whatever that is. */
        }
      });

      const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
      const status = response?.status() ?? 0;

      if (!REPORT_FLAG_ON) {
        console.warn(
          `\nPRINT GATE DARK: the 'report' flag is off (flags.config.mjs), so ${path} answers ` +
            `${status} and this test cannot drive a real browser through global.css's or ` +
            "report.astro's @media print blocks. This is the ONE thing this spec cannot verify " +
            'until an owner turns the flag on for real testing — never flip it here to make this ' +
            'pass. The assertion below only checks that the flag-dark 404 itself still holds.\n'
        );
        expect(
          status,
          `${path} is flag-dark ('report' off in flags.config.mjs) and is expected to answer 404 ` +
            'until the flag ships. If this is not 404, the flag gate on this route broke.'
        ).toBe(404);
        test.skip(
          true,
          `'report' flag is off — the live print-media assertions cannot run against a 404 page. ` +
            'Turn the flag on locally (never in this test) to exercise them for real.'
        );
        return;
      }

      expect(status, `${path} answered ${status} while the 'report' flag is on`).toBeLessThan(400);

      // The page actually rendered dark, on screen, before print is ever
      // considered — otherwise "the background changed under print" would be
      // true for the boring reason that it was never dark to begin with.
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.evaluate(() => document.fonts.ready);
      const screenBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      await page.emulateMedia({ media: 'print' });

      // Assertion A: the page still has visible content under print. A print
      // stylesheet that hides too much (an errant `display: none` on `main`,
      // or on `.report` itself) answers this with an empty box, which is
      // exactly the failure mode that has no on-screen symptom at all.
      const main = page.locator('main, [role="main"]').first();
      await expect(
        main,
        `${path} rendered no visible content under print media. A print stylesheet bug that ` +
          'hides the report itself has zero effect on screen and would only be seen the day ' +
          'someone actually prints it.'
      ).toBeVisible();
      const printedText = (await main.innerText()).trim();
      expect(printedText.length, `${path} under print media has an empty main landmark`).toBeGreaterThan(0);

      // Assertion B: a computed value the print block sets that the screen
      // block does not. report.astro's own is:global print block exists
      // specifically to force the paper palette back on even while the site
      // is in dark mode ("a reader who prints while in the dark theme would
      // otherwise get a sheet of ink"). If that block is lost — a bad merge,
      // a selector typo, a specificity regression like the one this whole
      // harness already found once for `.cta` — the background silently stays
      // whatever dark mode set it to, and print stays correct-looking right
      // up until someone actually needs the paper it printed.
      const printBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(
        printBackground,
        `${path}'s printed background (${printBackground}) is identical to its on-screen dark-mode ` +
          `background (${screenBackground}). report.astro's print block is meant to force the paper ` +
          "palette back on regardless of the reader's theme (src/pages/report.astro:~692) — if this " +
          'is equal, that override did not fire and printing in dark mode produces a sheet of ink.'
      ).not.toBe(screenBackground);

      // Assertion C: global.css:444's site chrome rule actually applied. `.hdr`
      // is SiteHeader.astro's real class (report.astro's own print block also
      // hides `.site-header`, a class that does not exist anywhere in this
      // codebase — that duplicate rule is dead and global.css's `.hdr` rule is
      // the one doing the work, so that is the one this checks).
      const header = page.locator('.hdr').first();
      if (await header.count()) {
        await expect(
          header,
          `${path}'s header (.hdr) is still visible under print media. global.css:444's ` +
            '`.hdr, .ftr, .skip-link { display: none !important; }` rule is meant to strip site ' +
            'chrome from every printed page; if it stopped applying, printed reports carry the nav bar.'
        ).toBeHidden();
      }
    });
  }
});
