# Add a job: read it on the site, keep the mini for the hard tail

Spec, 2026-09-24. Owner asked for the fetch to stop being the Mac mini's job
in the common case. This is the seam, written before any edit, per the
small-changes method.

## What is true today

`src/pages/desk/posting.ts`, `intent=add`, does not fetch. It records a card
and a `desk_posting_fetch` row, publishes the request id to an ntfy topic, and
303s the person to `/board/added-<id>`, which waits. The Mac mini claims the
row (`/machine/posting-fetch/claim`), reads the page in three layers (ATS JSON
API, server HTML, headless Chromium), and posts the result back
(`/machine/posting-fetch/result`). Nothing drafts until the person presses
Generate on the posting's page.

Two facts that set the shape of this change:

1. **Most pasted URLs are on a platform we already understand.** The company is
   new to us; the plumbing is not. A Greenhouse or Ashby or Lever URL for a
   company we have never crawled still resolves to a JSON endpoint whose shape
   `postfetch.py` already handles. That read needs no browser, no queue, and no
   mini — one HTTPS call and a field map.
2. **The tail genuinely needs the mini.** A company's own hand-built careers
   page, or anything that only exists after JavaScript runs, needs
   `browser_read.py`. So does anything a datacenter IP gets challenged on,
   which is most bot-protected hosts.

So the mini stops being the front door and becomes the fallback.

## The seam

`intent=add` runs the read inline, with a hard budget, and falls back to the
queue it already builds:

```
acceptableUrl()                      unchanged
  -> jobForUrl()                     unchanged (the index's own posting)
  -> guardPostingUrl()               NEW: refuse before any socket opens
  -> resolvePosting()                NEW: the ATS JSON layer
  -> extractPosting()                NEW: JSON-LD, then prose
  -> settle the row inline, 303 to the posting page, filled
     ON ANY FAILURE OR TIMEOUT:
  -> createPostingFetch() + publishWake()    exactly as today
```

Nothing about the fallback path changes. A failed inline read costs one wasted
HTTPS call and lands the person exactly where they land today.

### Three pure modules, no route changes in this pass

Each is a straight port of logic that already exists and is already tested in
Python. Each takes its network as an injected function so its tests run
offline, the same discipline `postfetch.py` states in its own header.

| Module | Ports | Contract |
|---|---|---|
| `src/lib/posting-url-guard.ts` | `postfetch.check_url` | `(url, resolver?) => null \| FailureCode`. https only; no IP literals; no `.local/.internal/.lan/.localhost/.home/.arpa`; every resolved address must be public, which refuses private, loopback, link-local, reserved, multicast and `100.64.0.0/10`. Re-run on every redirect hop. |
| `src/lib/posting-resolvers.ts` | the ATS resolvers | `(url) => Resolved \| null` giving the API URL and a parser, plus `parse(json) => Extraction`. Greenhouse, Ashby, Lever, Workable, Rippling, Workday. |

**Correction, same day: one plan was the wrong contract.** The first version of
this spec said one API URL and one parser per resolver. That is wrong for two of
the six, and `postfetch.py` says so in its own comment: on Greenhouse the job
payload *never* carries the company name, so the board's own name is a second
request (`company_api`), and Workable's v2 job endpoint answers 404 often enough
that the v1 widget list is a real second attempt, not an enrichment. Dropping
both put a title-cased board slug in the company field — "onepassword" rendered
"Onepassword" — and the company field is read by `tailor.ts`, which means the
defect lands in the cover letter. So `Resolved` carries:

- `api` + `parse` — the primary call, as before.
- `fallback?: { api, parse }` — tried only when the primary yields a failure
  code. Workable is the one that has it.
- `companyApi?` + `companyParse?` — fetched only when `parse` returned no
  company. Greenhouse is the one that has it.
- `companyHint` — the title-cased org slug, the last resort, which is what the
  Python falls back to as well.

The caller owns the sequencing, because the caller owns the network and the
time budget. The module stays pure.
| `src/lib/posting-extract.ts` | the page extractor | `(html, finalUrl) => Extraction \| FailureCode`. JSON-LD `JobPosting` first, then the largest block of prose. `MIN_TEXT_CHARS` 200, `SHELL_TEXT_CHARS` 600. |

`Extraction` is `{ kind, title, company, descriptionHtml, finalUrl }` and
`FailureCode` is the existing `FAILURE_CODES` union in
`src/lib/posting-fetch-store.ts` — imported, never re-declared, because
`/machine/posting-fetch/result` already validates against it and two lists
would be two things to keep in step.

### Rules for this pass

- **No new dependencies.** `sanitize-html` is already on the tree, and
  `sanitizeCrawledHtml()` in `src/lib/description.ts` is the sanitiser the
  board's own descriptions go through. Reuse it; do not write a second one.
- **Sanitise on the way in regardless.** `result.ts`'s stance holds: bytes from
  a page on the internet are untrusted whether the mini fetched them or we did.
- **Caps stay where they are.** `DESCRIPTION_MAX_CHARS`, `SNAPSHOT_MAX_CHARS`,
  `NAME_MAX_CHARS` come from `posting-fetch-store.ts`.
- **Fixtures come from the mini**, not from live fetches: real recorded
  payloads that already back `test_postfetch.py`.

## Not in this pass, named so it is not forgotten

- **Wiring the route.** One commit, after the three modules land, by hand.
- **The learning lane.** If the site reads most postings itself, the mini stops
  seeing those URLs and `learn_board()` stops growing the crawl list — the
  "list builds and builds" half of the feature. Every add must hand its URL to
  the mini whether or not the site did the reading. Separate ticket; needs a
  route on the mini side that learns a board without claiming a read.
- **The scored detail page.** An added posting has no fit, risk, ease or age,
  because those come from having swept and measured a posting over time.
  `added-posting.ts` fills them with neutral values and never prints them.
  Whether a freshly read posting should show a fit score at all is an open
  design question, not a port.
- **Production wiring.** `anti-algo` production carries neither
  `MACHINE_FETCH_SECRET` nor `MACHINE_NTFY_TOPIC`, so `/machine/posting-fetch/
  claim` answers 503 `not-configured`, and the mini's `~/.jobmachine-fetch`
  still points at `https://tokenstoagents.ai/jobs`, the frozen deployment on a
  different database. The feature is dead in production until both sides are
  set. Config, not code.
