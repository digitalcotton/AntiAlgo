/**
 * docx-resume.ts: the layout that turns a render into the styled lines docx.ts
 * writes, the exact sibling of pdf-resume.ts (RUN-DRAFT.md phase 4). docx.ts is
 * the byte writer and knows nothing about resumes; this file decides what a
 * drafted resume or cover letter looks like as a Word document, and it must
 * decide it the SAME way pdf-resume.ts does, or the .docx and the .pdf a person
 * downloads for one posting would disagree.
 *
 * WHY THIS FILE DELEGATES ITS LINES INSTEAD OF REBUILDING THEM. The safest way
 * to keep two documents identical is to give them one source of truth. DocxLine
 * is byte-for-byte the shape of pdf.ts's StyledLine (text, size, bold?,
 * spaceBefore?), so resumeDocxLines() and coverDocxLines() do not re-derive the
 * contact block, the current-title line, the section headings, the per-entry
 * core lines, or the credential folds; they return exactly what pdf-resume.ts's
 * resumeLines() and coverLines() already build. tailor.ts's own header calls out
 * "two copies of one rule" as a bug shape this repository has been bitten by
 * (see sharedVocabulary's comment); reproducing the resume layout here would be
 * that bug. So the layout lives once, in pdf-resume.ts, and both writers read
 * it. The parse-proof property the PDF has, each immutable-core field on its own
 * unbroken line so an ATS recovers the title, employer, and dates whole, is
 * therefore the SAME lines here, carried into single unbroken <w:t> runs by
 * docx.ts (a paragraph never splits a line into two runs).
 *
 * WHY THE BODY GUARDS ARE IMPORTED, NOT REDEFINED. resumeHasBody/coverHasBody
 * decide whether a settled render has anything worth downloading (an empty
 * record is a contact block over a blank page). That decision must be identical
 * for the .docx and the .pdf, so this file imports the very functions the PDF
 * route uses rather than write a second copy that could drift.
 */

import { buildDocx, type DocxLine, type DocxMeta } from './docx';
import { resumeLines, coverLines, resumeHasBody, coverHasBody } from './pdf-resume';
import type { ResumeRender, CoverRender } from './tailor';

/** Re-exported so a caller (the download route, a future gate) can read the
    body guards from either sibling without caring which one owns them. They are
    one rule, imported here, never a second copy. */
export { resumeHasBody, coverHasBody };

/** The styled lines for a resume, in reading order, identical to the PDF's.
    StyledLine and DocxLine are the same structural shape, so pdf-resume.ts's
    line list IS a DocxLine list; returning it here is what guarantees the two
    documents can never say different things. */
export function resumeDocxLines(resume: ResumeRender): readonly DocxLine[] {
  return resumeLines(resume);
}

/** The styled lines for a cover letter, identical to the PDF's, for the same
    reason resumeDocxLines() returns the resume's. */
export function coverDocxLines(cover: CoverRender): readonly DocxLine[] {
  return coverLines(cover);
}

/** The document title and author for the .docx metadata (docProps/core.xml).
    The author is the person named in the render header, the same source the PDF
    route feeds pdf.ts's /Author; omitted when the record carries no name. The
    title names the document plainly. */
function metaFor(header: ResumeRender['header'], docWord: 'resume' | 'cover letter'): DocxMeta {
  const name = header?.name ?? null;
  const title = name ? `${name} ${docWord}` : docWord.charAt(0).toUpperCase() + docWord.slice(1);
  return name ? { title, author: name } : { title };
}

export function buildResumeDocx(resume: ResumeRender): Uint8Array {
  return buildDocx(resumeDocxLines(resume), metaFor(resume.header, 'resume'));
}

export function buildCoverDocx(cover: CoverRender): Uint8Array {
  return buildDocx(coverDocxLines(cover), metaFor(cover.header, 'cover letter'));
}
