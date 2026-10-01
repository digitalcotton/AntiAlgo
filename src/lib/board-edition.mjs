/**
 * board-edition.mjs: which edition a board file says it is.
 *
 * ONE CRAWL, TWO EXPORTS, AND ONLY ONE OF THEM IS OURS. The mini crawls every
 * board it knows once a night and exports that single snapshot once per edition
 * (jobmachine/editions.py):
 *
 *   everything   antialgo.ai            every role the crawl read, no filter
 *   curated      tokenstoagents.ai      design, AI and UX research only
 *
 * They are the same shape, the same field order and the same filename. The only
 * thing that tells them apart is _meta.source, which the exporter writes from the
 * edition's own `source` string, and the only thing that tells you how wrong it
 * would be to confuse them is the row count: 52,739 against 2,893 on 2026-09-30,
 * a factor of eighteen.
 *
 * On 2026-10-01 they were confused. The curated file was written into the site
 * repo and a production build loaded it: 4,330 rows replaced 57,852. It survived
 * only because `jm publish everything` committed the full board two seconds
 * later. Had those two commits landed the other way round, antialgo.ai would have
 * served a twentieth of its board under a fresh timestamp, and a reader would have
 * read that as companies having stopped hiring.
 *
 * WHY IT IS ITS OWN FILE. Because scripts/ingest-on-build.mjs cannot be imported:
 * it is a build step that reads the environment and exits. The decoding below is
 * real logic with real ways to be wrong, so it lives where a test can reach it
 * without a database, a build or a Vercel environment, which is the same reason
 * upsert-sql.mjs and ingest-floor.mjs exist. What stays in the build step is the
 * policy: which edition that site serves and what to do about a file that is not
 * it.
 */
import { open } from 'node:fs/promises';
import { constants, gunzipSync } from 'node:zlib';

/**
 * The everything edition's own name for itself, character for character from
 * editions.EVERYTHING.source on the mini. antialgo.ai's board is this one.
 *
 * A literal, and compared with ===, because the whole value of the check is that
 * it cannot be argued with. The curated string is "mini all-jobs tracker, full
 * in-scope (design+AI+UXR)" and the sample file committed in this repo carries a
 * third wording again ("...filtered to design+AI+UXR"), so a substring test or a
 * "not the curated one" test would pass at least one file it should not.
 */
export const EVERYTHING_EDITION = 'mini all-jobs tracker, every role';

/**
 * How much of the compressed file to read. The everything edition runs to tens of
 * megabytes compressed and hundreds decompressed; the loader is about to gunzip
 * and parse all of it, and doing that twice in one build container to read one
 * string is a cost with nothing to show for it. _meta is the document's first
 * key, so 64 KiB of deflate yields it many times over, and a file that somehow
 * does not is refused rather than guessed at.
 */
export const HEAD_BYTES = 64 * 1024;

/** The leading bytes of a board file, decompressed, as text. */
export async function readHead(path, limit = HEAD_BYTES) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    const head = buffer.subarray(0, bytesRead);
    if (!path.endsWith('.gz')) return head.toString('utf8');
    // Z_SYNC_FLUSH, because this is a deliberately truncated deflate stream. The
    // default finish flush reads a missing end of stream as a corrupt file and
    // throws, which would turn "I only wanted the first page" into an error.
    return gunzipSync(head, { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The _meta object out of a prefix of a document's text, or the reason there is
 * none: { meta } or { why }.
 *
 * The prefix is not valid JSON on its own, so this walks the braces of the _meta
 * value and parses just that span. It tracks string state and escapes, which
 * matters less for the handful of scalars _meta carries today than for the next
 * field somebody adds to it: a brace counter that can be fooled by a brace inside
 * a note string is a check that fails open, and this one has to fail closed.
 */
export function metaFrom(text) {
  const key = '"_meta"';
  const at = text.indexOf(key);
  if (at === -1) return { why: `no ${key} key in the first ${Math.round(text.length / 1024)} KiB read` };
  const start = text.indexOf('{', at + key.length);
  if (start === -1) return { why: 'the _meta key is there but its object never opens' };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth > 0) continue;
      try {
        return { meta: JSON.parse(text.slice(start, i + 1)) };
      } catch (error) {
        return { why: `the _meta object did not parse: ${error.message}` };
      }
    }
  }
  return { why: 'the _meta object runs past the prefix this check reads' };
}

/**
 * A board file's _meta, read from its first HEAD_BYTES: { meta } or { why }.
 *
 * Never throws for a file it cannot make sense of, because every caller's answer
 * to "I could not tell which edition this is" is the same as its answer to "this
 * is the wrong edition": do not load it. A reason is more use than a stack trace.
 */
export async function readBoardMeta(path, limit = HEAD_BYTES) {
  let head;
  try {
    head = await readHead(path, limit);
  } catch (error) {
    return { why: `the file could not be read: ${error.message}` };
  }
  return metaFrom(head);
}
