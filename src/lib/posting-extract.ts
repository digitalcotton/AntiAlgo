/**
 * posting-extract.ts: read the posting off a page nobody taught us about.
 *
 * WHERE THIS SITS. docs/posting-fast-read-spec.md draws the seam: an `add`
 * lands here only after posting-resolvers.ts has tried the ATS's own JSON
 * endpoint and come back with nothing, because the URL is not one of the
 * board systems that endpoint knows. Most of the rest of the internet is a
 * careers page nobody wrote an adapter for, and this file is what reads it: a
 * JSON-LD `JobPosting` first, because an employer who bothered to mark one up
 * is handing us the exact fields we want; failing that, the single largest
 * block of prose on the page, because a hand-built careers page usually has
 * no structured markup at all and the posting is still just the biggest
 * paragraph-shaped thing on it.
 *
 * A DIRECT PORT, ONE LAYER OF IT. This is `extract_jsonld` / `extract_page`
 * and the `HTMLParser`-based tree they run on, out of the mini's
 * `postfetch.py`, translated line for line where TypeScript lets it stay
 * line for line. `board_of`, `needs_browser`, `prefer`, and every ATS-specific
 * parser (`_parse_greenhouse` and its siblings) are NOT here — those belong to
 * posting-resolvers.ts or stay on the mini, per the module table in the spec.
 *
 * PURE, LIKE THE PYTHON INSISTS ON BEING PURE. No socket, no filesystem read,
 * at module scope or inside `extractPosting`. The caller already has the
 * bytes; this file only ever looks at the string it was handed.
 *
 * NO REAL DOM, ON PURPOSE, SAME AS THE PYTHON HAS NONE. `postfetch.py` does
 * not import a browser or an HTML5-spec parser either — it builds a small ad
 * hoc tree with the stdlib's tag-at-a-time `HTMLParser` and lives with
 * whatever that gets slightly wrong on malformed markup, because the pages it
 * reads are scraped, not authored by us, and "close enough on real pages,
 * cheap, and offline-testable" was already the standing tradeoff. Adding a
 * real parser here would be a second, unrelated project, and it would still
 * need `sanitizeCrawledHtml()` afterward because a spec-correct DOM is not a
 * safety boundary. So this file hand-rolls the same kind of forgiving,
 * single-pass tag scanner, matching the Python's node shape (a tag, its
 * attributes, its children, one parent pointer) and its two special rules:
 * `<script>`/`<style>` contents are read as raw, undecoded text up to their
 * closing tag rather than tag-parsed (verified against the stdlib's own
 * behaviour before writing this), and a `<meta>`, `<title>`, or `<script>`
 * tag is recognised even while sitting inside a skipped subtree (`<nav>`,
 * `<header>`, and the rest of `SKIP` below) — an odd rule on its face, but
 * one the Python states unconditionally, so it is ported unconditionally.
 *
 * WHAT DID NOT COME ACROSS. `html.unescape` decodes the full HTML5 named
 * character reference table; `decodeHtmlEntities` below decodes numeric
 * references in full but only a few dozen of the most common named ones
 * (amp, nbsp, mdash, the punctuation and currency marks that actually show up
 * on careers pages). A page whose only interesting entity is `&there4;` would
 * carry that entity through unrecognised rather than decoded — accepted
 * because the fixtures under src/lib/fixtures/posting-extract/, two real
 * recorded pages, use nothing outside that set, and a JSON-LD payload with an
 * entity this table misses still parses and still extracts; only that one
 * character prints as it arrived. Widen the table if a real posting proves
 * this wrong.
 *
 * THE SHELL RULE IS APPLIED DIFFERENTLY HERE THAN IN THE PYTHON, BECAUSE THIS
 * FILE HAS NO BROWSER TO ESCALATE TO. In `postfetch.py`, `SHELL_TEXT_CHARS`
 * only feeds `needs_browser()`: a "page"-kind read that thin is not treated as
 * a failure, it is treated as a signal to spend the headless-Chromium layer
 * and see if the real DOM has more. That layer is the mini's, not this
 * pass's (see "Not in this pass" in the spec) — `extractPosting` has nothing
 * further to try. So a `page`-kind read under SHELL_TEXT_CHARS is folded into
 * `no_content` here: not because nothing was found, but because what was
 * found is indistinguishable from a cookie banner or an "enable JavaScript"
 * footer, and the honest answer for a read this pass cannot improve on is to
 * fail it back to the queue, where the mini's browser layer is still waiting
 * to take the harder case. A `jsonld`-kind read is never shell-checked, same
 * as `needs_browser` never shell-checks one: an employer's own structured
 * markup is not a shell no matter how short it runs.
 */
import { DESCRIPTION_MAX_CHARS, NAME_MAX_CHARS } from './posting-fetch-store';
import type { FailureCode, SourceKind } from './posting-fetch-store';
import { sanitizeCrawledHtml } from './description';
import type { PostingExtraction } from './posting-extraction';

/** A page that reads shorter than this has nothing worth calling a posting. */
export const MIN_TEXT_CHARS = 200;
/** A "page"-kind read shorter than this is an application shell, not a
 *  posting that happens to be brief — see the header for what happens to it. */
export const SHELL_TEXT_CHARS = 600;

/**
 * The shape this file hands back on success. `posting-resolvers.ts` is
 * defining the same shape independently for the ATS JSON layer (its `kind`
 * ranges over the API systems it knows; this file only ever produces
 * `'jsonld'` or `'page'`), and the two are not imported from one another
 * because that file may not exist yet in every tree this module is built in.
 * They are meant to be unified onto one shared type the day the route in
 * docs/posting-fast-read-spec.md is wired — until then, keep this declaration
 * byte for byte in step with that one by hand.
 */
/** The shape both readers produce, declared once in posting-extraction.ts —
    see that file's header for why it does not live in either reader. This module
    only ever returns a non-null `descriptionHtml` (a page with no body is
    `no_content` here), but the shared type allows null because the ATS readers
    legitimately see payloads with a title and no body. */
export type Extraction = PostingExtraction;

// --- the tree, a straight port of postfetch.py's _Tree / _Node -------------

const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'wbr', 'source', 'area', 'base']);
const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'iframe', 'select', 'option'
]);
const BLOCK = new Set(['div', 'section', 'article', 'main', 'body', 'td', 'li', 'ul', 'ol', 'p', 'table', 'blockquote', 'dd']);
const KEEP = new Set([
  'p', 'br', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 'a',
  'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'dl', 'dt', 'dd', 'hr', 'code', 'pre'
]);

interface TreeNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<TreeNode | string>;
  parent: TreeNode | null;
}

interface ParsedDocument {
  root: TreeNode;
  /** Raw text of every `<script type="application/ld+json">` block, in
   *  document order, undecoded (see the header on why script content is not
   *  entity-decoded the way ordinary text is). */
  jsonld: string[];
  title: string | null;
  /** `property`/`name` -> `content`, first tag wins, lower-cased key. */
  meta: Record<string, string>;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  trade: '™', copy: '©', reg: '®', deg: '°',
  times: '×', divide: '÷', bull: '•', middot: '·',
  sect: '§', para: '¶', euro: '€', pound: '£',
  yen: '¥', cent: '¢', plusmn: '±', dagger: '†',
  Dagger: '‡', permil: '‰'
};

/** Numeric references in full (`&#8217;`, `&#x2019;`); named references from
 *  the common subset above. Anything else is left exactly as written. */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** `html.escape(s, quote)`, the two calls _serialize makes: text nodes never
 *  escape quotes, an href attribute always does. */
function escapeHtml(text: string, quote: boolean): string {
  let out = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (quote) out = out.replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  return out;
}

const WHITESPACE = /\s/;

/**
 * Feed raw HTML through a forgiving, single-pass tag scanner and hand back
 * the tree, the JSON-LD blobs, the `<title>` text, and the meta map — exactly
 * the four things `_Tree` collects in the Python. See the file header for why
 * this is not a spec-compliant HTML5 parser and why that is an accepted,
 * matching tradeoff rather than an oversight.
 */
function buildTree(html: string): ParsedDocument {
  const root: TreeNode = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  const jsonld: string[] = [];
  let title: string | null = null;
  const meta: Record<string, string> = {};
  let inTitle = false;
  let inJsonld = false;
  let skipDepth = 0;

  const handleText = (data: string) => {
    if (!data) return;
    if (inTitle) {
      title = (title ?? '') + data;
      return;
    }
    if (inJsonld) {
      jsonld[jsonld.length - 1] += data;
      return;
    }
    if (skipDepth) return;
    cur.children.push(data);
  };

  const handleStartTag = (tag: string, attrs: Record<string, string>) => {
    if (tag === 'meta') {
      const key = (attrs.property || attrs.name || '').toLowerCase();
      if (key && attrs.content && !(key in meta)) meta[key] = attrs.content;
      return;
    }
    if (tag === 'title') {
      inTitle = true;
      return;
    }
    if (tag === 'script') {
      if ((attrs.type || '').toLowerCase().trim() === 'application/ld+json') {
        inJsonld = true;
        jsonld.push('');
      }
      skipDepth += 1;
      return;
    }
    if (skipDepth) {
      if (!VOID.has(tag)) skipDepth += 1;
      return;
    }
    if (SKIP.has(tag)) {
      skipDepth += 1;
      return;
    }
    const node: TreeNode = { tag, attrs, children: [], parent: cur };
    cur.children.push(node);
    if (!VOID.has(tag)) cur = node;
  };

  const handleEndTag = (tag: string) => {
    if (tag === 'title') {
      inTitle = false;
      return;
    }
    if (tag === 'script') {
      inJsonld = false;
      skipDepth = Math.max(0, skipDepth - 1);
      return;
    }
    if (skipDepth) {
      if (!VOID.has(tag)) skipDepth -= 1;
      return;
    }
    let node: TreeNode | null = cur;
    while (node !== null && node.tag !== tag) node = node.parent;
    if (node !== null && node.parent !== null) cur = node.parent;
  };

  const n = html.length;
  let i = 0;
  while (i < n) {
    if (html.charCodeAt(i) !== 60 /* '<' */) {
      const next = html.indexOf('<', i);
      const raw = next === -1 ? html.slice(i) : html.slice(i, next);
      handleText(decodeHtmlEntities(raw));
      i = next === -1 ? n : next;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', i)) {
      const end = html.indexOf(']]>', i + 9);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html.startsWith('</', i)) {
      const m = /^<\/\s*([a-zA-Z][a-zA-Z0-9:_-]*)\s*>/.exec(html.slice(i));
      if (m) {
        handleEndTag(m[1].toLowerCase());
        i += m[0].length;
      } else {
        i += 1;
      }
      continue;
    }
    const startMatch = /^<([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(html.slice(i));
    if (!startMatch) {
      handleText('<');
      i += 1;
      continue;
    }
    const tag = startMatch[1].toLowerCase();
    let j = i + startMatch[0].length;
    const attrs: Record<string, string> = {};
    let selfClosed = false;
    let closed = false;
    while (j < n) {
      while (j < n && WHITESPACE.test(html[j])) j++;
      if (j >= n) break;
      if (html[j] === '>') {
        j += 1;
        closed = true;
        break;
      }
      if (html[j] === '/' && html[j + 1] === '>') {
        j += 2;
        closed = true;
        selfClosed = true;
        break;
      }
      const nameMatch = /^[^\s=/>]+/.exec(html.slice(j));
      if (!nameMatch) {
        j += 1;
        continue;
      }
      const name = nameMatch[0];
      j += name.length;
      while (j < n && WHITESPACE.test(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j += 1;
        while (j < n && WHITESPACE.test(html[j])) j++;
        if (html[j] === '"' || html[j] === "'") {
          const quote = html[j];
          const end = html.indexOf(quote, j + 1);
          value = end === -1 ? html.slice(j + 1) : html.slice(j + 1, end);
          j = end === -1 ? n : end + 1;
        } else {
          const valMatch = /^[^\s>]*/.exec(html.slice(j));
          value = valMatch ? valMatch[0] : '';
          j += value.length;
        }
      }
      attrs[name.toLowerCase()] = decodeHtmlEntities(value);
    }
    if (!closed) j = n;

    // <script>/<style> content is read raw, up to its own closing tag,
    // rather than fed back through the tag scanner — the stdlib does the
    // same for these two elements, confirmed empirically before porting
    // this (see the file header).
    if (tag === 'script' || tag === 'style') {
      handleStartTag(tag, attrs);
      if (selfClosed) {
        handleEndTag(tag);
        i = j;
        continue;
      }
      const endTag = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(j);
      const match = endTag.exec(rest);
      handleText(match ? rest.slice(0, match.index) : rest);
      handleEndTag(tag);
      i = match ? j + match.index + match[0].length : n;
      continue;
    }

    handleStartTag(tag, attrs);
    i = j;
  }

  return { root, jsonld, title, meta };
}

function textOf(node: TreeNode | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

function linkText(node: TreeNode | string): string {
  if (typeof node === 'string') return '';
  if (node.tag === 'a') return textOf(node);
  return node.children.map(linkText).join('');
}

function serialize(node: TreeNode | string): string {
  if (typeof node === 'string') return escapeHtml(node, false);
  const inner = node.children.map(serialize).join('');
  if (!KEEP.has(node.tag)) return inner;
  if (node.tag === 'a') {
    const href = node.attrs.href || '';
    if (/^(https?:|mailto:)/i.test(href)) return `<a href="${escapeHtml(href, true)}">${inner}</a>`;
    return inner;
  }
  if (VOID.has(node.tag)) return `<${node.tag}>`;
  return `<${node.tag}>${inner}</${node.tag}>`;
}

function walk(node: TreeNode | string, out: TreeNode[]): void {
  if (typeof node === 'string') return;
  out.push(node);
  for (const child of node.children) walk(child, out);
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `_plain`: a crude tag strip used only to measure how much prose a
 *  candidate carries, never to build anything that gets rendered. */
function plainLength(html: string): number {
  return squash(html.replace(/<[^>]+>/g, ' ')).length;
}

/** `_clean_name`: collapse whitespace, decode entities, cap at
 *  NAME_MAX_CHARS, and turn "nothing left" into null rather than "". */
function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = squash(decodeHtmlEntities(value));
  const capped = cleaned.slice(0, NAME_MAX_CHARS);
  return capped || null;
}

interface RawFound {
  kind: SourceKind;
  title: string | null;
  company: string | null;
  descriptionHtml: string | null;
}

function buildFound(kind: SourceKind, rawTitle: unknown, rawCompany: unknown, descriptionHtml: string | null): RawFound {
  return { kind, title: cleanName(rawTitle), company: cleanName(rawCompany), descriptionHtml };
}

/**
 * `extract_jsonld`: the first `JobPosting` in any of the page's
 * `application/ld+json` blocks, walking each blob's own JSON with a stack so
 * a bare object, an array of objects, and an `@graph` wrapper are all found
 * the same way. Ported with the same traversal order the Python's stack
 * produces (last array element considered first) rather than a friendlier
 * left-to-right walk, since in practice a page carries at most one
 * `JobPosting` and getting a different one on a multi-posting blob would be a
 * silent behavioural drift from the system this is a port of.
 */
function extractJsonld(blobs: string[]): RawFound | null {
  for (const blob of blobs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob.trim());
    } catch {
      parsed = null;
    }
    const candidates: Record<string, unknown>[] = [];
    const stack: unknown[] = [parsed];
    while (stack.length) {
      const item = stack.pop();
      if (Array.isArray(item)) {
        stack.push(...item);
      } else if (item !== null && typeof item === 'object') {
        const dict = item as Record<string, unknown>;
        candidates.push(dict);
        if ('@graph' in dict) stack.push(dict['@graph']);
      }
    }
    for (const item of candidates) {
      const rawKinds = item['@type'];
      const kinds = (Array.isArray(rawKinds) ? rawKinds : [rawKinds]).map((k) => String(k));
      if (!kinds.includes('JobPosting')) continue;
      const org = item.hiringOrganization;
      let company: unknown = null;
      if (org !== null && typeof org === 'object' && !Array.isArray(org)) company = (org as Record<string, unknown>).name;
      else if (typeof org === 'string') company = org;

      let descriptionHtml: string | null = null;
      const desc = item.description;
      if (typeof desc === 'string') {
        let d = decodeHtmlEntities(desc);
        if (!d.includes('<')) {
          d = `<p>${escapeHtml(d, false).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
        }
        descriptionHtml = d;
      }
      return buildFound('jsonld', item.title, company, descriptionHtml);
    }
  }
  return null;
}

/**
 * `extract_page`: JSON-LD first (accepted only if its raw prose already
 * clears MIN_TEXT_CHARS — a thin JSON-LD block does not get to shortcut past
 * a bigger block of real prose elsewhere on the page); otherwise the first
 * `<main>`/`<article>`/`role="main"` element with enough text, and failing
 * that, whichever BLOCK-tag element scores highest on body length minus
 * three times its own link text, the same "penalise navigation-shaped
 * content" heuristic the Python uses. Returns null exactly when the Python
 * would return None: no candidate anywhere on the page clears the bar.
 */
function extractPage(html: string): RawFound | null {
  const doc = buildTree(html);
  const found = extractJsonld(doc.jsonld);
  if (found?.descriptionHtml && plainLength(found.descriptionHtml) >= MIN_TEXT_CHARS) {
    return found;
  }

  const nodes: TreeNode[] = [];
  walk(doc.root, nodes);

  let best: TreeNode | null = null;
  let bestScore = 0;
  for (const node of nodes) {
    if (node.tag === 'main' || node.tag === 'article' || (node.attrs.role || '').toLowerCase() === 'main') {
      const length = squash(textOf(node)).length;
      if (length >= MIN_TEXT_CHARS) {
        best = node;
        bestScore = Number.POSITIVE_INFINITY;
        break;
      }
    }
  }
  if (!best) {
    for (const node of nodes) {
      if (!BLOCK.has(node.tag)) continue;
      const body = squash(textOf(node));
      if (body.length < MIN_TEXT_CHARS) continue;
      const links = squash(linkText(node)).length;
      const score = body.length - 3 * links;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
  }
  if (!best) return null;

  const description = serialize(best).trim();
  let title: string | null = null;
  for (const node of nodes) {
    if (node.tag === 'h1') {
      const t = squash(textOf(node));
      if (t) {
        title = t;
        break;
      }
    }
  }
  if (!title && doc.title) {
    title = squash(doc.title).split(/\s+[|–—-]\s+/)[0];
  }
  let company: string | null = meta(doc, 'og:site_name') ?? meta(doc, 'application-name');
  if (found && !title) title = found.title;
  if (found && !company) company = found.company;
  return buildFound('page', title, company, description);
}

function meta(doc: ParsedDocument, key: string): string | null {
  return doc.meta[key] || null;
}

/**
 * The page extractor, end to end: JSON-LD `JobPosting` first, then the
 * largest block of prose, sanitised through the same allowlist pass every
 * other crawled description on this site goes through
 * (`sanitizeCrawledHtml()` in ./description.ts — reused, not reimplemented,
 * per the spec's standing rule), then measured again against MIN_TEXT_CHARS
 * and, for a page-kind read, SHELL_TEXT_CHARS. Both gates run on the
 * sanitised text rather than the raw extraction, matching `read_posting`'s
 * order in the Python (clean, then decide) — a description whose only
 * "content" was a `<script>` block the sanitiser discards should fail here,
 * not print as a 200-character posting that is actually empty.
 *
 * A capped, non-empty result becomes the `Extraction`; anything short of
 * that is `'no_content'`, the one `FailureCode` this file ever returns (see
 * the header for why a thin page-kind read collapses into the same code as
 * a genuinely empty one). Every other code in `FAILURE_CODES` describes a
 * fetch that never got this far — the network layer's business, not this
 * pure function's.
 */
export function extractPosting(html: string, finalUrl: string): Extraction | FailureCode {
  const found = extractPage(html);
  if (!found || !found.descriptionHtml) return 'no_content';

  const cleaned = sanitizeCrawledHtml(found.descriptionHtml);
  const textLength = plainLength(cleaned);
  if (textLength < MIN_TEXT_CHARS) return 'no_content';
  if (found.kind === 'page' && textLength < SHELL_TEXT_CHARS) return 'no_content';

  return {
    kind: found.kind,
    title: found.title,
    company: found.company,
    descriptionHtml: cleaned.slice(0, DESCRIPTION_MAX_CHARS),
    finalUrl
  };
}
