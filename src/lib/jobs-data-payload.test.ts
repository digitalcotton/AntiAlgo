/**
 * jobs-data-payload.test.ts: the page and every endpoint behind it stay small,
 * and neither ever hands over a posting.
 *
 * WHY A SIZE TEST EXISTS AT ALL. The page broke by growing: it embedded the
 * whole live board, and when the crawl went from about 2,000 rows to 31,310 the
 * payload went from roughly 0.8 MB to 12.0 MB and the page rendered blank. The
 * failure was silent because nothing measured it. This measures it, so the next
 * thing that would put a row back in the payload fails here instead of on a
 * reader's screen.
 *
 * It needs a database, and skips rather than passing without one.
 */
import { describe, it, expect } from 'vitest';
import { buildJobsDataPayload } from './jobs-data-page';
import { cachedView } from './jobs-data-cache';
import { NO_FILTERS, type Filters } from './jobs-data-filters';

const HAVE_DB = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED);
const d = HAVE_DB ? describe : describe.skip;

/** The ceiling. Well above what either response measures today, and far below
    the size at which a browser struggles. */
const MAX_BYTES = 1024 * 1024;

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * Anything that would identify one posting rather than describe a group.
 * A company name is allowed: the issuer table is a per-company aggregate and
 * always has been. A title is allowed only as a group variant label, which is
 * a count of postings sharing a string.
 */
const POSTING_KEYS = [
  'url', 'apply_url', 'slug', 'posting_id', 'requisition_id', 'internal_id',
  'description', 'description_html', 'comp_posted', 'first_seen', 'last_seen',
  'published', 'days_up', 'fit_components'
];

d('the Jobs Data payloads', () => {
  it('the page embeds well under 1 MB', async () => {
    const payload = await buildJobsDataPayload();
    const size = bytes(payload);
    console.log(`  page payload: ${(size / 1024).toFixed(1)} KB`);
    expect(size).toBeLessThan(MAX_BYTES);
  }, 120_000);

  const CUTS: { name: string; f: Filters }[] = [
    { name: 'remote only', f: { ...NO_FILTERS, where: 'remote only' } },
    { name: 'Senior and priced', f: { ...NO_FILTERS, level: 'Senior', priced: 'priced' } },
    { name: 'no account to apply, posted this week', f: { ...NO_FILTERS, friction: 'easy', age: 7 } }
  ];

  for (const c of CUTS) {
    it(`a filtered response stays under 1 MB: ${c.name}`, async () => {
      const view = await cachedView(c.f);
      const size = bytes(view);
      console.log(`  filtered (${c.name}): ${(size / 1024).toFixed(1)} KB`);
      expect(size).toBeLessThan(MAX_BYTES);
    }, 120_000);
  }

  it('no response carries a field that identifies one posting', async () => {
    const [page, view] = await Promise.all([
      buildJobsDataPayload(),
      cachedView({ ...NO_FILTERS, where: 'remote only' })
    ]);
    for (const blob of [JSON.stringify(page), JSON.stringify(view)]) {
      for (const key of POSTING_KEYS) {
        expect(blob.includes(`"${key}"`), `a response carries "${key}"`).toBe(false);
      }
    }
  }, 120_000);

  it('the payload holds no array as long as the board', async () => {
    // A row list would show up as an array with about as many entries as there
    // are live postings, whatever it called its fields.
    const page: any = await buildJobsDataPayload();
    const liveN = page.FACTS.liveN;
    expect(liveN).toBeGreaterThan(0);
    const longest = deepLongestArray(page);
    console.log(`  live rows on the board: ${liveN}; longest array in the payload: ${longest}`);
    // The issuer table is the longest thing in here and it is one row per
    // company, so this bound also pins that companies stay far fewer than
    // postings. If they ever converge, the payload is carrying rows.
    expect(longest).toBeLessThan(liveN / 4);
  }, 120_000);
});

function deepLongestArray(v: unknown, depth = 0): number {
  if (depth > 8 || v === null || typeof v !== 'object') return 0;
  let max = Array.isArray(v) ? v.length : 0;
  for (const child of Object.values(v as Record<string, unknown>)) {
    const n = deepLongestArray(child, depth + 1);
    if (n > max) max = n;
  }
  return max;
}
