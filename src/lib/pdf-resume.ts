/**
 * pdf-resume.ts: the layout that turns a render into the styled lines pdf.ts
 * draws (RUN-DRAFT.md phase 4). pdf.ts is the byte writer and knows nothing
 * about resumes; this file is the one place that decides what a drafted resume
 * or cover letter looks like on the page, and it decides it the way
 * RESUME-RULES.md's format rules ask: single column, standard headings, the
 * contact block in the first lines of the body.
 *
 * WHY THE CORE FIELDS EACH GET THEIR OWN SHORT LINE. The immutable core
 * (official title, employer, dates) is what the parse-proof gate re-extracts
 * and checks byte-for-byte. A short line does not wrap, so each of those fields
 * lands in the extracted text as one unbroken run: the title on its own line,
 * the employer and the dates as their own segments of the meta line. Bullets
 * may wrap, and the gate matches those on their words rather than as one run,
 * because a wrapped line is still the same words in the same order, which is all
 * a bullet's truth needs.
 */

import { buildPdf, type StyledLine, type PdfMeta } from './pdf';
import type { ResumeRender, CoverRender, RenderEntry, RenderHeader } from './tailor';
import { groupResumeSection, type ResumeGroup } from './resume-grouping';
import { dateRange } from './entry-dates';

/** Re-exported from entry-dates.ts, its new home: the cover letter's core
    sentence needs the same date format this file's meta line uses, so the rule
    moved to a module both can import. Kept exported here so this file's own
    prior callers (and the parse-proof gate) still read it from pdf-resume.ts. */
export { dateRange };

/** The /Producer this site writes into every drafted PDF: the renderer that
    made the file, and nothing about a person. Named once here so the download
    route and any future caller set the same truthful value. */
export const RESUME_PDF_PRODUCER = 'tokenstoagents.ai resume renderer';

/** The contact block: the name as a heading, then one line of the email and
    links. First lines of the body, per RESUME-RULES.md's format rules. Empty
    when the record carries no name, email, or link (a headerless render). */
function contactLines(header: RenderHeader | null): StyledLine[] {
  const lines: StyledLine[] = [];
  if (!header) return lines;
  if (header.name) lines.push({ text: header.name, size: 18, bold: true });
  const bits: string[] = [];
  if (header.email) bits.push(header.email);
  for (const link of header.links) bits.push(link.url);
  if (bits.length > 0) lines.push({ text: bits.join('   '), size: 10 });
  return lines;
}

/** One entry: the official title on its own bold line, then a meta line of the
    employer and the dates, then the bullets. Each core field is its own run so
    the parse-proof gate reads it whole. */
function entryLines(entry: RenderEntry): StyledLine[] {
  const lines: StyledLine[] = [{ text: entry.core.officialTitle, size: 11, bold: true, spaceBefore: 8 }];
  const meta: string[] = [];
  if (entry.core.employerOrInstitution) meta.push(entry.core.employerOrInstitution);
  meta.push(dateRange(entry.core));
  lines.push({ text: meta.join('   '), size: 10 });
  for (const bullet of entry.bullets) lines.push({ text: bullet.text, size: 10, spaceBefore: 2 });
  return lines;
}

/** A folded credential group (resume-grouping.ts): the shared body on its own
    bold line, then the date range, then the titles on one line. Each title
    stays an unbroken run in that joined line, so the parse-proof gate still
    finds every one. */
function groupLines(group: ResumeGroup): StyledLine[] {
  const core = { employerOrInstitution: group.issuer, officialTitle: group.issuer, start: group.start, end: group.end };
  return [
    { text: group.issuer, size: 11, bold: true, spaceBefore: 8 },
    { text: dateRange(core), size: 10 },
    { text: group.titles.join(', '), size: 10, spaceBefore: 2 }
  ];
}

/** The person's current title, for the top of the page. RESUME-RULES.md and
    RUN-DRAFT.md phase 3 both ask that the top third carry the current title, not
    only the name: the top of a resume is where a skim lands, and a title is what
    a skim reads first. The current role is an experience entry with no end date;
    if there is more than one, the one that started most recently. Null when the
    record names no ongoing role, in which case no subtitle is drawn rather than
    an invented one. */
function currentTitleLine(resume: ResumeRender): StyledLine | null {
  // Order two ongoing roles by their actual start, month included, not year
  // alone; a null month sorts as the start of the year.
  const startedAt = (entry: RenderEntry): number => entry.core.start.year * 12 + (entry.core.start.month ?? 1);
  let current: RenderEntry | null = null;
  for (const section of resume.sections) {
    if (section.kind !== 'role_held') continue;
    for (const entry of section.entries) {
      if (entry.core.end !== null) continue;
      if (current === null || startedAt(entry) > startedAt(current)) current = entry;
    }
  }
  if (current === null) return null;
  const employer = current.core.employerOrInstitution;
  const text = employer ? `${current.core.officialTitle}, ${employer}` : current.core.officialTitle;
  return { text, size: 11, bold: true };
}

/** The styled lines for a resume, in reading order. Exported so the parse-proof
    gate can lay a render out exactly as the download does, without a PDF in
    between, when it wants to check the layout alone. */
export function resumeLines(resume: ResumeRender): StyledLine[] {
  const lines = contactLines(resume.header);
  // The current title rides in the top third, right under the contact block,
  // so a skim reads it before the first experience entry (which is ordered by
  // relevance to the posting, not recency).
  const current = currentTitleLine(resume);
  if (current) lines.push(current);
  for (const section of resume.sections) {
    lines.push({ text: section.heading, size: 12, bold: true, spaceBefore: 18 });
    for (const row of groupResumeSection(section)) {
      lines.push(...(row.kind === 'entry' ? entryLines(row.entry) : groupLines(row.group)));
    }
  }
  return lines;
}

/** The styled lines for a cover letter: the contact block, the salutation, the
    body, then the closing and the name. The body is the letter's own prose
    paragraphs (cover.paragraphs), one styled line each with paragraph spacing;
    pdf.ts's wrap() breaks a long paragraph across lines on its own. A render
    stored before the letter engine existed has no paragraphs and falls back to
    the old shape (the styled slots the resume used), so an old cover still
    downloads. */
export function coverLines(cover: CoverRender): StyledLine[] {
  const lines = contactLines(cover.header);
  lines.push({ text: cover.salutation, size: 11, spaceBefore: 18 });
  if (cover.paragraphs) {
    for (const paragraph of cover.paragraphs) lines.push({ text: paragraph.text, size: 11, spaceBefore: 8 });
  } else {
    for (const section of cover.sections) {
      for (const entry of section.entries) {
        for (const bullet of entry.bullets) lines.push({ text: bullet.text, size: 11, spaceBefore: 6 });
      }
    }
  }
  lines.push({ text: cover.closing, size: 11, spaceBefore: 12 });
  if (cover.header?.name) lines.push({ text: cover.header.name, size: 11, spaceBefore: 2 });
  return lines;
}

/**
 * Whether a resume render has a body to draw. A section exists only when the
 * record has entries of that kind, so a render with no sections is an
 * empty-record render, and handing it over would be a blank page with a
 * contact block at most. The entry cores carry the body (title, employer,
 * dates), so one section with one entry is enough; bullets are a bonus, not
 * the floor.
 */
export function resumeHasBody(resume: ResumeRender): boolean {
  return resume.sections.some((section) => section.entries.length > 0);
}

/**
 * Whether a cover render has a letter body worth downloading. A real letter's
 * body is its proof and fit paragraphs (opener and close alone, over a thin
 * record, are a greeting and a sign-off, not a letter). A render stored before
 * the letter engine existed has no paragraphs and falls back to the old test,
 * a section with at least one bullet, so an old cover still gates the same way.
 */
export function coverHasBody(cover: CoverRender): boolean {
  if (cover.paragraphs) {
    return cover.paragraphs.some((paragraph) => paragraph.role === 'proof' || paragraph.role === 'fit');
  }
  return cover.sections.some((section) => section.entries.some((entry) => entry.bullets.length > 0));
}

export function buildResumePdf(resume: ResumeRender, meta: PdfMeta): Uint8Array {
  return buildPdf(resumeLines(resume), meta);
}

export function buildCoverPdf(cover: CoverRender, meta: PdfMeta): Uint8Array {
  return buildPdf(coverLines(cover), meta);
}
