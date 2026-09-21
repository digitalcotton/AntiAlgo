#!/usr/bin/env node
/**
 * prove-styles: a before/after proof that a change did not move anything on
 * screen. It drives real Chromium and WebKit, both themes, over the set of
 * pages listed below, and records every computed style on a stable set of
 * elements plus the CSS/font resource timings and paint marks. Two JSON
 * captures (a "before" and an "after") can then be diffed: zero style
 * differences is the proof; any diff is a line-by-line list of exactly what
 * moved, on exactly which page, browser, theme and element.
 *
 * USAGE
 *   BASE_URL=https://www.antialgo.ai node scripts/prove-styles.mjs capture before.json
 *   BASE_URL=https://www.antialgo.ai node scripts/prove-styles.mjs capture after.json
 *   node scripts/prove-styles.mjs diff before.json after.json
 *
 * BASE_URL is required for capture mode. STORAGE_STATE, if set, points at a
 * Playwright storageState JSON so pages are captured signed in; otherwise the
 * capture is signed-out and the output says so.
 */

import { chromium, webkit } from 'playwright';
import { writeFile, readFile } from 'node:fs/promises';

const PAGES = ['/', '/board', '/board?location=remote', '/desk', '/jobs-data', '/start'];
const BROWSERS = { chromium, webkit };
const THEMES = ['light', 'dark'];

const FIXED_SELECTORS =
  'html, body, a, h1, .skip-link, .kicker, .mono, .mono-label, .cta, nav a, footer, tr, th, td';

const FONT_SPECS = [
  '400 1em "N27"',
  '500 1em "N27"',
  '700 1em "N27"',
  '400 1em "Basier Square Mono"',
  '500 1em "Basier Square Mono"',
  '600 1em "Basier Square Mono"'
];

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return obj;
}

/** Runs inside the page. Builds the element set, walks each to a stable path,
 * and serializes its full computed style. */
function collect([fixedSelectors, fontSpecs]) {
  function stablePath(el) {
    const segs = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const tag = node.tagName;
      let idx = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === tag) idx += 1;
        sib = sib.previousElementSibling;
      }
      segs.unshift(`${tag}:nth-of-type(${idx})`);
      if (tag === 'HTML') break;
      node = node.parentElement;
    }
    return segs.join('>');
  }

  const set = new Set();
  for (const el of document.querySelectorAll(fixedSelectors)) set.add(el);
  const all = Array.from(document.querySelectorAll('*')).slice(0, 200);
  for (const el of all) set.add(el);

  const styles = {};
  for (const el of set) {
    const key = stablePath(el);
    const cs = getComputedStyle(el);
    const props = {};
    for (let i = 0; i < cs.length; i += 1) {
      const name = cs.item(i);
      props[name] = cs.getPropertyValue(name);
    }
    styles[key] = props;
  }

  const resources = performance
    .getEntriesByType('resource')
    .filter((r) => r.name.endsWith('.css') || r.name.endsWith('.woff2'))
    .map((r) => {
      let name = r.name;
      try {
        name = new URL(r.name).pathname;
      } catch {
        /* keep raw */
      }
      return {
        name,
        startTime: Math.round(r.startTime),
        responseEnd: Math.round(r.responseEnd),
        transferSize: r.transferSize
      };
    })
    .sort((a, b) => a.startTime - b.startTime);

  const paintEntries = performance.getEntriesByType('paint');
  const paint = {};
  for (const p of paintEntries) paint[p.name] = Math.round(p.startTime);

  const fontsPromise = document.fonts.ready.then(() => {
    const fonts = {};
    for (const spec of fontSpecs) fonts[spec] = document.fonts.check(spec);
    return fonts;
  });

  return fontsPromise.then((fonts) => ({
    styles,
    resources,
    fonts,
    paint,
    styleSheetCount: document.styleSheets.length
  }));
}

async function resolveBoardDetailHref(baseUrl, browserType, theme, storageState) {
  const browser = await browserType.launch();
  try {
    const context = await browser.newContext(storageState ? { storageState } : {});
    await context.addInitScript((t) => {
      try {
        localStorage.setItem('theme', t);
      } catch {
        /* ignore */
      }
    }, theme);
    const page = await context.newPage();
    await page.goto(new URL('/board', baseUrl).toString(), { waitUntil: 'networkidle', timeout: 30000 });
    const href = await page.evaluate(() => {
      const a = document.querySelector('a[href^="/board/"]');
      return a ? a.getAttribute('href') : null;
    });
    await context.close();
    return href;
  } finally {
    await browser.close();
  }
}

async function capture(outPath) {
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) {
    console.error('prove-styles: BASE_URL env var is required, e.g. BASE_URL=http://localhost:4321');
    process.exit(1);
  }
  const storageStatePath = process.env.STORAGE_STATE || null;
  let storageState = null;
  if (storageStatePath) {
    storageState = JSON.parse(await readFile(storageStatePath, 'utf8'));
  }

  let pages = [...PAGES];
  const detailHref = await resolveBoardDetailHref(baseUrl, chromium, 'light', storageState).catch((err) => {
    console.error(`prove-styles: could not resolve a board detail slug: ${err.message}`);
    return null;
  });
  if (detailHref) pages.push(detailHref);
  else console.log('prove-styles: no board detail slug found, skipping detail page');

  const data = {};
  let captured = 0;
  let errors = 0;
  const errorLines = [];

  for (const pageKey of pages) {
    data[pageKey] = {};
    for (const [browserName, browserType] of Object.entries(BROWSERS)) {
      let browser;
      try {
        browser = await browserType.launch();
      } catch (err) {
        console.error(`prove-styles: ${browserName} failed to launch: ${err.message}`);
        errors += 1;
        errorLines.push(`${pageKey} | ${browserName} | (launch failed): ${err.message}`);
        continue;
      }
      data[pageKey][browserName] = {};
      for (const theme of THEMES) {
        try {
          const context = await browser.newContext(storageState ? { storageState } : {});
          await context.addInitScript((t) => {
            try {
              localStorage.setItem('theme', t);
            } catch {
              /* ignore */
            }
          }, theme);
          const page = await context.newPage();
          try {
            await page.goto(new URL(pageKey, baseUrl).toString(), {
              waitUntil: 'networkidle',
              timeout: 30000
            });
            const result = await page.evaluate(collect, [FIXED_SELECTORS, FONT_SPECS]);
            data[pageKey][browserName][theme] = result;
            captured += 1;
          } catch (err) {
            data[pageKey][browserName][theme] = { error: err.message };
            errors += 1;
            errorLines.push(`${pageKey} | ${browserName} | ${theme}: ${err.message}`);
          }
          await context.close();
        } catch (err) {
          data[pageKey][browserName][theme] = { error: err.message };
          errors += 1;
          errorLines.push(`${pageKey} | ${browserName} | ${theme}: ${err.message}`);
        }
      }
      await browser.close();
    }
  }

  if (!storageState) {
    data._meta = { signedIn: false, note: 'captured signed-out; STORAGE_STATE was not set' };
  } else {
    data._meta = { signedIn: true };
  }

  await writeFile(outPath, JSON.stringify(sortKeys(data), null, 2), 'utf8');

  const total = pages.length * Object.keys(BROWSERS).length * THEMES.length;
  console.log(
    `prove-styles: captured ${captured}/${total} (pages=${pages.length} x browsers=${Object.keys(BROWSERS).length} x themes=${THEMES.length}), ${errors} error(s)`
  );
  if (errorLines.length) {
    for (const line of errorLines) console.log(`prove-styles:   ${line}`);
  }
  console.log(`prove-styles: wrote ${outPath}`);
}

function* iterCells(data) {
  for (const pageKey of Object.keys(data)) {
    if (pageKey === '_meta') continue;
    const byBrowser = data[pageKey] || {};
    for (const browserName of Object.keys(byBrowser)) {
      const byTheme = byBrowser[browserName] || {};
      for (const theme of Object.keys(byTheme)) {
        yield { pageKey, browserName, theme, cell: byTheme[theme] };
      }
    }
  }
}

async function diff(beforePath, afterPath) {
  const before = JSON.parse(await readFile(beforePath, 'utf8'));
  const after = JSON.parse(await readFile(afterPath, 'utf8'));

  let differences = 0;
  const fontSummaryLines = [];

  for (const { pageKey, browserName, theme, cell: beforeCell } of iterCells(before)) {
    const afterCell = before && after[pageKey] && after[pageKey][browserName] && after[pageKey][browserName][theme];
    if (!afterCell) continue;
    if (beforeCell.error || afterCell.error) continue;

    // styleSheetCount
    if (beforeCell.styleSheetCount !== afterCell.styleSheetCount) {
      console.log(
        `${pageKey} | ${browserName} | ${theme} | styleSheetCount: ${beforeCell.styleSheetCount} -> ${afterCell.styleSheetCount}`
      );
      differences += 1;
    }

    // fonts summary
    if (beforeCell.fonts && afterCell.fonts) {
      const changedFonts = Object.keys(beforeCell.fonts).filter(
        (spec) => beforeCell.fonts[spec] !== afterCell.fonts[spec]
      );
      if (changedFonts.length) {
        fontSummaryLines.push(
          `${pageKey} | ${browserName} | ${theme} | fonts changed: ${changedFonts
            .map((spec) => `${spec}: ${beforeCell.fonts[spec]} -> ${afterCell.fonts[spec]}`)
            .join(', ')}`
        );
      }
    }

    const beforeStyles = beforeCell.styles || {};
    const afterStyles = afterCell.styles || {};
    const beforeKeys = new Set(Object.keys(beforeStyles));
    const afterKeys = new Set(Object.keys(afterStyles));

    for (const key of beforeKeys) {
      if (!afterKeys.has(key)) {
        console.log(`ONLY IN before: ${pageKey} | ${browserName} | ${theme} | ${key}`);
        continue;
      }
      const beforeProps = beforeStyles[key];
      const afterProps = afterStyles[key];
      const propNames = new Set([...Object.keys(beforeProps), ...Object.keys(afterProps)]);
      for (const prop of propNames) {
        const bVal = beforeProps[prop];
        const aVal = afterProps[prop];
        if (bVal !== aVal) {
          console.log(`${pageKey} | ${browserName} | ${theme} | ${key} | ${prop}: ${bVal} -> ${aVal}`);
          differences += 1;
        }
      }
    }
    for (const key of afterKeys) {
      if (!beforeKeys.has(key)) {
        console.log(`ONLY IN after: ${pageKey} | ${browserName} | ${theme} | ${key}`);
      }
    }
  }

  if (fontSummaryLines.length) {
    console.log('--- font load summary ---');
    for (const line of fontSummaryLines) console.log(line);
  }

  console.log(`DIFFERENCES: ${differences}`);
  process.exit(differences === 0 ? 0 : 1);
}

function usage() {
  console.error('Usage:');
  console.error('  node scripts/prove-styles.mjs capture <out.json>   (BASE_URL required, STORAGE_STATE optional)');
  console.error('  node scripts/prove-styles.mjs diff <before.json> <after.json>');
}

async function main() {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'capture') {
    if (!a) {
      usage();
      process.exit(1);
    }
    await capture(a);
    return;
  }
  if (mode === 'diff') {
    if (!a || !b) {
      usage();
      process.exit(1);
    }
    await diff(a, b);
    return;
  }
  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
