/**
 * ingest-floor.mjs: the night over night floor on replacing the board.
 *
 * WHY IT IS ITS OWN FILE. The same reason upsert-sql.mjs is. scripts/ingest-jobs
 * .mjs runs its work at import: it reads the crawl file, connects, truncates and
 * loads. That is right for a script and useless for a test, so the part worth
 * testing lives here, where it can be imported with no database, no crawl file
 * and no open transaction. test/ingest-floor.test.mjs is that proof, and it is
 * the only place the rule below is exercised without risking real rows.
 *
 * WHAT WENT WRONG THAT THIS ANSWERS. The replace path was already one
 * transaction, which is good design: a load that fails rolls back and the
 * previous board stands. But the only consistency check compared the incoming
 * file against the FILE'S OWN header (_meta.count), never against the board
 * already in the table. So a crawl that reached a tenth of its boards published
 * a tenth of the board, in one clean transaction, under a fresh timestamp, with
 * nothing raised. A reader does not see an outage there. A reader sees "these
 * companies stopped hiring", which is a false statement about the labour market
 * dressed as a true one.
 *
 * It is not hypothetical. On 2026-10-01 two exporters wrote this table about two
 * minutes apart with row counts twelve times apart: a Vercel production build
 * ingested the CURATED edition (4,330 rows) and `jm publish everything` loaded
 * the full board (57,852 rows). The full edition won on commit ordering by two
 * seconds. Reverse those two seconds and the site serves 4,330 rows under a
 * green timestamp, a 92.5% collapse nobody is told about.
 *
 * WHY 70%, FROM THE DATA. The floor has to be loose enough that a normal bad
 * night does not trip it (a floor that cries wolf gets switched off, and then it
 * is pattern two: a guard that exists and protects nothing) and tight enough to
 * refuse a collapse. The crawl's own records say where that line is:
 *
 *   - Boards failing is the NORMAL state, not the alarm. The 2026-10-01 crawl
 *     read 2,999 boards and recorded 172 errors, and the board still grew.
 *   - The worst plausible honest loss is one whole adapter dying. On that same
 *     snapshot the biggest adapter, usajobs, is 10,000 of 61,012 postings:
 *     16.4%. The next, iCIMS, is 11.0%. The two largest failing on the SAME
 *     night costs 27.4%, which a 70% floor still passes.
 *   - The biggest single employer, Apple, is 4,893 rows, 8.0%. No one company
 *     going dark comes close to the floor.
 *   - Night over night the board has only ever grown in the record we have:
 *     37,765 rows on 09-28, 52,739 on 09-30 (+39.6%, when discovery took the
 *     crawl from 1,666 boards to 2,998), 57,852 on 10-01 (+9.7%). Growth is
 *     never suspicious and is never measured against the floor.
 *   - Against that, the cases this must refuse are not close calls. The curated
 *     edition is structurally about a twentieth of the full board (2,893 of
 *     52,739 on 09-30, 5.5%), and the 2026-10-01 near miss was 4,330 of 57,852,
 *     7.5%. Both are refused with more than sixty points of margin.
 *
 * So: a drop of more than 30% stops the load. One adapter can die, two of the
 * largest can die together, and tonight still publishes. A board that has lost
 * two thirds of itself does not publish without a human saying so.
 *
 * THE OVERRIDE IS REAL AND IT IS LOUD. A genuine contraction has to be
 * publishable by someone who means it, so --allow-shrink exists; the refusal
 * message names it, with both counts and the fraction, so the operator is told
 * exactly how to proceed rather than left to read this file. An override still
 * prints the whole comparison, because a flag that silences the numbers is how a
 * guard quietly stops being one.
 *
 * TWO THINGS THE OVERRIDE DOES NOT OPEN. An empty file is refused whatever flags
 * are passed: zero postings is never a fact about the labour market, and a
 * person who truly wants an empty board can write that SQL by hand. And a first
 * load into an empty table is always allowed, with or without the flag, because
 * a floor that cannot be cleared on a fresh database is a floor that stops the
 * database from ever existing.
 *
 * WHAT THIS DOES NOT DECIDE. It does not look at WHICH edition the incoming file
 * is. `source` below is carried into the message as a label and nothing reads it
 * as a condition. The edition check is a different question with a different
 * owner, scripts/ingest-on-build.mjs, which knows which site it is building.
 */

/** A drop past this fraction of the published board stops the load. */
export const FLOOR = 0.7;

/** The one way a human publishes a real contraction. Named in every refusal. */
export const OVERRIDE_FLAG = '--allow-shrink';

/** Thousands separators without pulling in ICU, so a log line reads the same
 *  on the mini, in a Vercel build container and in a test. */
const count = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** One decimal place, which is the resolution the decision is actually made at. */
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** An instant, or the honest word for not having one. board_stats.ingested_at
 *  arrives from pg as a Date; a test passes a string; either is fine. */
function instant(value) {
  if (value == null) return 'an unrecorded time';
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isNaN(ms) ? 'an unrecorded time' : new Date(ms).toISOString();
}

function wholeCount(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    // A caller bug, not a data condition: these three numbers are read straight
    // out of count(*) and board_stats moments before. Throwing says so, where
    // returning a refusal would file a programmer's mistake as a bad crawl.
    throw new TypeError(`ingest-floor: ${name} must be a whole count, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * Should this load be allowed to replace the board?
 *
 *   incoming     rows the normalised crawl file is about to write
 *   published    rows the table holds right now, read under the lock the
 *                TRUNCATE is about to take, so it is the number being destroyed
 *   remembered   what the previous ingest said it staged, from board_stats
 *                (verified_live + killed), or null when no row exists yet
 *   rememberedAt board_stats.ingested_at, for the operator's sense of how old
 *                the baseline is
 *   source       the incoming file's _meta.source, used only as a label
 *   allowShrink  the operator passed --allow-shrink and means it
 *
 * Returns { ok, code, baseline, retained, lines, summary }. `lines` is what to
 * print, in order: the caller sends them to stderr on a refusal and stdout on a
 * pass. `summary` is the single sentence a refusal should throw with, complete
 * on its own, because jobmachine/publish/db.py surfaces only the last six lines
 * of stderr and that sentence has to survive being the only one read.
 *
 * Pure: no clock, no connection, no process state. Everything it decides on is
 * in the arguments and everything it says is in the return value.
 */
export function floorVerdict({
  incoming,
  published,
  remembered = null,
  rememberedAt = null,
  source = null,
  allowShrink = false
} = {}) {
  wholeCount(incoming, 'incoming');
  wholeCount(published, 'published');
  if (remembered != null) wholeCount(remembered, 'remembered');

  // The incoming file's own name for itself, when it has one. A refusal that
  // says which edition arrived is the difference between "the board shrank" and
  // "the wrong exporter wrote here", and those have different fixes.
  const label = typeof source === 'string' && source.trim()
    ? `the incoming file calls itself "${source.trim()}".`
    : 'the incoming file does not say which edition it is.';

  // ZERO IS ALWAYS WRONG, AND THE FLAG DOES NOT OPEN IT. Checked before the
  // empty-table case below, so an empty file cannot slip through as a first
  // load: "nothing published yet" plus "nothing incoming" is two faults
  // agreeing, not permission.
  if (incoming === 0) {
    return {
      ok: false,
      code: 'refuse-empty',
      baseline: published,
      retained: 0,
      lines: [
        `floor: REFUSING to replace the board with an empty file. It carries 0 row(s); the table holds ${count(published)}.`,
        `floor: ${label}`,
        `floor: a board with no postings is never a fact about the labour market, so ${OVERRIDE_FLAG} does not open this gate.`,
        'floor: nothing was written. The transaction rolls back and the board a reader sees is unchanged.'
      ],
      summary:
        `the board load refused an empty file (0 incoming row(s) against ${count(published)} published). ` +
        `${OVERRIDE_FLAG} does not override an empty board; fix the crawl.`
    };
  }

  // A FRESH DATABASE MUST NOT BE DEADLOCKED BY ITS OWN FLOOR. An empty table has
  // no board to protect, so there is nothing for a fraction to be a fraction of.
  // board_stats is deliberately ignored here: a table emptied by hand with a
  // stale stats row still gets to be loaded, because the alternative is a
  // database that can never be filled again without a flag.
  if (published === 0) {
    return {
      ok: true,
      code: 'allow-first-load',
      baseline: 0,
      retained: null,
      lines: [
        `floor: the jobs table is empty, so ${count(incoming)} incoming row(s) load with no board to compare against.`
      ],
      summary: `first load: ${count(incoming)} row(s) into an empty table.`
    };
  }

  // TWO COPIES OF ONE FACT, COMPARED. board_stats is written in the same
  // transaction as the rows, so verified_live + killed should equal count(*)
  // exactly; on this machine's dev board it does (37,286 + 479 = 37,765). When
  // it does not, something wrote `jobs` outside this ingest, and the larger of
  // the two becomes the baseline so the floor protects the bigger claim rather
  // than whichever copy the intruder left behind. Normally this is a no-op; the
  // disagreement itself is the finding and gets its own line.
  const baseline = remembered != null ? Math.max(published, remembered) : published;
  const mismatch = remembered != null && remembered !== published
    ? [`floor: board_stats remembers ${count(remembered)} staged but the table holds ${count(published)}. ` +
       'Something wrote jobs outside this ingest; the larger number is the baseline.']
    : [];

  const retained = incoming / baseline;

  if (incoming >= baseline) {
    return {
      ok: true,
      code: 'allow-grew',
      baseline,
      retained,
      lines: [
        ...mismatch,
        `floor: ${count(baseline)} published, ${count(incoming)} incoming; the board grew, so the ${pct(FLOOR)} floor does not apply.`
      ],
      summary: `the board grew from ${count(baseline)} to ${count(incoming)} row(s).`
    };
  }

  if (retained >= FLOOR) {
    return {
      ok: true,
      code: 'allow-within-floor',
      baseline,
      retained,
      lines: [
        ...mismatch,
        `floor: ${count(baseline)} published, ${count(incoming)} incoming (${pct(retained)} of the board); inside the ${pct(FLOOR)} floor.`
      ],
      summary: `${count(incoming)} row(s) replace ${count(baseline)}, ${pct(retained)} of the board, inside the ${pct(FLOOR)} floor.`
    };
  }

  const drop = pct(1 - retained);

  if (allowShrink) {
    return {
      ok: true,
      code: 'allow-override',
      baseline,
      retained,
      lines: [
        ...mismatch,
        `floor: ${OVERRIDE_FLAG} was passed, so a ${drop} drop is being published on purpose.`,
        `floor: ${count(incoming)} incoming row(s) replace ${count(baseline)} published, ${pct(retained)} of the board, against a ${pct(FLOOR)} floor.`,
        `floor: ${label}`
      ],
      summary:
        `${OVERRIDE_FLAG}: published a ${drop} drop, ${count(incoming)} row(s) over ${count(baseline)}.`
    };
  }

  return {
    ok: false,
    code: 'refuse-shrink',
    baseline,
    retained,
    lines: [
      ...mismatch,
      `floor: REFUSING to replace the board. ${count(incoming)} incoming row(s) against ${count(baseline)} already published.`,
      `floor: that keeps ${pct(retained)} of the board, a ${drop} drop; the floor is ${pct(FLOOR)}.`,
      `floor: ${label}`,
      `floor: the previous board was loaded at ${instant(rememberedAt)}. Nothing was written; the transaction rolls back and the board a reader sees is unchanged.`,
      `floor: if the shrink is real and you mean to publish it, run the same command again with ${OVERRIDE_FLAG}.`
    ],
    summary:
      `the board load refused a ${drop} drop: ${count(incoming)} incoming row(s) against ${count(baseline)} published, ` +
      `${pct(retained)} of the board against a ${pct(FLOOR)} floor. Re-run with ${OVERRIDE_FLAG} if the shrink is real.`
  };
}
