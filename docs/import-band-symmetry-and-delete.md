# The import band: two sections the same shape, and a delete that takes back what it brought in

Owner ask, 2026-09-25, on two screenshots of `/profile`:

1. "The resume and cover letter sections need to be the same, essentially."
2. "When the user deletes their resume or cover letter, we delete the input" —
   asked again, plainly: **whatever records we took in, delete them.**

## What is wrong today

**The two sections do not look like the same product.** The resume half has a
dashed drop box, an arrow, a heading, a hint line and a file chip
(`ImportBand.astro`, `.import-dropzone`). The cover-letter half, one hairline
below it, has a bare `<input type="file">` — the browser's grey "Choose File /
no file selected" — and a raw `<textarea>` sitting open under it. Same band,
same endpoint shape, two different eras of the design.

`/profile`'s own script already reaches for `[data-cover-dropzone]`,
`[data-cover-file-input]` and `[data-cover-file-chips]`
(`src/pages/profile.astro:800`), and wires `wireDropZone` + `showChosenFile` to
them. **None of those attributes exist in the markup.** The enhancement was
written and the markup it enhances never landed. So this is not a new feature
on the script side; it is finishing one.

**Removing a document leaves its entries behind.** `clearCoverLetter` nulls
three columns on `app_user_profile` and stops. Every entry the letter proposed
into the Profile Record stays, with no way to tell which entries those were.
And there is no remove for a resume at all: a resume read is a one-way door,
so a second upload stacks a second copy of every role on top of the first.
Screenshot two shows exactly that — `PRF-0001` and `PRF-0003` are the same
title at the same employer.

## The rule

An imported entry belongs to the document that brought it in. Removing the
document removes those entries. An entry typed by hand belongs to nobody but
the person, and no remove ever touches it.

That needs a thing the record does not have: **provenance**. `record_entry`
today cannot say where a row came from.

## What gets built

### 1. `db/209_import_source.sql`

- `record_entry.import_source text CHECK (import_source IN ('resume','cover_letter'))`,
  nullable. **NULL means typed by hand**, which is what every existing row is
  treated as — so the migration is additive and no historical row becomes
  deletable by a remove it never agreed to. Indexed on `(user_id, import_source)`,
  the only shape a remove or a count ever filters on.
- `resume_parse.import_source text NOT NULL DEFAULT 'resume' CHECK (...)`. The
  parse buffer is the only thing that survives between the upload request and
  the background apply, so it is where the answer to "which document is this"
  has to live. A cover letter goes through the same reader (`cover.ts` calls
  `startResumeParse`), and without this column the apply cannot tell the two
  apart.
- `app_user_profile.resume_source_name text` + `resume_added_at timestamptz`.
  The resume's receipt line, so there is something to remove.

**The covenant is not touched.** Line 03 of the band says "Read once, in
memory, then gone. Nothing stored, nothing sent to us." That stays true: this
stores the file's *name* and *when it was read*, never the file and never its
text. `db/115`'s own header already draws that line for `source_name`; this
column is the same fact, kept past the buffer.

### 2. `src/lib/record-store.ts`

- `createEntry(userId, input, importSource = null)` — one optional third
  argument, so every hand-entry caller keeps working untouched.
- `deleteEntriesFrom(userId, source): Promise<number>` — one `DELETE`,
  returning how many went. `record_artifact` cascades on the composite key
  (`db/104`), so the links attached to those entries go with them.
  **PRF ids are not returned to the pool**, matching `deleteEntry`: an id is
  spent when it is issued, and a reused id is a different fact wearing an old
  number.
- `getResumeOnFile` / `setResumeOnFile` / `clearResumeOnFile`, shaped exactly
  like the `CoverLetter` trio above them.

### 3. Threading the source

`startResumeParse(userId, sourceName, sourceText, importSource)` →
`beginParse(..., importSource)` → `parseInBackground(..., importSource)` →
`applyParsedProposals(..., importSource)`. `landReadyParse` reads it back off
the stored parse row, so a read that lands late (on the next `/profile` load,
or on a draft POST) is still tagged with the document it came from.

### 4. Endpoints

- `profile/import/parse.ts`: passes `'resume'`; on a successful start, stamps
  `setResumeOnFile(userId, file.name)`. Gains an `intent=remove` — the same
  verb `cover.ts` already answers to — which clears the receipt, deletes the
  `'resume'` entries, and clears any parse still in the buffer.
- `profile/import/cover.ts`: passes `'cover_letter'`; its existing
  `intent=remove` also deletes the `'cover_letter'` entries.

Both removes say what they removed on the way back.

### 5. `ImportBand.astro`

The cover-letter half gets the resume half's shape: the same dashed box, the
same arrow, heading, hint and chip, the same "Paste text instead" `<details>`
rather than a textarea hanging open. It carries the three `data-cover-*`
hooks `/profile`'s script has been looking for.

The resume half gains what only the cover letter had: an on-file line naming
what was read and when, with a **Remove**. Both removes name their cost in the
markup — "Remove it and the N entries it added" — because a control that
deletes confirmed record rows must not read like a control that tidies up a
filename.

## Blast radius

`ImportBand.astro` renders on `/profile` and on `/_states` (the gate specimen
page). `startResumeParse` has two callers, `applyParsedProposals` has two,
`landReadyParse` has four. `createEntry`'s new argument is optional, so the
hand-entry path, the import path and the tests all keep their call shape.

`npm run conform` before the push.
