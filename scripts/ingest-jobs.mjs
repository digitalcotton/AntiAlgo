#!/usr/bin/env node
/**
 * ingest-jobs.mjs: load the mini's all-jobs tracker output into the jobs table.
 *
 * WHERE THIS RUNS. Not on the mini. The mini crawls and writes JSON; it holds no
 * database credentials on purpose. This script runs where DATABASE_URL already
 * lives (a Vercel job, or a local shell with .env pulled), reads a tracker JSON,
 * and upserts. The tracker file gets to the runner by whatever moves it (scp, an
 * artifact); this script only cares about the shape once it is here.
 *
 * WHAT IT ACCEPTS. Either the tracker's raw all-latest.json rows or the already
 * mapped src/data/general-sample.json rows. It normalises both to the jobs table
 * shape: a stable id (ats|posting_id, with url/title fallbacks), straight text
 * with no en or em dashes in anything the site renders, and days_up, the age
 * since the posting's published date, which only feeds the freshness component
 * of the fit score (the same horizon the sweep scores on). It is never a finding.
 *
 * THE GHOST FLAG IS GONE (2026-09-08). ghost was "listed 90 days or more", which
 * is the retired evergreen rule under another name: age is a fact the board
 * shows and sorts, never an accusation. The column stays false until it is
 * dropped. What replaces it is the record: after the rows are upserted, this
 * script reads src/data/kills-archive.json, the machine's all-time kill record
 * (both pipelines, the verified sweep and the broad crawl), upserts every
 * published kill into board_kills, ties each to the board row whose URL it
 * names, and marks that row status = 'killed'. board_kills is never truncated;
 * a kill the archive has withdrawn is vacated, not deleted. board_stats then
 * carries real counts instead of the literal zeros it wrote until now.
 *
 * The upsert SQL mirrors src/lib/job-store.ts upsertJobs on purpose: that file
 * owns the table's write shape, and this plain .mjs cannot import the TS module
 * without a build step, so the one INSERT ... ON CONFLICT statement is repeated
 * here and must stay in step with it.
 *
 * FLAGS
 *   --file <path>   tracker JSON to read (default src/data/general-sample.json)
 *   --limit <n>     ingest at most n rows (after normalisation)
 *   --dry-run       normalise and report, write nothing, touch no connection
 *   --batch <n>     rows per transaction (default 250)
 */
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertBatchFits, upsertSql } from '../src/lib/upsert-sql.mjs';

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes('--dry-run');
const REPLACE = process.argv.includes('--replace');
const FILE = resolve(root, arg('file', join('src', 'data', 'general-sample.json')));
const LIMIT = Number(arg('limit', '0')) || 0;
const BATCH = Number(arg('batch', '250')) || 250;

const DAY = 86_400_000;
const NOW = process.env.INGEST_NOW ? Date.parse(process.env.INGEST_NOW) : Date.now();
const DASH = /\s*[‒–—―−]\s*/g;

function s(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(s).join(' ');
  if (typeof x === 'object') {
    return Object.values(x)
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .join(' ');
  }
  return String(x);
}
// The no-dash rule holds for anything the UI renders. Comp ranges keep a plain
// hyphen (a range convention); other text takes a comma where a dash was.
const cleanText = (x) => s(x).replace(DASH, ', ').replace(/\s+/g, ' ').trim();
const cleanComp = (x) => {
  const t = s(x).replace(DASH, '-').replace(/\s+/g, ' ').trim();
  return t || null;
};
// The posting's description arrives as the employer's own HTML and renders
// verbatim through DescriptionSlot, so it keeps its markup: no whitespace
// collapse (that would flatten the paragraphs and lists the page is built to
// show). The one normalisation is the site's no-dash rule, applied to the text
// the same way every other rendered string takes it. Null when the feed carries
// no description, which draws the honest empty slot rather than a blank.
const cleanDescription = (x) => {
  if (typeof x !== 'string') return null;
  const t = x.replace(DASH, ', ').trim();
  return t || null;
};
const isoOrNull = (x) => {
  const t = s(x).trim();
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};
const dateOnly = (iso) => (iso ? iso.slice(0, 10) : null);

/**
 * The general opportunity score, 0-100, in the site's own rubric keys. On the
 * design board "fit" measured fit to design roles; on the unified board it
 * measures how complete and how fresh a posting is, so a record missing a comp
 * or a date scores lower and sorts down rather than being dropped. That is the
 * whole of the rule: thin data scores low, it does not disappear. The five
 * component maxima match RUBRIC in src/lib/data.ts so the row draws its bars
 * against the same weights every other row uses.
 */
function scoreJob(j) {
  // title_scope (max 30): a real, specific title. Present on essentially every
  // tracked posting; absent only on a shell row this ingest already skips.
  const title_scope = j.title && j.title.trim().length > 2 ? 30 : 0;

  // remote_geo (max 25): do we know where the job is. Full where a location
  // string is posted, half where only the country resolved, zero otherwise.
  const remote_geo = j.location ? 25 : j.country ? 12 : 0;

  // comp (max 20): full where the board posted a parseable number, partial for
  // a prose range with no number, zero where the board posted nothing.
  const hasNumber = j.comp_posted ? /\d/.test(j.comp_posted) : false;
  const comp = hasNumber ? 20 : j.comp_posted ? 12 : 0;

  // freshness (max 15): by how long the posting has been up. Unknown age scores
  // zero rather than guessing a recency the record cannot support.
  const d = typeof j.days_up === 'number' ? j.days_up : null;
  const freshness =
    d == null ? 0 : d <= 7 ? 15 : d <= 30 ? 12 : d <= 60 ? 8 : d <= 90 ? 5 : d <= 180 ? 3 : 1;

  // apply_friction (max 10): can a reader act on it. Full where an apply link
  // exists, zero where the record has no way in.
  const apply_friction = j.url ? 10 : 0;

  const components = { title_scope, remote_geo, comp, freshness, apply_friction };
  const total = title_scope + remote_geo + comp + freshness + apply_friction;
  return { total, components };
}

/**
 * The row's own page slug, /board reads it and /role resolves it. Company and
 * title slugified, with a short deterministic tail off the tracker id so two
 * different postings that slugify the same still get distinct, stable URLs.
 */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
function shortHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}
function slugFor(j) {
  const base = slugify(`${j.company} ${j.title}`) || 'role';
  return `${base}-${shortHash(j.id)}`;
}

/*
 * THE SCOPE CLASSIFIER USED TO LIVE HERE AND IT IS GONE ON PURPOSE.
 *
 * It was a second copy of board_build.py's in_scope(), and the two drifted:
 * 1,914 rows were exported and 1,847 arrived, so 67 postings a night were
 * dropped by this end second-guessing the machine that had already decided.
 * The classifier belongs on the mini, where the crawl is filtered before the
 * file is written. This script loads what it is given and asserts the count.
 *
 * If the board's population ever needs to change, it changes in board_build.py
 * and nowhere else. A copy here would drift again the first time only one of
 * them was edited, which is precisely what happened.
 */

/** The structured pay range from the ATS, or null. Never parsed from prose. */
function compRangeOf(raw) {
  const cr = raw.comp_range;
  if (cr && typeof cr === 'object' && typeof cr.min === 'number' && cr.min > 0) {
    return { min: cr.min, max: cr.max ?? null, currency: cr.currency ?? null, interval: cr.interval ?? null, source: cr.source ?? null };
  }
  return null;
}

function normalise(raw) {
  const ats = s(raw.ats).trim();
  const postingId = s(raw.posting_id).trim() || null;
  const url = s(raw.apply_url).trim() || s(raw.url).trim() || null;
  const title = cleanText(raw.title);
  const id = s(raw.id).trim() || `${ats}|${postingId || url || title}`;
  const published = isoOrNull(raw.published);

  // Age since the published date, for the freshness score only. Never a flag.
  let daysUp = Number.isFinite(raw.days_up) ? Math.max(0, Math.floor(raw.days_up)) : null;
  if (daysUp == null && published) daysUp = Math.max(0, Math.floor((NOW - Date.parse(published)) / DAY));
  const ghost = false;
  const firstSeen = dateOnly(isoOrNull(raw.first_seen)) || dateOnly(published);
  const lastSeen = dateOnly(isoOrNull(raw.last_seen)) || dateOnly(new Date(NOW).toISOString());

  const row = {
    id,
    company: cleanText(raw.company),
    title,
    url,
    location: cleanText(raw.location) || null,
    country: s(raw.country).trim() || null,
    remote: Boolean(raw.remote),
    published,
    ats,
    posting_id: postingId,
    department: cleanText(raw.department) || null,
    comp_posted: cleanComp(raw.comp_posted),
    days_up: daysUp,
    ghost,
    first_seen: firstSeen,
    last_seen: lastSeen,
    // The mini may name the field description, description_html, body or content;
    // take the first string present so a description rides through whichever key
    // the crawl settled on, and stays null until it emits one.
    description: cleanDescription(
      raw.description ?? raw.description_html ?? raw.body ?? raw.content
    )
  };
  row.comp_range = compRangeOf(raw);
  const scored = scoreJob(row);
  row.slug = s(raw.slug).trim() || slugFor(row);
  row.fit_total = scored.total;
  row.fit_components = scored.components;
  row.source = s(raw.source).trim() || 'tracked';
  return row;
}

function values(j) {
  return [
    j.id, j.company, j.title, j.url, j.location, j.country, j.remote, j.published,
    j.ats, j.posting_id, j.department, j.comp_posted, j.days_up, j.ghost,
    j.first_seen, j.last_seen, j.slug, j.fit_total, JSON.stringify(j.fit_components), j.source,
    j.comp_range ? JSON.stringify(j.comp_range) : null, j.description ?? null
  ];
}

// ---- read + normalise ----
// The crawl export is committed gzipped (board-latest.json.gz): with employer
// descriptions it is ~10 MB of HTML a day, which compresses to ~2 MB and keeps
// the daily commit from bloating the repo. A .gz file is gunzipped here; a plain
// .json still works unchanged (the sample, and local runs).
const rawFile = await readFile(FILE);
const text = FILE.endsWith('.gz') ? gunzipSync(rawFile).toString('utf8') : rawFile.toString('utf8');
const parsed = JSON.parse(text);
const rawRows = Array.isArray(parsed) ? parsed : parsed.jobs || [];
const seen = new Set();
let rows = [];
/*
 * SCOPE IS DECIDED ONCE, ON THE MACHINE, AND NOT AGAIN HERE.
 *
 * This loop used to run its own inScope() over rows the mini had already
 * filtered, and the two copies of the rule disagreed: the export carried 1,914
 * rows and 1,847 reached the table, so 67 postings were dropped every night
 * with nothing said. Not duplicates, not shell rows, just two versions of "is
 * this a design job" that had drifted apart. A second opinion applied silently
 * to somebody else's output is not a safety net, it is a leak.
 *
 * board_build.py owns the question. What arrives here is in scope by
 * definition, and what this end owes is a faithful load plus the assertion
 * below, so a mismatch is loud instead of invisible.
 *
 * The shell-row and duplicate-id skips stay. Those are not opinions about
 * scope: a row with no company, title or ats cannot satisfy the NOT NULL
 * columns, and a repeated id would overwrite itself. Both are counted and
 * reported rather than swallowed.
 */
let shellRows = 0;
let duplicateIds = 0;
for (const r of rawRows) {
  const j = normalise(r);
  if (!j.company || !j.title || !j.ats) { shellRows += 1; continue; }
  if (seen.has(j.id)) { duplicateIds += 1; continue; }
  seen.add(j.id);
  rows.push(j);
}
if (LIMIT > 0) rows = rows.slice(0, LIMIT);

const withComp = rows.filter((r) => r.comp_posted).length;
console.log(`read    ${rawRows.length} rows from ${FILE}`);
console.log(`normalised ${rows.length} (${shellRows} shell row(s), ${duplicateIds} duplicate id(s)); ${withComp} with comp`);

/*
 * THE KILL RECORD. src/data/kills-archive.json is committed beside the crawl
 * file by the same nightly publish, so the deploy that loads the board has the
 * record in hand. Every row in it is a published kill (the export writes only
 * publish: true events and skips retired rules); its id is the identity the
 * whole site uses. Missing file: a note, and the board loads without kills,
 * which is what every deploy before 2026-09-08 did.
 */
const KILLS_FILE = join(root, 'src', 'data', 'kills-archive.json');
let killRows = [];
let killsExportedAt = null;
try {
  const doc = JSON.parse(await readFile(KILLS_FILE, 'utf8'));
  killRows = Array.isArray(doc?.kills) ? doc.kills : [];
  killsExportedAt = typeof doc?.swept_at_utc === 'string' ? doc.swept_at_utc : null;
  console.log(`kills   ${killRows.length} record(s) in src/data/kills-archive.json (exported ${killsExportedAt ?? 'unknown'})`);
} catch (error) {
  console.log(`kills   no readable src/data/kills-archive.json (${error.code || error.message}); the board loads with no kill record`);
}
const killByUrl = new Map();
for (const k of killRows) if (k.url) killByUrl.set(k.url, (killByUrl.get(k.url) || []).concat(k));
const killedInFeed = rows.filter((r) => r.url && killByUrl.has(r.url)).length;
console.log(`kills   ${killedInFeed} of ${rows.length} feed row(s) are named by a published kill`);

/*
 * The export says how many rows it wrote. Anything less than that reaching the
 * table is a posting a reader will never see, and the only two reasons this end
 * is allowed to drop one are counted above and named in the message.
 */
const declared = Number(parsed?._meta?.count);
if (Number.isFinite(declared) && rows.length + shellRows + duplicateIds !== declared) {
  console.error(
    `ingest: the export declares ${declared} rows and this run accounted for ${rows.length + shellRows + duplicateIds} ` +
      `(${rows.length} loaded, ${shellRows} shell, ${duplicateIds} duplicate). Rows are going missing between ` +
      `board_build.py and this table, which is exactly the drift the scope filter used to cause here.`
  );
  process.exit(1);
}

if (DRY) {
  console.log('\ndry run: nothing written. sample of the first 3 normalised rows:');
  for (const r of rows.slice(0, 3)) {
    console.log(`  [${r.ats}] ${r.company} / ${r.title} / up ${r.days_up ?? 'n/a'}d`);
  }
  for (const r of rows.filter((x) => x.url && killByUrl.has(x.url)).slice(0, 5)) {
    const k = killByUrl.get(r.url)[0];
    console.log(`  killed: [${k.kill_rule}/${k.pipeline}] ${r.company} / ${r.title} -> /board/${r.slug}`);
  }
  process.exit(0);
}

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('No DATABASE_URL_UNPOOLED or DATABASE_URL in the environment. Pull it with: npx vercel env pull .env.local');
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();
let written = 0;
try {
  // THE WHOLE REPLACE IS ONE TRANSACTION, and that is what makes this safe to
  // run unattended. The TRUNCATE, every upsert, and the board_stats write commit
  // together or not at all. The board reads this table live (src/lib/job-store
  // .ts), so if the truncate committed on its own and an insert then failed, the
  // board would be served EMPTY until the next good run. Inside one transaction,
  // any failure rolls the truncate back too and the previous board stands intact.
  // TRUNCATE is transactional in Postgres, so this holds. The batch loop below is
  // now only for progress logging; there are no per-batch commits.
  await client.query('BEGIN');

  // A full sweep replaces the board: a posting gone from the feed drops out,
  // which is the signal the ghost watch and the counts depend on.
  if (REPLACE) {
    await client.query('TRUNCATE jobs');
    console.log('replaced: cleared the jobs table first (inside the transaction)');
  }
  assertBatchFits(BATCH);
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await client.query(upsertSql(slice.length), slice.flatMap(values));
    written += slice.length;
    console.log(`  upserted ${written}/${rows.length}`);
  }

  // THE RECORD, NEXT TO THE ROWS, IN THE SAME TRANSACTION. board_kills is
  // never truncated: every published kill in the archive file is upserted on
  // its id, and an id the file no longer carries (withdrawn by hand, with a
  // reason, via vacate_kill.py on the mini) is stamped vacated_at rather than
  // deleted. Then the join: a kill whose URL is a board row tonight is on the
  // board, and the row it names is killed, pointing at the kill of record.
  // job_slug is sticky on purpose, so /board/<slug> keeps resolving to the
  // closed page after the posting leaves the feed.
  const KILL_UPSERT = `
    INSERT INTO board_kills (id, slug, url, company, title, ats, kill_rule, reason, evidence, killed_on,
                             first_killed_at_utc, last_fired_on, times_fired, first_published, pipeline,
                             vacated_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NULL, now())
    ON CONFLICT (id) DO UPDATE SET
      slug=$2, url=$3, company=$4, title=$5, ats=$6, kill_rule=$7, reason=$8, evidence=$9, killed_on=$10,
      first_killed_at_utc=$11, last_fired_on=$12, times_fired=$13, first_published=$14, pipeline=$15,
      vacated_at=NULL, updated_at=now()`;
  const killIds = [];
  for (const k of killRows) {
    if (!k.id || !k.url || !k.company || !k.title || !k.kill_rule || !k.reason) continue;
    killIds.push(k.id);
    await client.query(KILL_UPSERT, [
      k.id, k.slug ?? null, k.url, cleanText(k.company), cleanText(k.title), k.ats ?? null, k.kill_rule,
      cleanText(k.reason), k.evidence ? JSON.stringify(k.evidence) : null, k.killed_on ?? null,
      k.first_killed_at_utc ?? null, k.last_fired_on ?? k.killed_on ?? null,
      Number.isFinite(k.times_fired) ? k.times_fired : 1, k.first_published ?? null, k.pipeline || 'sweep'
    ]);
  }
  const vacated = await client.query(
    `UPDATE board_kills SET vacated_at = now(), updated_at = now()
      WHERE vacated_at IS NULL AND NOT (id = ANY($1::text[]))`,
    [killIds]
  );
  // The join is by the posting URL the kill names against the board row's URL.
  // A kill about a posting not on the board tonight keeps on_board as it was
  // (sticky), so a row that has left the feed still resolves by job_slug.
  const tied = await client.query(
    `UPDATE board_kills k SET on_board = true, job_id = j.id, job_slug = j.slug, updated_at = now()
       FROM jobs j WHERE j.url = k.url AND k.vacated_at IS NULL
        AND (k.on_board IS DISTINCT FROM true OR k.job_id IS DISTINCT FROM j.id OR k.job_slug IS DISTINCT FROM j.slug)`
  );
  // The kill of record for a row with several: earliest first, then the rule
  // precedence the machine itself uses (killrules.KILL_RULES, site spelling).
  const marked = await client.query(
    `UPDATE jobs j SET status = 'killed', kill_id = k.id
       FROM (
         SELECT DISTINCT ON (url) url, id FROM board_kills
          WHERE vacated_at IS NULL
          ORDER BY url, first_killed_at_utc ASC NULLS LAST,
                   array_position(ARRAY['repost_churn','zombie','misrepresented','phantom','touched_not_refreshed'], kill_rule)
       ) k
      WHERE j.url = k.url`
  );
  console.log(`board_kills: ${killIds.length} upserted, ${vacated.rowCount} vacated, ${tied.rowCount} tied to a board row; ${marked.rowCount} board row(s) marked killed`);

  // The board's own counts, written from the crawl and the record so the tiles
  // never carry a hand-typed number. verified_live is exactly what the board
  // now holds; boards_swept is what the crawl read; killed is how many of
  // tonight's rows a published kill names, by rule; killed_all_time is every
  // standing kill tied to a board row, on the feed or not. Two clocks, named
  // apart: swept_at is the crawl's, kills_exported_at is the record's. Inside
  // the same transaction, so the counts and the rows can never disagree.
  const meta = Array.isArray(parsed) ? {} : parsed._meta || {};
  const boardsSwept = Number(meta.boards_swept ?? meta.boards ?? 0) || 0;
  const observed = Number(meta.postings_observed ?? meta.pulled ?? 0) || 0;
  const sweptAt = meta.generated_from || meta.generated_at_utc || null;
  // The sweep's own stage clock (db/205), copied only where it is an ISO
  // instant per known stage; anything else is left out rather than guessed.
  const STAGES = ['read', 'verify', 'kill', 'save'];
  const stageLog = {};
  for (const key of STAGES) {
    const at = meta.stages?.[key];
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) stageLog[key] = new Date(at).toISOString();
  }
  const stageLogJson = Object.keys(stageLog).length > 0 ? JSON.stringify(stageLog) : null;
  const { rows: killedRows } = await client.query(`SELECT count(*)::int AS n FROM jobs WHERE status = 'killed'`);
  const { rows: byRuleRows } = await client.query(
    `SELECT k.kill_rule, count(*)::int AS n FROM jobs j JOIN board_kills k ON k.id = j.kill_id
      WHERE j.status = 'killed' GROUP BY k.kill_rule ORDER BY k.kill_rule`
  );
  const { rows: allTimeRows } = await client.query(
    `SELECT count(*)::int AS n FROM board_kills WHERE on_board AND vacated_at IS NULL`
  );
  const killed = killedRows[0]?.n ?? 0;
  const killsByRule = Object.fromEntries(byRuleRows.map((r) => [r.kill_rule, r.n]));
  const killedAllTime = allTimeRows[0]?.n ?? 0;
  await client.query(
    `INSERT INTO board_stats (id, boards_swept, verified_live, killed, killed_by_rule, postings_observed, swept_at,
                              kills_by_rule, killed_all_time, kills_exported_at, stage_log, ingested_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (id) DO UPDATE SET
       boards_swept = $1, verified_live = $2, killed = $3, killed_by_rule = $4,
       postings_observed = $5, swept_at = $6, kills_by_rule = $7, killed_all_time = $8,
       kills_exported_at = $9, stage_log = $10, ingested_at = now()`,
    [boardsSwept, written, killed, killed, observed, sweptAt, JSON.stringify(killsByRule), killedAllTime, killsExportedAt, stageLogJson]
  );
  console.log(`board_stats: boards_swept=${boardsSwept}, verified_live=${written}, killed=${killed} ${JSON.stringify(killsByRule)}, killed_all_time=${killedAllTime}, postings_observed=${observed}`);

  await client.query('COMMIT');
} catch (error) {
  // Rolls back the TRUNCATE and every upsert together: on any failure the board
  // is left exactly as it was, never empty and never half-written.
  await client.query('ROLLBACK').catch(() => {});
  console.error(`FAILED after staging ${written} row(s); rolled back, the board is unchanged: ${error.message}`);
  await client.end();
  process.exit(1);
}
await client.end();
console.log(`\ningested ${written} job(s).`);
