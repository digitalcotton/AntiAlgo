# The board slug names a posting; the product names a role

Written 2026-09-26, after the nightly build failed on a duplicate `job_slug`
and the owner's question: *I thought we already have a deduplication process.*

You do. It is not the thing that broke, and the thing that broke is fixed. But
the question exposed a seam worth deciding on deliberately.

## The dedup that exists

`clusterJobs()` in `src/lib/data.ts`. Its rule, in its own words:

> two postings with the same company and title are the same role
> (definitionally, the same title at the same company), and their shared
> location collapses to one entry in `locations` rather than being listed
> twice. F10 describes the case that motivates this rule, the same role posted
> to several city boards.

It keys on `${company}\u0000${title}`, exactly, with no normalisation, and it
runs in `Board.astro` and `JobTable.astro`.

On tonight's crawl it earns its keep: **8,539 of 37,765 postings fold away, so
the board shows 29,226 rows.** A looser key that also ignored case and
punctuation would fold 561 more — the Nvidia pair below is one of them.

There is a second dedup, in `scripts/ingest-jobs.mjs`, and it is a different
thing: it drops a repeated `j.id`, because a repeated id would overwrite
itself. Tonight it dropped none. It was never going to catch this.

## What actually broke

Not dedup. The unique index on `board_kills.job_slug`.

A kill's id is `sha1(url|rule)[:12]`, so one posting killed under two rules is
two rows, and the ingest's join by URL hands both of them the same `j.slug`.
`ingest-jobs.mjs` already picks "the kill of record for a row with several"
with `SELECT DISTINCT ON (url)`, and `getBoardJobBySlug()` already expects
more than one and chooses with `ORDER BY first_killed_at_utc ASC NULLS LAST
LIMIT 1`. The unique index made the design the rest of the file is written
around unrepresentable.

Fixed in `db/210`, reproduced before and verified after against the real crawl
file, deployed 2026-09-26T11:36Z. The board is live on today's sweep.

The two pairs that tripped it are **not duplicates**:

| id | company | title | location |
|---|---|---|---|
| `teamtailor\|8443557` | Busuu | Freelance Online Japanese Teacher - Remote | Toronto |
| `teamtailor\|8443552` | Busuu | Freelance Online Japanese Teacher - Remote | USA |
| `teamtailor\|8446638` | Benedic 1721128878 | Gestionnaire de copropriété (H/F) | Nancy |
| `teamtailor\|8446633` | Benedic 1721128878 | Gestionnaire de copropriété (H/F) | Forbach; Saint-Avold; Sarreguemines |

`clusterJobs` handles these exactly as designed: one row, two locations. It
does not delete either posting, and it should not.

## The seam

**The slug is assigned per posting, at ingest. The dedup is per role, in the
view. They never meet.**

`slugFor()` builds `slugify(company + ' ' + title) + '-' + shortHash(id)`. The
base is the cluster key. The tail is the posting. So two postings of one role
get one row on the board and two different URLs — except when the tail happens
to collide, which is 117 slugs tonight.

That collision has its own cause, and it is a plain bug:

```
shortHash = h.toString(36).slice(0, 6)

djb2('teamtailor|8443557') = 4243736519 -> base36 1y6m01z -> slice(0,6) 1y6m01
djb2('teamtailor|8443552') = 4243736514 -> base36 1y6m01u -> slice(0,6) 1y6m01
```

A 32-bit value is up to **seven** base-36 characters. The slice drops the last
digit, collapsing every block of 36 neighbouring hashes onto one tail. The
function's own comment says it exists "so two different postings that slugify
the same still get distinct, stable URLs", which is the one thing it fails to
do.

Of the 117 collisions, **115 are the same company and title** — the very case
`clusterJobs` calls one role. The other 2 are the same role written twice with
different punctuation (`Senior Business Systems Analyst, SAP IBP Planning` and
`... - SAP IBP Planning`). So in practice every collision is a role colliding
with itself.

## The decision, which is the owner's

Three coherent answers. They are not fixes of the same size.

**A. Slug names the role.** Build the tail from the cluster key, not the
posting id. Every repeat of a role lands on one URL, which is what the board
already shows, and `board_kills.job_slug` becomes many-kills-to-one-slug,
which `db/210` now allows. The 117 stop being an accident and become the rule.
Costs: every `/board/<slug>` changes once, and `/board/<slug>` can no longer
address one posting of a multi-location role — the page would have to pick, or
show the cluster.

**B. Slug names the posting, properly.** Keep the intent and fix the tail —
drop the `.slice(0, 6)` (47% of URLs change, and 32-bit djb2 over 37,765 rows
still collides on roughly one night in seven, estimated, not measured), or
move to a wider hash (100% of URLs change once, collisions effectively gone).
Leaves the seam: one role, one board row, many URLs.

**C. Leave it.** The board list is already correct, `db/210` means a collision
no longer fails a build, and the cost is 117 postings a night that cannot be
reached at their own address — their twin wins the page. Nothing is louder
than that.

Nothing here is urgent now that the build is green. **A** is the one that
makes the slug agree with the rule the product already states.
