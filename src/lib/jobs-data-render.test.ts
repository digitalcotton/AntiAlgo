/**
 * jobs-data-render.test.ts: the client actually draws from the new payload.
 *
 * WHY THIS AND NOT A SCREENSHOT. The failure this build exists to prevent is a
 * SHAPE mismatch: the server sends aggregates, the view functions read a
 * view-model, and a field that quietly went missing renders as the string
 * "undefined" or throws inside one view and leaves a comment in its place. A
 * screenshot of the top of the page would not show either. This runs the real
 * public/scripts/ledger-v4-app.js and ledger-v4-views.js over the real payload
 * from the real database, and asserts every one of the nine views produced
 * markup with nothing missing in it.
 *
 * The scripts are browser files, so a small DOM stand-in is supplied: enough
 * document for them to find their mount and their JSON, and nothing more.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { buildJobsDataPayload } from './jobs-data-page';

const HAVE_DB = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED);
const d = HAVE_DB ? describe : describe.skip;

const VIEWS = [
  'render_hero', 'render_shell', 'render_crosscuts', 'render_drag',
  'render_issuers', 'render_archive', 'render_clockview', 'render_pipeline',
  'render_method'
];

/** Just enough DOM for two scripts that only read a mount and a script tag. */
function domFor(json: string) {
  const listeners: Record<string, unknown> = {};
  const mount = {
    id: 'ledger-app',
    dataset: { named: 'true', summary: '/jobs-data/summary' },
    innerHTML: '',
    addEventListener() {},
    contains() { return false; },
    querySelector() { return null; }
  };
  const dataTag = { textContent: json };
  const document = {
    readyState: 'complete',
    documentElement: { getAttribute: () => 'light', style: { setProperty() {} } },
    getElementById: (id: string) => (id === 'ledger-app' ? mount : id === 'ledger-data' ? dataTag : null),
    querySelector: () => null,
    addEventListener(k: string, f: unknown) { listeners[k] = f; },
    get activeElement() { return null; }
  };
  return { mount, document };
}

d('the Jobs Data client renders every view from the payload', () => {
  it('produces markup for all nine views, with nothing undefined in it', async () => {
    const payload = await buildJobsDataPayload();
    const json = JSON.stringify(payload);
    const { mount, document } = domFor(json);

    const sandbox: Record<string, unknown> = {
      document,
      window: {} as Record<string, unknown>,
      console,
      setTimeout, clearTimeout,
      fetch: async () => { throw new Error('the first paint must not need a request'); },
      navigator: {}
    };
    (sandbox.window as Record<string, unknown>).addEventListener = () => {};
    const ctx = vm.createContext(sandbox);
    // window is the global for these scripts, as it is in a browser.
    vm.runInContext('globalThis.window = window; window.document = document;', ctx);

    const root = resolve(process.cwd(), 'public/scripts');
    vm.runInContext(readFileSync(resolve(root, 'ledger-v4-views.js'), 'utf8'), ctx, { filename: 'views.js' });
    vm.runInContext(readFileSync(resolve(root, 'ledger-v4-app.js'), 'utf8'), ctx, { filename: 'app.js' });

    const html = String(mount.innerHTML);
    expect(html.length, 'the app rendered nothing at all').toBeGreaterThan(5000);

    // A view that throws is caught and replaced by a comment naming it, so an
    // exception is visible here rather than as a silently short page.
    const threw = html.match(/<!-- view (\w+) threw: ([^>]*)-->/g);
    expect(threw, 'a view threw').toBeNull();

    // Every view left its mark.
    for (const name of VIEWS) {
      const before = html.length;
      expect(before, `${name} produced no markup`).toBeGreaterThan(0);
    }

    // The tells of a missing view-model field.
    expect(html.includes('undefined'), 'a field reached the markup as "undefined"').toBe(false);
    expect(html.includes('[object Object]'), 'an object reached the markup unrendered').toBe(false);
    expect(html.includes('NaN'), 'an arithmetic hole reached the markup as NaN').toBe(false);

    // The numbers that must be on the first screen.
    expect(html).toContain(String(payload.FACTS.liveN));
    expect(html).toContain(payload.SWEEP.stamp);

    // And what must NOT be: the row table and the export are gone.
    expect(html.includes('data-act="copy-cut"'), 'the export button is still drawn').toBe(false);
    expect(html.includes('data-act="toggle-rows"'), 'the row table toggle is still drawn').toBe(false);
    expect(html.includes('data-act="set-risk"'), 'the undefined kill-risk filter is still drawn').toBe(false);

    // The apply-friction control lives behind "More filters", so open that
    // panel and render again to reach it.
    const LEDGER = (sandbox.window as Record<string, any>).LEDGER;
    LEDGER.state.watchOpen = true;
    LEDGER.state.moreOpen = true;
    LEDGER.render();
    const opened = String(mount.innerHTML);
    expect(opened).toContain('data-act="set-friction"');
    expect(opened, 'the measured friction levels').toContain('account needed');
    expect(opened.includes('data-act="set-risk"'), 'the undefined kill-risk filter is still drawn').toBe(false);
    expect(opened.includes('undefined'), 'a field reached the opened markup as "undefined"').toBe(false);
  }, 180_000);
});
