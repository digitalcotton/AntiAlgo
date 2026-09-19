/**
 * draft-filename.ts: what a downloaded draft is called on the person's disk.
 *
 * "Ryan Payne resume for Brex.pdf", "Ryan Payne cover letter for Brex.pdf".
 * A file lands in a downloads folder beside every other file the person has
 * ever saved, and a name that says whose document it is and which company it
 * was written for is the one that still makes sense there a month later. The
 * posting slug it used to carry (acme-staff-designer-resume.pdf) meant
 * something to this site and nothing to the person.
 *
 * Pure, so the route and the room can name the same file the same way, and
 * so it is tested without a session. The name comes from the profile (first
 * and last, as the person typed them), then from the render's own header when
 * the profile has none, then falls back to the document's plain name.
 */

export type DraftDoc = 'resume' | 'cover';

export interface DraftFilenameInput {
  firstName?: string | null;
  lastName?: string | null;
  /** The render header's name, for a profile with no names on it. */
  fallbackName?: string | null;
  doc: DraftDoc;
  company: string | null;
}

/** Characters no filesystem takes (slashes, colons, the shell's wildcards and
    quotes, angle brackets, pipes) plus the control range, built from codes so
    the source holds no control character itself. */
const UNSAFE = new RegExp('[\\\\/:*?"<>|' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g');
const MAX_PART = 80;

function part(value: string | null | undefined): string {
  return (value ?? '').replace(UNSAFE, '').replace(/\s+/g, ' ').trim().slice(0, MAX_PART).trim();
}

/** The download formats a draft can be saved in, and the file extension each
    one gets. The resume and cover render the same content either way (see
    pdf-resume.ts and docx-resume.ts); only the container, and so the
    extension, differs. */
export type DraftExt = 'pdf' | 'docx';

/**
 * The filename for a draft in a given format: the same "<Person> <doc> for
 * <Company>" stem the site has always used, with the format's extension. The
 * stem is built once here so a .pdf and a .docx of the same document land in a
 * downloads folder under the same name but for the extension, and so adding
 * the .docx format did not fork the naming rule into a second copy.
 */
export function draftDocFilename(input: DraftFilenameInput, ext: DraftExt): string {
  const docWord = input.doc === 'resume' ? 'resume' : 'cover letter';
  const person = [part(input.firstName), part(input.lastName)].filter(Boolean).join(' ') || part(input.fallbackName);
  const company = part(input.company);
  const head = person ? `${person} ${docWord}` : docWord.charAt(0).toUpperCase() + docWord.slice(1);
  return `${company ? `${head} for ${company}` : head}.${ext}`;
}

/** The PDF filename, unchanged: the original name every existing caller reads.
    Kept as a thin wrapper over draftDocFilename() so its behaviour is defined
    in exactly one place and cannot drift from the .docx name. */
export function draftPdfFilename(input: DraftFilenameInput): string {
  return draftDocFilename(input, 'pdf');
}

/** The Content-Disposition value for that filename: a plain ASCII form every
    client reads, and the RFC 5987 form for a name with accents or other
    non-ASCII letters, so "Zoë" is not flattened for the clients that can keep it. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
