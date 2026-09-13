# The emails

Two of them, and they do different jobs.

| | Weekly digest | Instant alert |
| --- | --- | --- |
| Carries | new roles, the week's kills, one statistic, the legend | one role, why it matched, one action |
| Sent | weekly | when a new posting matches a stored filter |
| Statistic | exactly one, from `src/data/facts.json` | none, deliberately |
| Marks | yes, so the legend ships in the footer | yes, same |

Both are light theme only, email safe, and built from the same fixtures the site
reads. Neither is a route: an email is a build artifact of the sweep, handed to a
sending platform as a file.

## Build them

```
npm run emails                        # writes emails/out/
npm run emails:check                  # builds, compares, changes nothing
```

Both run `npm run tokens` first, because they have to. See below.

Exit 0 clean, 1 a check failed, 2 the build could not run. The same three codes
the six gates use.

`emails/out/` is generated. Regenerate it, never hand edit it. `--check` is what
proves the committed output is still what the sources produce, the same guard
`npm run fonts -- --check` gives the subsetted fonts. `emails:check` runs in CI,
so a committed digest that the sources no longer produce fails a pull request.

## A refused build deletes the last one, and that is deliberate

This script used to keep the previous output when a build failed, on the
reasoning that a good old copy beats a broken new one. That was wrong, and the
way it was wrong is the reason the rule changed on 2026-08-19.

The digest had been refusing to build since the machine started capturing
employers' descriptions, because employers write en dashes and this repository
forbids them. What sat in `emails/out/` was therefore built against the sweep 001
fixture: subject line "The Index: 28 new roles, 14 killed" against a sweep with
64 live and 0 killed, header stamped SWEPT AUG 17 against a sweep of AUG 19,
footer reading "62 boards read / 51 pulled / 37 verified / 14 killed" against 45,
64, 64 and 0, links to three role slugs that would 404, and one email stating
both that 0 postings were caught by a named rule and that 14 were killed this
week.

Nothing about the file said any of that. It looked ready to send. So a refused
build now removes its own previous output and says so, and `emails/out/` holds
nothing for that email, which is a true statement about a night we could not
build one. `--check` never deletes: a check reports on the tree, it does not edit
it.

RESOLVED 2026-08-24, and the fix is worth knowing about before you touch the
character check. The build refused for months over characters the employer typed,
which is not a defect in the email, it is the posting being republished byte for
byte the way every page on this site republishes it. test/gates/copy.mjs had
already solved the same problem for the site, exactly: a file is exempted not by
looking like it quotes somebody but by containing, verbatim, a field the employer
wrote that carries the offending character. scripts/build-emails.mjs imports that
function rather than restating it, and applies it PER OCCURRENCE rather than per
file. The site's gate demotes every finding in a file that republishes employer
text and compensates by checking everything the site itself authors in `src/`,
with no exemption; these templates live in `emails/`, which that scan does not
reach, so the same blanket rule here would leave our own sentences unchecked in
the one surface that cannot be corrected after it is sent. An employer's en dash
passes. Ours three paragraphs later still fails the build.

## Where this runs, and where it does not

Not on the mini. The mini has no node and no npm, so it cannot run this script at
all, and `nightly.sh` does not try. It is a laptop and CI artifact built from the
same three data files the site builds from. If the emails ever need to be
generated on the mini, node has to be installed there first, and this paragraph
is the note saying so.

## The interesting part: where the values come from

An email cannot use `var(--token)`. Outlook renders mail through Word, which has
never supported custom properties, and Gmail strips the `:root` block that would
define them. So every colour, size and space in these emails is a literal.

They are not typed literals. `emails/lib/tokens.mjs` reads
`src/styles/tokens.css`, which is Style Dictionary's compiled output, resolves
every `var()` chain to a value, and converts rem to px. The emails sit one step
further down the same pipeline the site sits on: the reference is resolved at
build time rather than at paint time.

Two consequences worth knowing:

1. **`npm run tokens` has to run first.** `src/styles/tokens.css` is generated
   and is not committed. Without it the build exits 2 and says so.
2. **A token change reaches the emails only when they are rebuilt.** The build
   prints the token file's compile time on every run for that reason.

There is exactly one visual value in the emails that no token owns: the 600px
message width, which is a mail client constraint rather than a design decision.
It is named `EMAIL_WIDTH` in `emails/lib/shell.mjs` and the reasoning is in the
comment above it.

## The two voices, and what happened to them

Standing rule 3 is N27 for editorial and Basier Square Mono for machine
assertions. Neither face can reach an inbox: there is no `@font-face` in email
that most clients honour.

The first build named the brand faces first anyway, on the reasoning that a
reader who has them installed should see them. Opened in a browser, every sans
line rendered as tofu boxes: a font named N27 is installed on the build machine,
`font-family: 'N27'` matched it, and it drew no Latin glyphs. Measured with a
canvas probe, "The weekly digest" at 36px is 673.3px wide in that matched font
against 288.1px in Helvetica.

So the emails name no brand face at all. What carries the rule is the part that
actually carries meaning: proportional for editorial, monospace for machine
assertions. Every mail client can draw that distinction. See
`emails/lib/tokens.mjs`.

The verification marks ship as text glyphs (`⊙ ⊕ ⊘`) with a symbol font stack,
because Gmail and Outlook strip SVG. Every mark prints its state as a word
beside it and the legend is in both footers, so nothing depends on a client
finding a font with U+2295 in it.

## What the build asserts before it writes

No gate reads this directory: the six gates walk the built site and an email is
not in it. `scripts/build-emails.mjs` therefore asserts, per email:

- no em dash, en dash or curly quote, in the HTML, the text, the subject or the
  preview line, encoded or literal
- no word from `test/banned-vocabulary.json`, read from that file rather than
  copied, and inflected the same way gate 3 inflects it. Checked against the text
  part, the subject and the preview line, which are pure copy, so a CSS property
  or a class name can never trip it
- the sweep stamp is present, and no other time is printed. One clock.
- every link is absolute, and every link into the site names a route `ROUTES` in
  `src/data/nav.ts` registers. A broken link in an email cannot be fixed after it
  is sent, which is the whole difference between an email and a page.
- no `var()` survived
- no `display:flex`, `display:grid` or absolute positioning
- no merge field the build did not declare
- a text part that is actually a text part
- under Gmail's 102KB clip, with a warning at 75% of it. Past that threshold
  Gmail hides the footer behind "View entire message", which means no legend and
  no unsubscribe for most readers.

A failing email is not written, and a failing build removes whatever it had
written before, for the reason the section above gives at length: a file left
sitting where somebody expects a sendable one is worse than nothing there, since
nothing about a stale file announces that it is stale. (This paragraph used to
say the opposite, that the last version that passed was kept. That was the
reasoning the four-day stale digest came from, and it was reversed; the two
statements sat in this file contradicting each other until 2026-08-24.) The
checks were proved by planting defects: a banned word, a second
banned word and an em dash in the digest subject produced three named failures
and no write, and the same for the alert.

## The selection rules, stated because a reader can check them

**New this week** is roles whose `first_observed` falls inside the seven days
ending at the sweep date. That is our own record, not the employer's claim: most
of these postings carry no published date at all, so we cannot say when they went
up, only when we first saw them. The email says exactly that and prints the
window.

The section states the window once instead of printing the same first seen date
on every row. On sweep 001 that date is identical for all 28 of them, and a
column of one repeated date would imply 28 postings appeared overnight. It is the
same reason the site suppresses its First seen column while the archive is
shallow.

**Killed this week** is kills whose `killed_on` falls in the same window, longest
measured duration first. A duration is `killed_on` minus `first_published`,
computed, never read from the stored `duration_open_days`. A kill whose figure
came from outside reporting prints no duration at all, because a number in that
position would read as ours.

**No duration bars.** The kill list draws them against a cited 9.8 day reference
line. This email carries one statistic and that is not it, and a bar with no
reference line is a picture of nothing.

Both sections are capped (10 roles, 6 kills) and both caps are stated in the copy
beside the rows, with the full count and a link to the full list.

## beehiiv

The HTML is a standalone document with everything inline, which is what a custom
HTML email in beehiiv needs. Paste `weekly-digest.html` or `instant-alert.html`
into a custom HTML block, and take the subject and the preview line from the
matching `.subject.txt`.

**Three things here have not been checked against a live account, because there
is no beehiiv key on this machine.** They are all in one place each so a
correction is one edit:

1. The merge fields, `MERGE` at the top of `scripts/build-emails.mjs`. They are
   `{{unsubscribe_url}}` and `{{preferences_url}}`. If beehiiv appends its own
   footer with an unsubscribe, the footer links here are the redundant ones and
   should be removed rather than left pointing at a tag that does not resolve.
2. The custom fields the capture endpoint sends, in `api/subscribe.ts`:
   `weekly_digest`, `instant_alerts`, `alert_filters`. Custom fields have to
   exist on the publication before beehiiv will store them, and it drops unknown
   ones without complaining.
3. That the account's sending domain and double opt-in are configured at all.

Until a key exists, the capture endpoint stores nothing and says so. See
`DECISIONS.md` under Blocked.

## Files

```
emails/
  lib/tokens.mjs        resolves the compiled tokens. Read this one first.
  lib/shell.mjs         the document, the type roles, the marks, the primitives
  lib/parts.mjs         the pieces both emails share: a role, a kill, the footer
  lib/content.mjs       what goes in, selected through src/lib/data.ts
  templates/            one file per email, HTML and text together
  out/                  generated. Regenerate it, never hand edit it.
scripts/build-emails.mjs  the runner and the assertions
api/subscribe.ts          the capture endpoint the emails are the other half of
src/components/capture/   the form: one field, two consents
```

Copy in both emails is drafted and flagged for Ryan's voice pass.
