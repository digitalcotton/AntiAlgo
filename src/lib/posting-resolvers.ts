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

/** The board systems this file reads through their own endpoint, plus the one
    employer (Apple) that runs its own. Kept as a subset of the store's own
    `SourceKind` rather than a fresh literal union, so a source kind this file
    can produce is always one the store already knows how to persist. */
export type ResolverKind = Extract<SourceKind, 'greenhouse' | 'ashby' | 'lever' | 'workable' | 'rippling' | 'workday' | 'apple'>;

/** The shape both readers produce, declared once in posting-extraction.ts —
    see that file's header for why it does not live in either reader. Re-exported
    here so existing importers of this module keep working. */
import type { PostingExtraction, PostingFacts } from './posting-extraction';
import { NO_FACTS } from './posting-extraction';

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

  // Apple: jobs.apple.com/<locale>/details/<jobNumber>[/<slug>]. The one
  // employer in this file rather than a board system, and the one resolver
  // whose `api` is the pasted page itself rather than a JSON endpoint -- see
  // `parseApple` for why that is the right call and not a shortcut. The
  // pasted URL is used verbatim: the slug-less form 301s, and a hop is a
  // third of the inline read's whole budget.
  if (host === 'jobs.apple.com' && segs.length >= 3 && segs[1] === 'details'
      && /^[a-z]{2}-[a-z]{2}$/.test(segs[0]) && /^\d{6,}(?:-\d+)?$/.test(segs[2])) {
    return {
      kind: 'apple',
      api: url,
      parse: (body) => parseApple(body, url),
      companyHint: 'Apple'
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
    /*
     * THE SECOND REQUEST IS STILL HERE, AND IT IS NOW THE RARE PATH.
     *
     * The header's "CORRECTION" section says the job payload NEVER carries the
     * company's name, and that was the reason this enrichment call exists. It
     * is no longer true: the per-job endpoint returns `company_name`, checked
     * on 2026-09-29 against figma, stripe, brex, airbnb and databricks, which
     * all answered with the employer's real name. `parseGreenhouse` now reads
     * it, so the common case costs one request instead of two -- worth having
     * inside a six second budget.
     *
     * It is NOT deleted, because "five boards answered" is not "every board
     * always will", and the caller only spends this when `parse` came back
     * with no company at all. A board that omits the field still gets its
     * proper name instead of a title-cased slug; every other board never pays
     * for the call.
     */
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

/* -------------------------------------------------------------------------
   THE FACTS EACH PAYLOAD STATES.

   ONE RULE GOVERNS ALL OF IT, AND IT IS NOT THIS FILE'S INVENTION.
   `descfill.py` on the mini says it outright, above `_comp_job`: "Never
   touches comp_range -- a stated string is not a parsed one." So `compPosted`
   is whatever wording the source published, carried through untouched, and
   `compMinK`/`compMaxK` come ONLY from a numeric field the platform itself
   filled in. No regex over prose, ever. Apple states its range in a sentence
   and therefore gets words and no numbers, which is the honest outcome and
   not a gap to close later with a parser.

   AND AN INTERVAL IS NOT OPTIONAL TO CHECK. Rippling publishes
   `{"frequency": "HOUR", "rangeStart": 18.0, "rangeEnd": 25.0}`. Taking those
   two numbers without reading `frequency` would file an $18-25/hour job as a
   $18K-$25K salary -- a real posting turned into a wrong one, in the field a
   person filters on. Every reader below takes a range only when the platform
   says it is annual.
   ------------------------------------------------------------------------- */

/** Thousands, the unit `jobs.comp_min_k` uses. Rounds, because a platform that
    publishes 211400 means $211.4K and the board stores 211. */
function thousands(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  // A "salary" under a thousand a year is not a salary; it is an hourly or
  // daily rate that arrived carrying the wrong interval, and rounding it would
  // file a real job at 0. Refusing it here means a platform we trusted about
  // its own interval cannot still hand us a number that is plainly not one.
  if (value < 1000) return null;
  const k = Math.round(value / 1000);
  return k >= 1 && k <= 100_000 ? k : null;
}

/** A pair, or nothing. Refuses a half-range and a backwards one, the same two
    things db/216's CHECK refuses, so a bad parse never reaches the insert. */
function compPair(min: unknown, max: unknown, currency?: unknown): Pick<PostingFacts, 'compMinK' | 'compMaxK' | 'compCurrency'> {
  const compMinK = thousands(min);
  const compMaxK = thousands(max);
  if (compMinK === null || compMaxK === null || compMinK > compMaxK) {
    return { compMinK: null, compMaxK: null, compCurrency: null };
  }
  const code = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency.trim())
    ? currency.trim().toUpperCase()
    : null;
  return { compMinK, compMaxK, compCurrency: code };
}

/** True when a platform's interval string means "per year". Written as an
    allowlist rather than "not hourly", so an interval nobody has seen yet is
    treated as unknown and its numbers are dropped, instead of being assumed
    annual and quietly mis-filing a job. */
function isAnnual(interval: unknown): boolean {
  if (typeof interval !== 'string') return false;
  const t = interval.toUpperCase().replace(/[\s_-]+/g, '');
  return t === '1YEAR' || t === 'YEAR' || t === 'YEARLY' || t === 'ANNUAL' || t === 'ANNUALLY' || t === 'PERYEAR';
}

/** A text fact: collapsed, trimmed, capped, and null when empty. */
function fact(value: unknown, cap = NAME_MAX_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const t = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, cap) : null;
}

/** An ISO instant from whatever a platform dates things with: an ISO string,
    or epoch milliseconds (Lever). Null on anything unrecognised. */
function factDate(value: unknown): string | null {
  const d = typeof value === 'number' ? new Date(value)
    : typeof value === 'string' && value.trim() ? new Date(value)
    : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
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
function buildExtraction(
  kind: ResolverKind,
  title: unknown,
  company: unknown,
  descriptionHtml: string | null,
  finalUrl: string,
  /** The facts this payload stated. Defaults to none, so a parser that has
      not been taught to read them yet says "the source did not say" -- which
      is wrong but harmless, and the compiler cannot tell the two apart. Every
      parser below passes them explicitly for that reason. */
  facts: Partial<PostingFacts> = {}
): Extraction {
  return {
    ...NO_FACTS,
    ...facts,
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
  const departments = Array.isArray(json.departments) ? json.departments : [];
  const firstDepartment = departments.find(isRecord);
  // `pay_input_ranges` is Greenhouse's structured pay. It is null on most
  // boards -- the employer has to fill it in -- so the common case here is no
  // pay at all rather than pay we declined to parse.
  const payRanges = Array.isArray(json.pay_input_ranges) ? json.pay_input_ranges : [];
  const pay = payRanges.find((entry) => isRecord(entry) && isAnnual(entry.interval));
  return buildExtraction('greenhouse', json.title, json.company_name, description, sourceUrl, {
    location: fact(isRecord(json.location) ? json.location.name : null),
    published: factDate(json.first_published),
    department: fact(firstDepartment?.name),
    compPosted: fact(isRecord(pay) ? (pay.title ?? null) : null, 1000),
    ...compPair(isRecord(pay) ? pay.min_cents : null, isRecord(pay) ? pay.max_cents : null, isRecord(pay) ? pay.currency_type : null)
  });
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
      return buildExtraction('ashby', job.title, null, typeof job.descriptionHtml === 'string' ? job.descriptionHtml : null, sourceUrl, ashbyFacts(job));
    }
  }
  return 'no_content';
}

/** Ashby states every fact this file collects, and states its pay in numbers:
    `summaryComponents` carries one entry per kind of compensation, and the one
    that matters is the Salary component with an annual interval. Equity rides
    in the same array with null values, and taking the array's first entry
    would read an equity grant as a salary. */
function ashbyFacts(job: Record<string, unknown>): Partial<PostingFacts> {
  const comp = isRecord(job.compensation) ? job.compensation : null;
  const components = comp && Array.isArray(comp.summaryComponents) ? comp.summaryComponents : [];
  const salary = components.find((c) => isRecord(c) && c.compensationType === 'Salary' && isAnnual(c.interval));
  return {
    location: fact(job.location),
    remote: typeof job.isRemote === 'boolean' ? job.isRemote : null,
    published: factDate(job.publishedAt),
    department: fact(job.department),
    employmentType: fact(job.employmentType),
    compPosted: fact(comp?.compensationTierSummary ?? comp?.scrapeableCompensationSalarySummary, 1000),
    ...compPair(isRecord(salary) ? salary.minValue : null, isRecord(salary) ? salary.maxValue : null, isRecord(salary) ? salary.currencyCode : null)
  };
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

  // `categories.team` used to be read here and thrown away, because the only
  // field it could have gone in was `company` and a department name there is
  // worse than the org slug (the header's own note says so). `department` is
  // a real field now, so the value has somewhere true to go.
  const categories = isRecord(json.categories) ? json.categories : null;
  const salary = isRecord(json.salaryRange) ? json.salaryRange : null;
  const annual = salary && isAnnual(salary.interval) ? salary : null;
  return buildExtraction('lever', json.text, null, description, sourceUrl, {
    location: fact(categories?.location),
    country: fact(json.country, 200),
    // Lever says onsite/remote/hybrid. Only "remote" is a remote job, and an
    // unrecognised value is "did not say" rather than false.
    remote: typeof json.workplaceType === 'string'
      ? (json.workplaceType.toLowerCase() === 'remote' ? true
        : ['onsite', 'on-site', 'hybrid'].includes(json.workplaceType.toLowerCase()) ? false : null)
      : null,
    published: factDate(json.createdAt),
    department: fact(categories?.department),
    employmentType: fact(categories?.commitment, 200),
    compPosted: fact(json.salaryDescriptionPlain ?? json.salaryDescription, 1000),
    ...compPair(annual?.min, annual?.max, annual?.currency)
  });
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
  return buildExtraction('workable', json.title, null, description, sourceUrl, workableFacts(json));
}

/** Workable spreads its location across `location`, and states remote as
    `telecommuting`. Its pay object is `salary`, whose interval Workable calls
    `salary_time_unit`. */
function workableFacts(json: Record<string, unknown>): Partial<PostingFacts> {
  const loc = isRecord(json.location) ? json.location : null;
  const salary = isRecord(json.salary) ? json.salary : null;
  const annual = salary && isAnnual(salary.salary_time_unit ?? salary.interval) ? salary : null;
  const place = [loc?.city, loc?.region, loc?.country].filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return {
    location: fact(place.length ? place.join(', ') : (typeof json.location === 'string' ? json.location : null)),
    country: fact(loc?.country ?? null, 200),
    remote: typeof loc?.telecommuting === 'boolean' ? loc.telecommuting
      : typeof json.telecommuting === 'boolean' ? json.telecommuting : null,
    published: factDate(json.published_on ?? json.created_at),
    department: fact(json.department),
    employmentType: fact(json.employment_type, 200),
    ...compPair(annual?.salary_from, annual?.salary_to, annual?.salary_currency ?? json.salary_currency)
  };
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
  // payRangeDetails is per location and carries its own `frequency`. The
  // observed value on a real posting was {"frequency": "HOUR", "rangeStart":
  // 18, "rangeEnd": 25} -- an $18/hour job that would have been filed as an
  // $18K salary by anything that read the numbers without the frequency.
  const ranges = Array.isArray(json.payRangeDetails) ? json.payRangeDetails : [];
  const annual = ranges.find((r) => isRecord(r) && isAnnual(r.frequency));
  const anyRange = ranges.find(isRecord);
  const locations = Array.isArray(json.workLocations)
    ? json.workLocations.filter((v): v is string => typeof v === 'string')
    : [];
  const department = isRecord(json.department) ? json.department.name : null;
  const employment = isRecord(json.employmentType) ? (json.employmentType.id ?? json.employmentType.label) : json.employmentType;
  return buildExtraction('rippling', json.name, json.companyName, description, sourceUrl, {
    location: fact(locations.join(', ')),
    remote: isRecord(anyRange) && typeof anyRange.isRemote === 'boolean' ? anyRange.isRemote : null,
    published: factDate(json.createdOn),
    department: fact(department),
    employmentType: fact(employment, 200),
    ...compPair(annual?.rangeStart, annual?.rangeEnd, annual?.currency)
  });
}

function parseWorkday(body: string, sourceUrl: string): Extraction | FailureCode {
  const json = parseJson(body);
  const info = isRecord(json) ? json.jobPostingInfo : null;
  if (!isRecord(info) || !info.title) return 'no_content';
  const description = typeof info.jobDescription === 'string' ? info.jobDescription : null;
  // `startDate` is the field this file's header named as dropped and "named so
  // it is not silently lost", because `Extraction` had nowhere to put a date.
  // `published` is that somewhere. `postedOn` is prose ("Posted 25 Days Ago")
  // and is deliberately not read: it is a rendering of the same fact, relative
  // to a day we do not know.
  const country = isRecord(info.country) ? info.country.descriptor : null;
  return buildExtraction('workday', info.title, null, description, sourceUrl, {
    location: fact(info.location),
    country: fact(country, 200),
    published: factDate(info.startDate),
    employmentType: fact(info.timeType, 200)
  });
}

/**
 * Apple, read out of the page's own hydration blob.
 *
 * WHY APPLE IS IN A FILE ABOUT BOARD SYSTEMS. It is not a board system; it is
 * one employer big enough to be worth an adapter, and it is here rather than in
 * posting-extract.ts because that file's header says every employer- and
 * ATS-specific parser belongs on this side of the seam. The URL shape above is
 * recognised the same way every other resolver's is, and the extraction it
 * produces is the same shape. Only the transport differs.
 *
 * WHY `api` IS THE PAGE AND NOT A JSON ENDPOINT. There is no public JSON
 * endpoint: /api/role/detail/<id> 301s to Apple's page-not-found. What there is
 * instead is a server-rendered React Router payload, `window.
 * __staticRouterHydrationData`, carrying the whole posting in the FIRST
 * response — title, body, responsibilities, both qualification lists, the
 * posting date, the locations. So one plain GET is enough and no browser is
 * needed, which is the entire point: this is the layer that exists so the
 * common case does not go to the queue.
 *
 * WHY THE GENERIC EXTRACTOR CANNOT DO IT. That reader parses `<script>` bodies
 * as raw, undecoded text and never looks inside them, deliberately, and Apple
 * publishes no JSON-LD `JobPosting`. Strip the scripts and the whole page is
 * about three thousand characters of Apple's nav and its EEO footer, all of it
 * inside tags the extractor skips — so it returned 'no_content' on every Apple
 * link a member ever pasted, and the mini's browser tail was the only thing
 * standing between that and a dead read.
 *
 * THE FIVE FIELDS ARE PROSE, NOT MARKUP, AND ARE WRAPPED DIFFERENTLY. Apple
 * ships them as plain text. `jobSummary` and `description` are hard-wrapped at
 * about eighty-five columns with real paragraph breaks between, so a single
 * newline there is a wrap to join and a blank line is a paragraph; the three
 * list fields put one whole item per line and are not wrapped at all, so a
 * newline there is an item. Getting that backwards would either run every
 * bullet into one paragraph or break every sentence into its own bullet, which
 * is why the two shapes are rendered by two functions rather than one. Every
 * piece is escaped on the way in: it is prose from a page on the internet, and
 * `parseLever` sets the same precedent for the same reason.
 *
 * THE HEADINGS COME FROM THE PAYLOAD. `jobsData.translations[selectedLocale]`
 * carries Apple's own label for each section, so a de-de posting gets German
 * headings over German prose instead of English ones. The English text below is
 * the fallback for a payload that stops carrying them, not the normal path.
 *
 * WHAT IS LEFT OUT. `postingFooters` holds the pay range and Apple's EEO and
 * accommodation boilerplate as HTML. The pay range is worth having and
 * `Extraction` has nowhere to put it (the same wall `parseWorkday`'s startDate
 * hit); the boilerplate is exactly the chrome every other reader in this
 * codebase works to exclude, and it would end up quoted back at Apple through
 * `tailor.ts`. Both are dropped together rather than taking the legal text to
 * get the number. Add a field to `Extraction` if the range is ever wanted.
 */
function parseApple(body: string, sourceUrl: string): Extraction | FailureCode {
  const data = appleJobsData(appleHydrationData(body));
  if (!data) return 'no_content';

  const label = appleLabels(data);
  const parts: string[] = [];
  for (const [field, key, fallback, shape] of APPLE_SECTIONS) {
    const value = data[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const rendered = shape === 'prose' ? appleProse(value) : appleList(value);
    if (rendered) parts.push(`<h3>${escapeHtml(label(key, fallback))}</h3>${rendered}`);
  }

  const description = parts.join('\n') || null;
  // Company is deliberately left for `companyHint`: the payload never names the
  // employer, because on Apple's own job site there is only one.
  return buildExtraction('apple', data.postingTitle, null, description, sourceUrl, appleFacts(data));
}

/**
 * Apple's stated facts. Everything here is a field in the payload except the
 * pay, which is the one Apple states only in a sentence.
 *
 * THE PAY RANGE ARRIVES AS PROSE AND STAYS PROSE. `postingFooters` carries a
 * "Pay & Benefits" section whose content reads "The base pay range for this
 * role is between $175,000 and $263,300, and your base pay will depend on your
 * skills, qualifications, experience, and location." The numbers are in there
 * and a regular expression would find them, and this file does not do that:
 * the rule the mini states above `_comp_job` is that a stated string is not a
 * parsed one. So the sentence becomes `compPosted`, `compMinK`/`compMaxK` stay
 * null, and an Apple posting sorts with the other unpriced ones while still
 * showing a member the range Apple actually published. If Apple ever publishes
 * the numbers as numbers, they land here and nothing else changes.
 *
 * Only the pay section is taken, by name, out of a footer array that also holds
 * Apple's EEO and accommodation boilerplate -- the chrome every reader in this
 * codebase works to exclude.
 */
function appleFacts(data: Record<string, unknown>): Partial<PostingFacts> {
  const locations = Array.isArray(data.locations) ? data.locations.filter(isRecord) : [];
  const first = locations[0];
  const place = first
    ? [first.city, first.stateProvince, first.countryName].filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : [];
  const teams = Array.isArray(data.teamNames) ? data.teamNames.filter((v): v is string => typeof v === 'string') : [];

  return {
    // More than one location is stated as the count rather than a list, so the
    // field never claims a single place a posting did not name.
    location: fact(place.length
      ? (locations.length > 1 ? `${place.join(', ')} and ${locations.length - 1} more` : place.join(', '))
      : null),
    country: fact(first?.countryName ?? null, 200),
    remote: typeof data.homeOffice === 'boolean' ? data.homeOffice : null,
    published: factDate(data.postDateInGMT ?? data.postingDate),
    department: fact(teams[0] ?? null),
    employmentType: fact(data.employmentType, 200),
    compPosted: applePayText(data)
  };
}

/** The "Pay & Benefits" footer's content, tags stripped, or null. Matched on
    Apple's own label so a change of footer order cannot hand back the EEO
    paragraph instead. */
function applePayText(data: Record<string, unknown>): string | null {
  const footers = Array.isArray(data.postingFooters) ? data.postingFooters.filter(isRecord) : [];
  for (const footer of footers) {
    const localizations = isRecord(footer.localizations) ? footer.localizations : null;
    for (const entries of Object.values(localizations ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.content !== 'string') continue;
        if (!/pay|compensation|salary/i.test(String(entry.name ?? ''))) continue;
        // The FIRST paragraph only. Apple's pay footer opens with the range
        // and then runs on into stock plans, medical cover and tuition
        // reimbursement -- a thousand characters of benefits blurb in a field
        // that is meant to say what the job pays. The paragraphs are separated
        // by <br><br> in Apple's own markup, and the range is always in the
        // first one.
        const [firstParagraph] = entry.content.split(/(?:<br\s*\/?>\s*){2,}/i);
        const text = fact((firstParagraph ?? '').replace(/<[^>]*>/g, ' '), 1000);
        if (text) return text;
      }
    }
  }
  return null;
}

/** The posting's sections in the order Apple's own page shows them, each with
    the translation key for its heading, the English fallback, and which of the
    two wrappings its text takes. */
const APPLE_SECTIONS: ReadonlyArray<readonly [string, string, string, 'prose' | 'list']> = [
  ['jobSummary', 'jobsite.jobdetails.summary', 'Summary', 'prose'],
  ['description', 'jobsite.jobdetails.description', 'Description', 'prose'],
  ['responsibilities', 'jobsite.jobdetails.responsibilities', 'Responsibilities', 'list'],
  ['minimumQualifications', 'jobsite.jobdetails.minimumQualifications', 'Minimum Qualifications', 'list'],
  ['preferredQualifications', 'jobsite.jobdetails.preferredQualifications', 'Preferred Qualifications', 'list']
];

/**
 * The object behind `window.__staticRouterHydrationData = JSON.parse("...")`,
 * or null.
 *
 * Two decodes, because the page holds two encodings: a JavaScript string
 * literal whose contents are JSON. The literal is walked a character at a time
 * rather than matched with a regular expression, because a posting that
 * contains a quotation mark carries a `\"` and a lazy `"(.*?)"` would stop on
 * it and hand back a truncated document. Nothing here evaluates the script; it
 * is read as the two pieces of data it is.
 */
function appleHydrationData(body: string): unknown {
  const marker = body.indexOf('window.__staticRouterHydrationData');
  if (marker < 0) return null;
  const open = body.indexOf('JSON.parse("', marker);
  if (open < 0) return null;

  let at = open + 'JSON.parse("'.length;
  const start = at;
  for (; at < body.length; at += 1) {
    const ch = body[at];
    if (ch === '\\') { at += 1; continue; }
    if (ch === '"') break;
  }
  if (at >= body.length) return null;

  try {
    return JSON.parse(JSON.parse(`"${body.slice(start, at)}"`) as string);
  } catch {
    return null;
  }
}

/** The posting inside that payload. `loaderData` is keyed by route id, so the
    route is found by the shape of what it carries rather than by its name --
    one rename on Apple's side should not cost us the read. */
function appleJobsData(json: unknown): Record<string, unknown> | null {
  const loader = isRecord(json) ? json.loaderData : null;
  if (!isRecord(loader)) return null;
  for (const route of Object.values(loader)) {
    const data = isRecord(route) ? route.jobsData : null;
    if (isRecord(data) && typeof data.postingTitle === 'string' && data.postingTitle.trim()) return data;
  }
  return null;
}

/** Apple's own label for a section heading, in the posting's own locale, with
    the English wording as the fallback. */
function appleLabels(data: Record<string, unknown>): (key: string, fallback: string) => string {
  const all = isRecord(data.translations) ? data.translations : null;
  const locale = typeof data.selectedLocale === 'string' ? data.selectedLocale : '';
  const table = all && isRecord(all[locale]) ? (all[locale] as Record<string, unknown>) : null;
  return (key, fallback) => {
    const value = table ? table[key] : null;
    return typeof value === 'string' && value.trim() ? value : fallback;
  };
}

/** Hard-wrapped prose: a blank line starts a paragraph, a single newline is a
    wrap to undo. */
function appleProse(value: string): string | null {
  const paragraphs = value
    .split(/\n[ \t]*\n+/)
    .map((para) => escapeHtml(para.replace(/\s*\n\s*/g, ' ').trim()))
    .filter(Boolean);
  return paragraphs.length ? paragraphs.map((para) => `<p>${para}</p>`).join('') : null;
}

/** One item per line, not wrapped. */
function appleList(value: string): string | null {
  const items = value
    .split(/\n+/)
    .map((line) => escapeHtml(line.trim()))
    .filter(Boolean);
  return items.length ? `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : null;
}
