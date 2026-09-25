/**
 * posting-resolvers.ts: the board adapters' URLs, read in reverse.
 *
 * The mini's crawl adapters (sweep.py) know how to ask Greenhouse, Ashby,
 * Lever, Workable, Rippling and Workday for a WHOLE board's postings. A
 * person pasting ONE posting's URL is standing on the other side of that same
 * shape: the URL in front of them already names the board, the org slug and
 * the posting id, in public, in the address bar. This module is the
 * resolvers half of `postfetch.py` (the mini's single-posting reader) ported
 * to run in the site's own request instead of on the mini: given a posting
 * URL it recognises, it hands back the ATS's own JSON endpoint(s) and a
 * parser for each shape, with no board previously known, no crawl, no queue.
 * `docs/posting-fast-read-spec.md` is the seam this exists for: most pasted
 * URLs are on a platform this codebase already understands, and that read
 * needs one or two HTTPS calls and a field map, not a trip to the mini.
 *
 * PURE ON PURPOSE, SAME DISCIPLINE AS THE PYTHON. `postfetch.py` states in
 * its own header that nothing in it opens a socket, so its tests run
 * offline; this module keeps that line. `resolvePosting()` never fetches —
 * it returns the URL(s) to fetch and `parse` closures to hand each response
 * to. The caller (not written in this pass) does the HTTPS calls, decides
 * whether a fallback or an enrichment call is worth its slice of the time
 * budget, and decides what happens on failure — same as
 * `postfetch.read_posting()` does today with an injected `fetch`.
 *
 * CORRECTION, SAME DAY: A SINGLE PLAN WAS THE WRONG CONTRACT. The first
 * version of this file gave `Resolved` one `api` and one `parse`, on the
 * theory that the caller fetches exactly once per resolved posting. That
 * was wrong for two of the six board systems, and `postfetch.py` says so in
 * its own comments: on Greenhouse the job payload NEVER carries the
 * company's name (the comment above `_greenhouse_plans` in the Python is
 * explicit about this), so the board's own name is a genuine second request,
 * not an optional nicety; and Workable's v2 job endpoint 404s often enough
 * in practice that the Python keeps a v1 board-wide list as a real second
 * attempt, not an enrichment. Dropping both meant every Greenhouse add
 * landed with a title-cased board slug standing in for the company —
 * "onepassword" rendered "Onepassword" — and `tailor.ts` reads that company
 * field straight into the generated cover letter, so the shortcut was a
 * visible defect on the actual deliverable, not an internal simplification.
 * `Resolved` now carries three more (all optional except the hint):
 *
 *   - `fallback` — a second `{ api, parse }` pair, tried ONLY when the
 *     primary `parse` returns a `FailureCode`. Workable is the one resolver
 *     that has it (`_parse_workable_list` in the Python).
 *   - `companyApi` + `companyParse` — an enrichment call, made ONLY when the
 *     primary `parse` succeeded but returned no company. Greenhouse is the
 *     one resolver that has it (`_parse_greenhouse_board`).
 *   - `companyHint` — the title-cased org/board slug, present on every
 *     `Resolved`, the same as every plan in `postfetch.resolve()` carries
 *     one. It is the last resort when both the payload and `companyApi`
 *     (where there is one) give nothing.
 *
 * The module is still pure and still returns rather than fetches: the
 * ordering above (primary, then fallback-on-failure, then
 * companyApi-on-no-company, then companyHint) is a description of when EACH
 * piece is worth trying, not something this file executes. The caller owns
 * the sequencing, because the caller owns the network and the time budget
 * the spec's inline read runs under.
 *
 * WHAT A FAILED PARSE MEANS. `postfetch`'s parsers return `None` to tell
 * `read_posting()` "try the next plan, or fall through to the page read."
 * This file's `parse` (and `fallback.parse`) instead returns a `FailureCode`
 * so the caller can make that same fall-through decision. `'no_content'` is
 * the code used for every parse failure below — a 200 response whose JSON
 * does not carry a usable posting (bad JSON, no title, an id nothing in the
 * payload matches) is, for this posting, nothing to read, the same verdict
 * `postfetch.read_posting()` reaches when its own generic page extractor
 * comes back empty. `FailureCode` and the char caps are imported from
 * `posting-fetch-store.ts`, never redeclared, because the machine route that
 * already validates a `FailureCode` and two lists would be two things to
 * keep in step.
 *
 * WORKDAY'S startDate IS DROPPED, NAMED SO IT IS NOT SILENTLY LOST.
 * `_parse_workday` in the Python carries the posting's `startDate` through as
 * `published`, the one per-posting field none of these six board systems'
 * list endpoints already supply. The `Extraction` shape this pass's contract
 * fixes -- `{ kind, title, company, descriptionHtml, finalUrl }` -- has
 * nowhere to put it, so this port does not carry it. If a caller ever wants
 * a posting date out of Workday's per-job response, `Extraction` needs a
 * field added for it; this file does not invent one on its own.
 *
 * ENTITY DECODING IS A SUBSET, NOT `html.unescape`. Greenhouse escapes a
 * job's `content` field exactly once (`&lt;div&gt;` for `<div>`), and
 * `_parse_greenhouse` undoes that with Python's `html.unescape`, which knows
 * the full HTML5 named-entity table. This file has no such table built in
 * (Node has no equivalent in the standard library without pulling in a DOM),
 * so `decodeEntities` below knows only the entities these six ATS payloads
 * are known to carry -- the five XML entities plus a handful of common
 * punctuation ones -- and numeric character references in full. A payload
 * that leans on an entity outside that list would come through undecoded
 * rather than wrongly decoded; the fix, if that is ever observed, is to add
 * the entity to the table, not to reach for a parser here.
 */
import type { FailureCode, SourceKind } from './posting-fetch-store';
import { DESCRIPTION_MAX_CHARS, NAME_MAX_CHARS } from './posting-fetch-store';

/** The six board systems this pass reads through their own JSON API. Kept as
    a subset of the store's own `SourceKind` rather than a fresh literal
    union, so a source kind this file can produce is always one the store
    already knows how to persist. */
export type ResolverKind = Extract<SourceKind, 'greenhouse' | 'ashby' | 'lever' | 'workable' | 'rippling' | 'workday'>;

/** The shape both readers produce, declared once in posting-extraction.ts —
    see that file's header for why it does not live in either reader. Re-exported
    here so existing importers of this module keep working. */
import type { PostingExtraction } from './posting-extraction';

export type Extraction = PostingExtraction;

/** A parse pass over one JSON response: an extraction, or the code that
    tells the caller why there is nothing to keep from this response. */
type Parser = (body: string) => Extraction | FailureCode;

export interface Resolved {
  kind: ResolverKind;
  /** The ATS's own JSON endpoint for this posting. The caller fetches it. */
  api: string;
  /** The primary parse for `api`'s response, once fetched with a 200
      status. Never called by this module -- there is no fetch here to call
      it after. */
  parse: Parser;
  /**
   * A genuine second attempt at reading the SAME posting a different way,
   * tried only when `parse` returns a `FailureCode` -- not an enrichment,
   * a real fallback. Workable is the one resolver that sets this: its v2
   * per-job endpoint 404s often enough that the v1 board-wide list is worth
   * a second call. Absent for every other resolver, because the Python
   * gives none of them a second plan.
   */
  fallback?: { api: string; parse: Parser };
  /**
   * A second, narrower call made only when `parse` already succeeded but
   * its extraction carries no company -- an enrichment, not a fallback, so
   * it is only worth trying once the posting itself is known good.
   * Greenhouse is the one resolver that sets this, because its job payload
   * never carries the company's name; the board's own name is one more
   * request away.
   */
  companyApi?: string;
  companyParse?: (body: string) => string | null;
  /**
   * The org/board slug, title-cased -- present on every `Resolved`, the
   * same as every plan `postfetch.resolve()` builds. The last resort when
   * neither the payload nor `companyApi` (where there is one) name the
   * company.
   */
  companyHint: string;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The ATS's own JSON endpoint(s) and parser(s) for a posting URL this file
 * recognises, or `null`. `null` is not an error: it is the signal to fall
 * through to the generic page extractor, the same as an empty list from
 * `postfetch.resolve()`.
 */
export function resolvePosting(url: string): Resolved | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '');
  const segs = path.split('/').filter(Boolean);

  // Greenhouse: boards.greenhouse.io/<board>/jobs/<id>, job-boards[.eu].greenhouse.io/...,
  // or an embedded board on the company's own domain carrying gh_jid=<id>.
  if (/^(?:boards|job-boards(?:\.eu)?)\.greenhouse\.io$/.test(host) && segs.length >= 3 && segs[1] === 'jobs' && /^\d+$/.test(segs[2])) {
    return greenhousePlan(segs[0], segs[2], url);
  }
  const ghJid = parsed.searchParams.get('gh_jid') ?? '';
  if (/^\d+$/.test(ghJid)) {
    const board = registrableLabel(host);
    if (board) return greenhousePlan(board, ghJid, url);
  }

  // Ashby: jobs.ashbyhq.com/<org>/<uuid>[/application]
  if (host === 'jobs.ashbyhq.com' && segs.length >= 2 && UUID.test(segs[1])) {
    const org = segs[0];
    const pid = segs[1].toLowerCase();
    return {
      kind: 'ashby',
      api: `https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=true`,
      parse: (body) => parseAshby(body, pid, url),
      companyHint: companyHintFor(org)
    };
  }

  // Lever: jobs.lever.co/<org>/<uuid>
  if (host === 'jobs.lever.co' && segs.length >= 2 && UUID.test(segs[1])) {
    const org = segs[0];
    return {
      kind: 'lever',
      api: `https://api.lever.co/v0/postings/${org}/${segs[1].toLowerCase()}`,
      parse: (body) => parseLever(body, url),
      companyHint: companyHintFor(org)
    };
  }

  // Workable: apply.workable.com/<org>/j/<SHORTCODE>/. The v2 per-job
  // endpoint is the primary call; the v1 board-wide widget list is a real
  // fallback for a live 404, not an enrichment, so it rides in `fallback`
  // rather than being dropped (see the header's "CORRECTION" section).
  if (host === 'apply.workable.com' && segs.length >= 3 && segs[1] === 'j') {
    const org = segs[0];
    const code = segs[2];
    return {
      kind: 'workable',
      api: `https://apply.workable.com/api/v2/accounts/${org}/jobs/${code}`,
      parse: (body) => parseWorkable(body, url),
      fallback: {
        api: `https://apply.workable.com/api/v1/widget/accounts/${org}?details=true`,
        parse: (body) => parseWorkableList(body, code, url)
      },
      companyHint: companyHintFor(org)
    };
  }

  // Rippling: ats.rippling.com/<org>/jobs/<uuid>
  if (host === 'ats.rippling.com' && segs.length >= 3 && segs[1] === 'jobs' && UUID.test(segs[2])) {
    const org = segs[0];
    return {
      kind: 'rippling',
      api: `https://api.rippling.com/platform/api/ats/v1/board/${org}/jobs/${segs[2].toLowerCase()}`,
      parse: (body) => parseRippling(body, url),
      companyHint: companyHintFor(org)
    };
  }

  // Workday: <tenant>.<wdN>.myworkdayjobs.com/[<lang>/]<site>/job/<location>/<slug>_<REQ>
  const workday = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (workday) {
    const jobIndex = segs.indexOf('job');
    if (jobIndex >= 1 && segs.length > jobIndex + 1) {
      const tenant = workday[1];
      const site = segs[jobIndex - 1];
      const tail = segs.slice(jobIndex + 1).join('/');
      return {
        kind: 'workday',
        api: `https://${host}/wday/cxs/${tenant}/${site}/job/${tail}`,
        parse: (body) => parseWorkday(body, url),
        companyHint: companyHintFor(tenant)
      };
    }
  }

  return null;
}

function greenhousePlan(board: string, jobId: string, sourceUrl: string): Resolved {
  return {
    kind: 'greenhouse',
    api: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`,
    parse: (body) => parseGreenhouse(body, sourceUrl),
    // The job payload never carries a company name on Greenhouse (see the
    // header's "CORRECTION" section) -- the board's own name, one more
    // request, read by the caller only when `parse` came back company-less.
    companyApi: `https://boards-api.greenhouse.io/v1/boards/${board}`,
    companyParse: parseGreenhouseBoard,
    companyHint: companyHintFor(board)
  };
}

/** www.brex.com -> brex; careers.acme.co.uk -> acme (best effort). Ported
    unchanged from `postfetch._registrable_label`. */
function registrableLabel(host: string): string | null {
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  let core = labels.slice(0, -1);
  const publicSuffixes = new Set(['co', 'com', 'org', 'net', 'ac', 'gov']);
  if (core.length >= 2 && publicSuffixes.has(core[core.length - 1])) {
    core = core.slice(0, -1);
  }
  return core.length ? core[core.length - 1] : null;
}

/** A URL path segment turned into the title a person would recognise, e.g.
    "acme-careers" -> "Acme Careers". Ported from `postfetch._titled`. */
function titled(slug: string): string | null {
  const parts = slug.split(/[-_]+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase()).join(' ');
}

/** `companyHint` is a required field on `Resolved` -- every match this file
    makes comes from a non-empty URL path segment or hostname label, so
    `titled()` only returns null on an input `resolvePosting` never produces
    (a slug made entirely of "-"/"_"). The raw slug is the defensive
    fallback rather than an empty string, so a hint is never nothing. */
function companyHintFor(slug: string): string {
  return titled(slug) ?? slug;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ported from `postfetch._clean_name`: unescape, collapse whitespace, trim,
    cap at `NAME_MAX_CHARS` -- the same 500 the Python hardcodes, read from
    the store so the two never drift apart. */
function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed.slice(0, NAME_MAX_CHARS) : null;
}

/** A description this long has never come from a single ATS job payload in
    practice, but the cap this file's own record keeps (`DESCRIPTION_MAX_CHARS`)
    is enforced here too, on the same reasoning `pastePostingFetch` already
    applies to a person's own pasted text: a machine-thin read is capped the
    same way a person-typed one is, not trusted to stay under the line on its
    own. */
function capDescription(value: string | null): string | null {
  if (!value) return null;
  return value.length > DESCRIPTION_MAX_CHARS ? value.slice(0, DESCRIPTION_MAX_CHARS) : value;
}

/** The extraction a primary or fallback parse hands back. Company is
    whatever the payload itself gave (often nothing -- see each parser's own
    comment); it is deliberately NOT filled in with `companyHint` here. That
    fallback is the caller's job now, tried only after `companyApi` has also
    had its chance, which is exactly why `companyHint` moved out of this
    function and onto `Resolved` itself. */
function buildExtraction(kind: ResolverKind, title: unknown, company: unknown, descriptionHtml: string | null, finalUrl: string): Extraction {
  return {
    kind,
    title: cleanName(title),
    company: cleanName(company),
    descriptionHtml: capDescription(descriptionHtml),
    finalUrl
  };
}

// A minimal decode of the entities these six ATS payloads are known to
// carry, plus numeric character references in full. Not `html.unescape`'s
// complete HTML5 table -- see the header comment.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™'
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    const name = body.toLowerCase();
    return name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : match;
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Greenhouse escapes the body exactly once (`&lt;div&gt;`): one unescape,
    never two. Company is never on this payload -- `resolvePosting` attaches
    `companyApi`/`companyParse` for the caller to try before falling back to
    `companyHint`. */
function parseGreenhouse(body: string, sourceUrl: string): Extraction | FailureCode {
  const json = parseJson(body);
  if (!isRecord(json) || !json.title) return 'no_content';
  const raw = json.content;
  const description = typeof raw === 'string' ? decodeEntities(raw) : null;
  return buildExtraction('greenhouse', json.title, null, description, sourceUrl);
}

/** The board's own display name, off the board-list endpoint `companyApi`
    points at. Ported from `postfetch._parse_greenhouse_board`: a shape this
    defensive returns null rather than a guess on anything it does not
    recognise, the same as every parser in this file. */
function parseGreenhouseBoard(body: string): string | null {
  const json = parseJson(body);
  return isRecord(json) ? cleanName(json.name) : null;
}

function parseAshby(body: string, pid: string, sourceUrl: string): Extraction | FailureCode {
  const json = parseJson(body);
  const jobs = isRecord(json) ? json.jobs : null;
  if (!Array.isArray(jobs)) return 'no_content';
  for (const job of jobs) {
    if (isRecord(job) && String(job.id ?? '').toLowerCase() === pid) {
      return buildExtraction('ashby', job.title, null, typeof job.descriptionHtml === 'string' ? job.descriptionHtml : null, sourceUrl);
    }
  }
  return 'no_content';
}

/** Reassembles the three parts a Lever posting's body is split across:
    `description`, each `lists` block rendered as its own heading and list
    (the block's own `text` is the heading, escaped, since it is Lever's
    prose, not markup), then `additional`. Ported from `postfetch._parse_lever`.

    `categories.team` is read in the Python and then never used -- both
    branches of its own `None if not company else None` yield `None` -- so
    company is always left for the caller's `companyHint` fallback here,
    exactly as faithfully as porting a live variable that the source
    computes and discards. (Left exactly as-is on purpose: reading
    `categories.team` into the company field would put a department name
    there, which is worse than the org-slug hint.) */
function parseLever(body: string, sourceUrl: string): Extraction | FailureCode {
  const json = parseJson(body);
  if (!isRecord(json) || !json.text) return 'no_content';
  const parts: string[] = [];
  if (typeof json.description === 'string') parts.push(json.description);
  const lists = Array.isArray(json.lists) ? json.lists : [];
  for (const block of lists) {
    if (isRecord(block) && typeof block.content === 'string' && block.content) {
      const heading = escapeHtml(typeof block.text === 'string' ? block.text : '');
      parts.push(`<h3>${heading}</h3><ul>${block.content}</ul>`);
    }
  }
  if (typeof json.additional === 'string') parts.push(json.additional);
  const description = parts.join('\n') || null;
  return buildExtraction('lever', json.text, null, description, sourceUrl);
}

/** The v2 per-job endpoint. Company is never on this payload; falls to
    `companyHint` in the caller. */
function parseWorkable(body: string, sourceUrl: string): Extraction | FailureCode {
  const json = parseJson(body);
  if (!isRecord(json) || !json.title) return 'no_content';
  const parts: string[] = [];
  for (const key of ['description', 'requirements', 'benefits'] as const) {
    const value = json[key];
    if (value) parts.push(String(value));
  }
  const description = parts.join('\n') || null;
  return buildExtraction('workable', json.title, null, description, sourceUrl);
}

/** The v1 board-wide widget list, `resolvePosting`'s `fallback` for
    Workable: tried only when the v2 per-job endpoint's `parse` returned a
    `FailureCode` (a live 404, which the Python's own comment says happens
    often enough to be a real second attempt, not a nicety). Scans every job
    on the board for the one whose `shortcode` matches this posting's own.
    Ported from `postfetch._parse_workable_list`. */
function parseWorkableList(body: string, code: string, sourceUrl: string): Extraction | FailureCode {
  const json = parseJson(body);
  const jobs = isRecord(json) ? json.jobs : null;
  if (!Array.isArray(jobs)) return 'no_content';
  for (const job of jobs) {
    if (isRecord(job) && String(job.shortcode ?? '') === code) {
      return buildExtraction('workable', job.title, null, typeof job.description === 'string' ? job.description : null, sourceUrl);
    }
  }
  return 'no_content';
}

/** Orders the role's own description before the employer's boilerplate
    "about us" paragraph -- the correction the access ledger's Rippling notes
    made: `description` arrives as an object keyed by section, not already in
    reading order, and `role` must be read before `company` or a posting
    opens on the employer's history rather than the job itself. Every other
    key in the object (Rippling has been observed to add more over time)
    follows in whatever order the payload gave them. Ported from
    `postfetch._parse_rippling`. */
function parseRippling(body: string, sourceUrl: string): Extraction | FailureCode {
  const json = parseJson(body);
  if (!isRecord(json) || !json.name) return 'no_content';
  const desc = json.description;
  let description: string | null;
  if (isRecord(desc)) {
    const ordered = [desc.role, desc.company, ...Object.entries(desc)
      .filter(([key]) => key !== 'role' && key !== 'company')
      .map(([, value]) => value)];
    const parts = ordered.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
    description = parts.join('\n') || null;
  } else {
    description = typeof desc === 'string' ? desc : null;
  }
  return buildExtraction('rippling', json.name, json.companyName, description, sourceUrl);
}

function parseWorkday(body: string, sourceUrl: string): Extraction | FailureCode {
  const json = parseJson(body);
  const info = isRecord(json) ? json.jobPostingInfo : null;
  if (!isRecord(info) || !info.title) return 'no_content';
  const description = typeof info.jobDescription === 'string' ? info.jobDescription : null;
  return buildExtraction('workday', info.title, null, description, sourceUrl);
}
