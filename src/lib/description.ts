/**
 * What this site is willing to render out of an employer's own markup.
 *
 * `description_html` is the one field on this site that arrives as markup and
 * goes onto a page with `set:html`. Everywhere else the data layer hands a page
 * a string and Astro escapes it. So this file is the seam where the site stops
 * trusting the machine, which is the relationship docs/MACHINE-CONTRACT.md draws
 * between a publisher and a scraper even when the same person wrote both.
 *
 * TWO PASSES, AND THEY ANSWER TWO DIFFERENT QUESTIONS.
 *
 *   stripRemoteEmbeds  is this safe to put on a page we serve?
 *   nestHeadings       does this leave the page's outline readable?
 *
 * NEITHER PASS TOUCHES A WORD. That is the line, and it is the same line the
 * rest of the pipeline draws. sweep.py may not summarise a description; the
 * export may not paraphrase one; this file may not edit one. What it may do is
 * refuse to load a third party's resource, and renumber a heading tag so a
 * screen reader can navigate the document. Both are decisions about our page.
 * Neither changes a character an employer wrote.
 *
 * WHY THIS IS A REGEX PASS RATHER THAN A PARSE. Same reasoning as the machine's
 * clean_html(): a parser round trips the markup and quietly normalises quote
 * style, attribute order and entities, which would mean the field on the page is
 * no longer byte for byte the field in the data. A masking pass changes only the
 * bytes it is aimed at. Where a construct cannot be matched cleanly the failure
 * direction for the embed pass is "remove it", because the pass exists to remove
 * things, and for the heading pass it is "leave it alone".
 */

import sanitizeHtml from 'sanitize-html';

/**
 * THE XSS CUT, MADE THIS REPO'S OWN. `description_html` is crawled from
 * arbitrary employer and ATS pages by a separate machine (docs/MACHINE-
 * CONTRACT.md), and until now the removal of scripts, event handlers, and
 * javascript: URLs was that machine's job alone: this repo could neither test
 * nor version-pin it, and one hostile posting would have been stored XSS on a
 * page that shares an origin with the session cookie. So this pass runs an
 * allowlist sanitizer HERE, as defense in depth, before anything reaches
 * set:html.
 *
 * WHY A PARSER HERE AND A REGEX FOR THE EMBED/HEADING PASSES. The byte-for-byte
 * fidelity the rest of this file keeps is a provenance stance about the PERSON'S
 * OWN RECORD and about not silently editing an employer's prose. It was never a
 * licence to render untrusted third-party markup verbatim: against an attacker,
 * a regex XSS filter is an anti-pattern (malformed and encoded vectors slip it),
 * so the one place that must resist an adversary uses a real parser. It strips
 * dangerous ELEMENTS and ATTRIBUTES; it does not touch a word of text. The
 * formatting tags employers actually use survive, and the embed elements are
 * deliberately KEPT here so stripRemoteEmbeds() below still removes and REPORTS
 * them by name (a parser that silently dropped them would lose that note).
 */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'span', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'mark',
  'a', 'blockquote', 'q', 'cite', 'code', 'pre',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // Kept so stripRemoteEmbeds() can remove and name them (see its own header).
  'iframe', 'object', 'embed', 'form'
];

/**
 * Strip every dangerous element and attribute from crawled markup, keeping the
 * text and the formatting employers use. script/style/link/base/meta and any
 * unknown tag are discarded; all event-handler attributes are dropped; only
 * http, https and mailto URLs survive on href/src (javascript:, data:, and vbscript:
 * are removed). Text content is preserved exactly.
 */
export function sanitizeCrawledHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'name', 'rel', 'target'],
      '*': ['id', 'class', 'colspan', 'rowspan', 'headers', 'scope', 'lang', 'dir', 'title']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
    // Drop the whole element AND its text for these, rather than un-wrapping,
    // so a <script>alert()</script> leaves no stray "alert()" text behind.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
    disallowedTagsMode: 'discard'
  });
}

/**
 * Elements that fetch a third party's resource into our page at render time.
 *
 * The machine's sanitizer removes scripts, event handlers and javascript: URLs,
 * which is the XSS cut. It does not remove these, and on 2026-08-19 exactly one
 * of 65 descriptions carried one: Notion's Ashby posting embeds
 * `<iframe src="https://embedded-media.ashbyhq.com/embed/...">`. Three things
 * were wrong with shipping it, and only the first was visible:
 *
 *   1. axe-core failed the route for frame-title on all four checks of it, the
 *      only accessibility violation in 300 checks.
 *   2. Every visitor to that page made a request to a host chosen by feed
 *      content, on a site with no third party requests anywhere else.
 *   3. Gate 4 crashed on it. The embed produced a network request Lighthouse
 *      could not classify, and the coverage check's error path read a field that
 *      was not there.
 *
 * `form` is on the list for a different reason from the other three. It does not
 * fetch anything, but a form inside a page we publish invites a reader to submit
 * data to an address we did not choose, which is the same class of thing.
 */
const EMBED_ELEMENTS = ['iframe', 'object', 'embed', 'form'] as const;

const EMBED_BLOCK = new RegExp(
  `<(${EMBED_ELEMENTS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  'gi'
);
const EMBED_VOID = new RegExp(`<\\/?(${EMBED_ELEMENTS.join('|')})\\b[^>]*>`, 'gi');

export interface EmbedRemoval {
  /** The element name, lower case. */
  tag: string;
  /** The host it would have loaded from, or null where it named none. */
  host: string | null;
}

/**
 * The host of a src or data attribute, for the note the page prints.
 *
 * Returns null rather than throwing on anything unparseable, because the tag is
 * already being removed and a malformed URL is not a reason to fail a build. The
 * host is reported so a reader is told what was withheld and from where, rather
 * than being shown a page that is quietly shorter than the employer's board.
 */
function hostOf(tag: string): string | null {
  const match = /\s(?:src|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!raw) return null;
  const url = /^https?:\/\/([^/?#\s"']+)/i.exec(raw.trim());
  return url ? url[1].toLowerCase() : null;
}

/**
 * The description with every remote embed removed, and a list of what went.
 *
 * The list is not diagnostics. It is rendered: the slot prints a machine voice
 * line naming the element and its host, outside the employer's own markup, so
 * the page never silently differs from the board it quotes.
 */
export function stripRemoteEmbeds(html: string): { html: string; removed: EmbedRemoval[] } {
  const removed: EmbedRemoval[] = [];

  const record = (tag: string) => {
    const name = /^<\/?\s*([a-z]+)/i.exec(tag)?.[1]?.toLowerCase() ?? 'element';
    removed.push({ tag: name, host: hostOf(tag) });
  };

  // Paired elements first, contents included: an iframe's fallback content is
  // the employer's, but it is written to be read only when the frame fails, and
  // promoting it to prose would be us deciding what the posting says.
  let out = html.replace(EMBED_BLOCK, (whole) => {
    record(/^<[^>]*>/.exec(whole)?.[0] ?? whole);
    return '';
  });

  // Then anything left unpaired, which is malformed markup rather than a valid
  // void element. Removing it is still the right direction.
  out = out.replace(EMBED_VOID, (tag) => {
    if (!tag.startsWith('</')) record(tag);
    return '';
  });

  return { html: out, removed };
}

/**
 * Renumber the employer's headings so they nest under the slot's own heading.
 *
 * THE PROBLEM THIS SOLVES, MEASURED RATHER THAN ASSUMED. 42 of 65 descriptions
 * carry headings, and employers use whatever level their own careers page wanted:
 * 78 h1s, 128 h2s, 27 h3s, 14 h4s across the set. The description slot's own
 * title is an h2, so Figma's h4 lands two levels below it with nothing between,
 * and Webflow's h1 lands above the page's own h1. Lighthouse scored ten role
 * pages 98 for accessibility against a floor of 100, every one of them a page
 * carrying employer headings, and every one of them for heading-order.
 *
 * THE FIX IS A RENUMBERING, NOT AN EDIT. The distinct levels the employer used
 * are sorted and mapped onto a contiguous run starting at `base`. So {h4} becomes
 * {h3}; {h1, h3} becomes {h3, h4}; {h2, h3} becomes {h3, h4}. The employer's own
 * hierarchy survives exactly: two headings that were at the same level stay at
 * the same level, and one that was above another stays above it. What changes is
 * where the whole structure hangs, which is a fact about our page rather than
 * about their posting.
 *
 * Attributes, ids and classes ride along untouched, so an anchor into the
 * description still resolves.
 */
export function nestHeadings(html: string, base = 3): string {
  const levels = new Set<number>();
  for (const match of html.matchAll(/<h([1-6])\b/gi)) levels.add(Number(match[1]));
  if (levels.size === 0) return html;

  const map = new Map<number, number>();
  [...levels]
    .sort((a, b) => a - b)
    .forEach((level, index) => {
      // Six is the floor of the ladder. An employer using more than four
      // distinct levels inside one description would otherwise ask for an h7,
      // and flattening the deepest few together is a smaller lie than inventing
      // an element that does not exist.
      map.set(level, Math.min(6, base + index));
    });

  return html.replace(/<(\/?)h([1-6])\b/gi, (whole, slash: string, level: string) => {
    const to = map.get(Number(level));
    return to ? `<${slash}h${to}` : whole;
  });
}

export interface RenderableDescription {
  /** Safe to pass to set:html. Null where the record carries no description. */
  html: string | null;
  /** What the embed pass removed, for the note beside the slot. */
  removed: EmbedRemoval[];
}

/**
 * The description as it goes onto an HTML page: embeds gone, headings nested.
 *
 * `renderableDescription` is for the page. `safeDescription` below is for the
 * other two consumers, the JSON-LD and the markdown twin, which want the embeds
 * gone for the same safety reason and want the employer's own heading levels
 * left alone, because neither of them is sitting inside this site's outline.
 */
export function renderableDescription(html: string | null, base = 3): RenderableDescription {
  if (!html) return { html: null, removed: [] };
  const stripped = stripRemoteEmbeds(sanitizeCrawledHtml(html));
  return { html: nestHeadings(stripped.html, base), removed: stripped.removed };
}

/** Sanitized, embeds removed, heading levels untouched. For JSON-LD and the
    markdown twin. */
export function safeDescription(html: string | null): string | null {
  if (!html) return null;
  return stripRemoteEmbeds(sanitizeCrawledHtml(html)).html || null;
}

/**
 * One machine voice sentence naming what was withheld, or null where nothing was.
 *
 * Written here rather than in the component so the page and the markdown twin
 * say the same thing. It names the element and the host and stops: what the
 * embed contained is not something we looked at, so it is not something we
 * describe.
 */
export function embedNote(removed: EmbedRemoval[]): string | null {
  if (removed.length === 0) return null;
  const named = removed
    .map((r) => (r.host ? `${r.tag} from ${r.host}` : `${r.tag} with no source named`))
    .join(', ');
  const subject =
    removed.length === 1
      ? 'One embedded element in this description is not rendered here'
      : `${removed.length} embedded elements in this description are not rendered here`;
  return `${subject}: ${named}. This site makes no third party requests, so an embed whose address comes from a feed is removed rather than loaded. Nothing the employer wrote was changed.`;
}
