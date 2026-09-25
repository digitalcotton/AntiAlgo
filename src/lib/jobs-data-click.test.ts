/**
 * jobs-data-click.test.ts: what happens when a reader presses a filter.
 *
 * WHY IT EXISTS. jobs-data-render.test.ts proves the first paint, and it stubs
 * fetch to THROW, on purpose, to prove the first paint needs no request. So the
 * page's only interaction, press a filter and watch every chart redraw, was the
 * one thing no test touched: the client's own click handler, the query string it
 * builds, the endpoint's allowlist, the real queries, and the redraw from the
 * response. A wiring mistake anywhere along that chain would have passed
 * everything else.
 *
 * NOTHING ALONG THE CHAIN IS MOCKED EXCEPT WHO IS ASKING. fetch is wired to the
 * real GET handler from src/pages/jobs-data/summary.ts, which runs the real
 * filter parsing, the real cache and the real SQL against the real database.
 * Only the viewer is faked, because the point here is the round trip and the
 * gate has its own tests in jobs-data-access.test.ts.
 *
 * Needs a database; skips rather than passing without one.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const viewerFrom = vi.fn();
vi.mock('./viewer', () => ({ viewerFrom: (...a: unknown[]) => viewerFrom(...a) }));

const { buildJobsDataPayload } = await import('./jobs-data-page');
const { liveAggregates } = await import('./jobs-data-agg');
const { NO_FILTERS } = await import('./jobs-data-filters');
const { GET } = await import('../pages/jobs-data/summary');

const HAVE_DB = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED);
const d = HAVE_DB ? describe : describe.skip;

const PAID = { userId: 'click-test', tier: 'paid', emailVerified: true };

/**
 * A DOM stand-in that actually dispatches clicks, so the client's own onClick
 * runs rather than the test reaching past it into internals. A press is an
 * event whose target closes onto an element carrying data-act and data-val,
 * which is exactly the shape the views emit.
 */
function harness(json: string) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const mount = {
    id: 'ledger-app',
    dataset: { named: 'true', summary: '/jobs-data/summary' },
    innerHTML: '',
    addEventListener(kind: string, fn: (e: unknown) => void) { handlers[kind] = fn; },
    contains() { return true; },
    querySelector() { return null; }
  };
  const document = {
    readyState: 'complete',
    documentElement: { getAttribute: () => 'light', style: { setProperty() {} } },
    getElementById: (id: string) =>
      (id === 'ledger-app' ? mount : id === 'ledger-data' ? { textContent: json } : null),
    querySelector: () => null,
    addEventListener() {},
    get activeElement() { return null; }
  };
  /** Press a control, the way a reader does. */
  const press = (act: string, val?: string) => {
    const el = { dataset: { act, ...(val === undefined ? {} : { val }) } };
    handlers.click?.({ target: { closest: (sel: string) => (sel === '[data-act]' ? el : null) } });
  };
  return { mount, document, press };
}

/** The requests the client actually made, in order. */
let requested: string[] = [];

/**
 * `hold` lets a test delay the Nth response, so an EARLIER request can be made
 * to answer AFTER a later one. That is the race the client's sequence guard
 * exists for, and it cannot be observed without forcing the order.
 */
async function boot(json: string, hold?: (n: number) => Promise<void>) {
  const h = harness(json);
  requested = [];
  let nth = 0;
  const sandbox: Record<string, unknown> = {
    document: h.document,
    window: {} as Record<string, unknown>,
    console, setTimeout, clearTimeout, navigator: {},
    // The real endpoint, reached the way the browser reaches it.
    fetch: async (url: string, init: RequestInit) => {
      const mine = nth++;
      requested.push(url);
      if (hold) await hold(mine);
      return GET({
        request: new Request('https://www.antialgo.ai' + url, {
          headers: { ...(init?.headers as Record<string, string>), 'x-forwarded-for': '10.0.0.7' }
        }),
        locals: {}
      } as never);
    }
  };
  (sandbox.window as Record<string, unknown>).addEventListener = () => {};
  const ctx = vm.createContext(sandbox);
  vm.runInContext('globalThis.window = window; window.document = document;', ctx);
  const root = resolve(process.cwd(), 'public/scripts');
  vm.runInContext(readFileSync(resolve(root, 'ledger-v4-views.js'), 'utf8'), ctx, { filename: 'views.js' });
  vm.runInContext(readFileSync(resolve(root, 'ledger-v4-app.js'), 'utf8'), ctx, { filename: 'app.js' });
  return { ...h, LEDGER: (sandbox.window as Record<string, any>).LEDGER };
}

/** The client coalesces presses for 90ms, then awaits a round trip. */
const settle = () => new Promise((r) => setTimeout(r, 900));

let PAGE_JSON = '';
beforeAll(async () => {
  if (!HAVE_DB) return;
  viewerFrom.mockResolvedValue(PAID);
  PAGE_JSON = JSON.stringify(await buildJobsDataPayload());
}, 180_000);

d('pressing a filter', () => {
  it('asks the endpoint for that cut and redraws every chart from the answer', async () => {
    viewerFrom.mockResolvedValue(PAID);
    const { LEDGER, mount, press } = await boot(PAGE_JSON);

    const before = LEDGER.agg.cutN;
    const beforeHtml = String(mount.innerHTML);
    expect(requested, 'the first paint must not need a request').toHaveLength(0);

    press('set-where', 'remote only');
    await settle();

    // It asked for the right cut, and only once.
    expect(requested).toEqual(['/jobs-data/summary?where=remote%20only']);

    // It got the same numbers a direct query gives for those filters.
    const truth = await liveAggregates({ ...NO_FILTERS, where: 'remote only' });
    expect(LEDGER.agg.cutN).toBe(truth.cutN);
    expect(LEDGER.agg.pricedN).toBe(truth.pricedN);
    expect(LEDGER.agg.ladder.map((b: any) => b.p50)).toEqual(truth.ladder.map((b) => b.p50));
    expect(LEDGER.agg.geo).toEqual(truth.geo);

    // The cut really moved, and the page really redrew.
    expect(LEDGER.agg.cutN).toBeLessThan(before);
    expect(LEDGER.state.pending, 'still showing a spinner').toBe(false);
    expect(LEDGER.state.failed).toBe('');
    const html = String(mount.innerHTML);
    expect(html).not.toBe(beforeHtml);
    expect(html).toContain(String(truth.cutN));
    expect(html.includes('undefined')).toBe(false);
    expect(html.includes('NaN')).toBe(false);
  }, 180_000);

  it('coalesces a burst of presses into one request for the final cut', async () => {
    viewerFrom.mockResolvedValue(PAID);
    const { LEDGER, press } = await boot(PAGE_JSON);

    press('set-where', 'remote only');
    press('set-level', 'Senior');
    press('set-priced', 'priced');
    await settle();

    expect(requested, 'three presses, one request').toHaveLength(1);
    expect(requested[0]).toContain('where=remote%20only');
    expect(requested[0]).toContain('level=Senior');
    expect(requested[0]).toContain('priced=priced');

    const truth = await liveAggregates({ ...NO_FILTERS, where: 'remote only', level: 'Senior', priced: 'priced' });
    expect(LEDGER.agg.cutN).toBe(truth.cutN);
  }, 180_000);

  it('lands on the last press even when an earlier answer arrives after it', async () => {
    viewerFrom.mockResolvedValue(PAID);
    // Hold the FIRST response until the second has landed, so the slow answer
    // to the abandoned press arrives last and must be ignored.
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((r) => { releaseFirst = r; });
    let secondDone: () => void = () => {};
    const secondLanded = new Promise<void>((r) => { secondDone = r; });

    const { LEDGER, press } = await boot(PAGE_JSON, async (n) => {
      if (n === 0) await firstHeld;
      if (n === 1) secondDone();
    });

    press('set-level', 'Senior');
    await new Promise((r) => setTimeout(r, 300));   // the first request is out and stuck
    press('set-level', 'Director');
    await secondLanded;
    await settle();

    const director = await liveAggregates({ ...NO_FILTERS, level: 'Director' });
    expect(LEDGER.agg.cutN, 'the second press won').toBe(director.cutN);

    // Now let the abandoned first answer arrive. It must change nothing.
    releaseFirst();
    await settle();

    const senior = await liveAggregates({ ...NO_FILTERS, level: 'Senior' });
    expect(senior.cutN, 'the two cuts differ, so a stale write would be visible').not.toBe(director.cutN);
    expect(LEDGER.agg.cutN, 'the stale answer overwrote the current cut').toBe(director.cutN);
    expect(requested).toHaveLength(2);
  }, 180_000);

  it('says so when the answer does not come, and keeps the numbers it had', async () => {
    // A member pressing a filter is the realistic failure: the gate refuses and
    // the page must not silently keep drawing as though nothing happened.
    viewerFrom.mockResolvedValue({ userId: 'm', tier: 'member', emailVerified: true });
    const { LEDGER, press } = await boot(PAGE_JSON);
    const before = LEDGER.agg.cutN;

    press('set-where', 'remote only');
    await settle();

    expect(LEDGER.state.pending).toBe(false);
    expect(LEDGER.state.failed, 'the failure is surfaced').toContain('paid account');
    expect(LEDGER.agg.cutN, 'the previous numbers are still there').toBe(before);
  }, 180_000);

  it('does not go to the network for a control that only re-sorts what is on screen', async () => {
    viewerFrom.mockResolvedValue(PAID);
    const { LEDGER, press } = await boot(PAGE_JSON);

    press('sort-issuers');
    press('toggle-more');
    press('toggle-watch');
    await settle();

    expect(requested, 'sorting and opening panels are not new cuts').toHaveLength(0);
    expect(LEDGER.state.moreOpen).toBe(true);
  }, 180_000);
});
