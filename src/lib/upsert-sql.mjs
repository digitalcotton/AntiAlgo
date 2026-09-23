/**
 * upsert-sql.mjs: the board upsert, built for a batch of rows instead of one.
 *
 * WHY IT IS ITS OWN FILE. scripts/ingest-jobs.mjs runs work at import: it reads
 * the crawl file, connects and loads. That is right for a script and useless
 * for a test, so the part worth testing, the statement it builds, lives here
 * where it can be imported without a database or a file.
 *
 * WHAT CHANGED. The ingest sent one INSERT per posting and awaited each. At the
 * roughly 1,900 rows the board carried, from a build container beside the
 * database, that cost a few seconds. Two things changed it: the board now
 * carries the whole crawl, about seven times the rows, and the load may be run
 * from the Mac mini over a home connection rather than from the build.
 * Sequential round trips multiply against both, and the TRUNCATE is held for
 * all of them, so minutes of lock instead of seconds.
 *
 * The rows of a batch now go in one statement. Same columns, same
 * ON CONFLICT (id) DO UPDATE, same transaction. The SET clause reads from
 * EXCLUDED rather than repeating $2, $3 and the rest, because with many rows in
 * flight there is no single numbered parameter to point at; EXCLUDED is the row
 * Postgres was about to insert, which is exactly what the old numbered form
 * meant one row at a time.
 *
 * THE DEDUP UPSTREAM IS LOad BEARING. Two rows sharing an id inside one VALUES
 * list make Postgres refuse the whole statement ("ON CONFLICT DO UPDATE command
 * cannot affect row a second time"). ingest-jobs.mjs already skips repeated ids
 * and counts them; that skip is what makes batching safe, not merely tidy.
 */

/** Columns bound per row. Must match values() in scripts/ingest-jobs.mjs. */
export const COLUMNS_PER_ROW = 30;

/** Postgres refuses a statement carrying more bound parameters than this. */
export const MAX_PARAMETERS = 65535;

/** The most rows one statement can carry. */
export const MAX_ROWS_PER_STATEMENT = Math.floor(MAX_PARAMETERS / COLUMNS_PER_ROW);

const HEAD = `
  INSERT INTO jobs (id, company, title, url, location, country, remote, published,
                    ats, posting_id, department, comp_posted, days_up, ghost,
                    first_seen, last_seen, slug, fit_total, fit_components, source,
                    comp_range, description,
                    derived_tier, derived_fam, derived_region, derived_friction,
                    priced, comp_min_k, comp_max_k, comp_mid_k,
                    status, kill_id, ingested_at)
  VALUES `;

const TAIL = `
  ON CONFLICT (id) DO UPDATE SET
    company=EXCLUDED.company, title=EXCLUDED.title, url=EXCLUDED.url, location=EXCLUDED.location,
    country=EXCLUDED.country, remote=EXCLUDED.remote, published=EXCLUDED.published,
    ats=EXCLUDED.ats, posting_id=EXCLUDED.posting_id, department=EXCLUDED.department,
    comp_posted=EXCLUDED.comp_posted, days_up=EXCLUDED.days_up, ghost=EXCLUDED.ghost,
    first_seen=EXCLUDED.first_seen, last_seen=EXCLUDED.last_seen, slug=EXCLUDED.slug,
    fit_total=EXCLUDED.fit_total, fit_components=EXCLUDED.fit_components,
    source=EXCLUDED.source, comp_range=EXCLUDED.comp_range, description=EXCLUDED.description,
    derived_tier=EXCLUDED.derived_tier, derived_fam=EXCLUDED.derived_fam,
    derived_region=EXCLUDED.derived_region, derived_friction=EXCLUDED.derived_friction,
    priced=EXCLUDED.priced, comp_min_k=EXCLUDED.comp_min_k,
    comp_max_k=EXCLUDED.comp_max_k, comp_mid_k=EXCLUDED.comp_mid_k,
    status='live', kill_id=NULL, ingested_at=now()`;

/**
 * The INSERT for exactly n rows: n runs of 22 placeholders, then the conflict
 * clause. Refuses a count that Postgres would reject, before anything is sent,
 * so a raised --batch fails at the first statement rather than halfway through
 * a night's load.
 */
export function upsertSql(n) {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`upsertSql needs at least one row, got ${n}`);
  }
  assertBatchFits(n);
  const tuples = [];
  for (let r = 0; r < n; r += 1) {
    const base = r * COLUMNS_PER_ROW;
    const holes = [];
    for (let c = 1; c <= COLUMNS_PER_ROW; c += 1) holes.push(`$${base + c}`);
    tuples.push(`(${holes.join(',')}, 'live', NULL, now())`);
  }
  return HEAD + tuples.join(',\n         ') + TAIL;
}

/** Throw, with the arithmetic, if a batch size cannot fit in one statement. */
export function assertBatchFits(batch) {
  if (batch > MAX_ROWS_PER_STATEMENT) {
    throw new Error(
      `a batch of ${batch} would send ${batch * COLUMNS_PER_ROW} parameters in one ` +
      `statement; Postgres allows ${MAX_PARAMETERS}, so the most rows per statement ` +
      `is ${MAX_ROWS_PER_STATEMENT}. Lower --batch.`
    );
  }
}
