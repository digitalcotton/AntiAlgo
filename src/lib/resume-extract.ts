/**
 * resume-extract.ts: the byte-to-text front door for MASTER-SPEC F2's import
 * boost. record-import.ts reads line shapes out of a clean string and never
 * touches a file; this file's whole job is to turn one uploaded document into
 * that clean string, and to fail honestly when it cannot. The two are meant to
 * be read together: this file decides "can these bytes become text at all",
 * record-import.ts decides "does that text contain a role I can propose". Wire
 * them in that order (extract here, hand result.text to parseResumeImport
 * there); neither knows about the other, which is the point.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE PARSER. Reading a .docx or a .pdf means
 * pulling in a zip reader or a whole copy of pdf.js, code that does real I/O
 * shaped work (decompress, decode, walk an object graph) and can throw on a
 * corrupt or hostile file. record-import.ts's header promises it does NO I/O
 * and NEVER throws, and keeping that promise means the messy part lives here,
 * behind a function that catches everything and returns a plain result object
 * instead of letting an exception escape. A caller gets one shape back,
 * whether the upload was a pristine markdown file or a password-protected PDF.
 *
 * WHY THE HEAVY LIBRARIES ARE IMPORTED INSIDE THE BRANCHES, NOT AT THE TOP.
 * mammoth and unpdf are large (unpdf bundles pdf.js). A person uploading a
 * plain .txt should not pay to load a PDF engine, and, more importantly, a
 * static top-level import would pull both into every serverless bundle that
 * imports this module even on the markdown path. The `await import()` inside
 * extractDocx()/extractPdf() defers each library to the one request that
 * actually needs it and lets the bundler split it into its own chunk. unpdf's
 * getDocumentProxy() runs pdf.js WITHOUT a web worker, which is the path that
 * survives a Node serverless environment where no worker thread is spun up for
 * us; do not "optimise" this into the worker based API.
 *
 * WHAT THIS FILE WILL NEVER DO. It does not store the upload, write it to
 * disk, or log its contents. Everything happens in memory in extractResumeText
 * and is gone when it returns. Above all, no failure message ever contains a
 * byte of the document or the raw text of a thrown error: an error object from
 * a document library can carry a fragment of the file it choked on, so every
 * catch below returns a FIXED sentence and swallows the caught value. A person
 * pasting a confidential resume gets "this could not be read", never an echo
 * of their own salary history in an error string.
 *
 * THE ONE PROMISE EVERY BRANCH BELOW KEEPS: no bytes in, no lie out. An empty
 * upload, an upload too large to accept, a type this file does not read, a
 * file that decodes to nothing but whitespace (a scanned image PDF with no
 * text layer): each returns { ok: false } with a message a person can act on,
 * never a hollow { ok: true, text: '' } that would send an empty string
 * downstream to be parsed into nothing and reported as "we read your file".
 */

/** The upper bound on an accepted upload, in bytes. 4 MB is generous for a
    resume in any of the formats this file reads (a text-layer PDF or a .docx
    is small; only images inflate a document, and this file cannot read an
    image anyway), and it sits under the 4.5 MB request-body limit a Vercel
    serverless function enforces before this code ever runs, so a person hits
    this file's own clear message rather than an opaque platform 413. Stated as
    the arithmetic rather than a magic number so the 4 is legible. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** The one sentence returned for a file that a library could not read: a
    corrupt archive, a password-protected PDF, a truncated upload. Held as a
    constant because it MUST be identical everywhere and MUST NOT be built by
    interpolating anything about the file (see this file's header on why an
    error's own text never reaches a person). */
const UNREADABLE_MESSAGE =
  'This file could not be read. It may be corrupt, password-protected, or not the format its name suggests. ' +
  'Try re-exporting it, or paste the text directly.';

/** The one sentence returned when extraction succeeded mechanically but found
    no text: most often a scanned image saved as a PDF, which is a picture of a
    resume with no text layer under it. */
const NO_TEXT_MESSAGE =
  'No text could be read from this file. If it is a scanned image, it has no text layer to read.';

/** Named so the "what IS supported" wording lives in exactly one place and the
    unknown-type and unsupported-.doc messages cannot drift apart from it. */
const SUPPORTED_TYPES = 'Markdown, plain text, PDF, or Word (.docx)';

/**
 * The result of trying to turn one upload into text. A discriminated union so
 * a caller cannot read `.text` without first proving `ok` is true, and cannot
 * treat a failure as an empty success. `notes` is the honest-caveat channel:
 * short, factual sentences about what was read (how many PDF pages, say), for
 * a UI to surface next to the text, never a place to hide a warning that
 * should have been a failure.
 */
export type ResumeExtraction =
  | { ok: true; text: string; notes: string[] }
  | { ok: false; message: string };

/** The file extension read off `file.name`, lowercased and without the dot, or
    null when the name has no extension at all. Only the substring after the
    LAST dot is taken, so "ada.resume.docx" reads as "docx", and a leading-dot
    name with nothing after it ("resume.") reads as null rather than "". */
function extensionOf(name: string): string | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1 || dot === lower.length - 1) return null;
  return lower.slice(dot + 1);
}

/* -------------------------------------------------------------------------
   The three readers. Each takes the already-size-checked File and returns
   either the raw extracted text or a failure. None of them decides whether
   the text is empty or trims it; that judgment is made once, in
   extractResumeText, so every path answers to the same rule.
   ------------------------------------------------------------------------- */

/**
 * Markdown and plain text. Both are just `await file.text()`; the only
 * difference is that markdown carries markup the deliberately-dumb line parser
 * in record-import.ts would misread (a "# Senior Designer" heading is not a
 * title line with a stray "# " on it, it is a heading). This strips the most
 * common markup so the parser downstream sees the clean line shapes it was
 * built to read, using plain regexes rather than a markdown library: the goal
 * is not a faithful markdown-to-text render, it is to get "#", ">", list
 * bullets and inline emphasis out of the way while leaving every line break
 * exactly where it was (the parser reads line shapes, so a removed newline
 * would be a changed fact). A markdown feature this does not know about is
 * left in the text rather than guessed at; it becomes, at worst, a line the
 * downstream parser does not recognise, which it already handles.
 */
function stripMarkdown(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      let out = line;
      // Leading heading markers: "# ", "## ", up to the six ATX levels, with
      // any indentation before them. The hashes and the one space after are
      // removed; the heading's words stay.
      out = out.replace(/^\s*#{1,6}\s+/, '');
      // Leading blockquote markers, one or more "> " deep.
      out = out.replace(/^\s*(?:>\s?)+/, '');
      // A leading list bullet: "-", "*", or "+" followed by a space. Ordered
      // list markers ("1.") are left alone: a bare number and a period is a
      // shape the downstream date parser and a person both read fine, and
      // stripping it would risk eating a real "2019." off the front of a line.
      out = out.replace(/^\s*[-*+]\s+/, '');
      return out;
    })
    .join('\n')
    // Inline code, emphasis and strong markers, removed wherever they sit on a
    // line. Backticks, asterisks and underscores are dropped and the text
    // between them kept; this is done after the per-line leading-marker pass so
    // a bullet's "*" is already gone and only genuine emphasis asterisks are
    // left to match here.
    .replace(/[`*_]/g, '');
}

/**
 * DOCX, via mammoth's raw-text extractor. mammoth wants a Node Buffer, so the
 * File's bytes are read once into an ArrayBuffer and wrapped. `.doc` (the old
 * binary Word format) never reaches here: extractResumeText rejects it by name
 * before dispatching, because mammoth reads only the modern zipped OOXML .docx
 * and would fail on a .doc in a way that looks like corruption rather than an
 * unsupported format. The import is dynamic (see this file's header); the
 * .default is mammoth's CommonJS module object.
 */
async function extractDocx(file: File): Promise<ResumeExtraction> {
  try {
    const mammoth = (await import('mammoth')).default;
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await mammoth.extractRawText({ buffer });
    return { ok: true, text: result.value, notes: [] };
  } catch {
    // The caught value is swallowed on purpose: a document library's error can
    // carry a fragment of the file. See this file's header.
    return { ok: false, message: UNREADABLE_MESSAGE };
  }
}

/**
 * PDF, via unpdf's serverless path: getDocumentProxy() loads pdf.js without a
 * worker, extractText() walks every page. The page count is reported back as
 * an honest note so a person knows how much of a multi-page document was read.
 *
 * PAGES ARE JOINED WITH A BLANK LINE, AND THAT IS LOAD-BEARING for the
 * fallback reader. pdf.js emits a newline only where the PDF's own text run
 * says so, so an extracted page usually contains not one blank line, and the
 * deterministic reader (record-import.ts groupBlocks) splits on blank lines
 * only: merged pages collapse an entire resume into one giant block that
 * reads as nothing. A blank line at each page boundary at least hands the
 * reader one block per page. The LLM path does not care either way; this is
 * for the fallback that runs when it fails.
 */
async function extractPdf(file: File): Promise<ResumeExtraction> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { text, totalPages } = await extractText(pdf, { mergePages: false });
    const merged = (Array.isArray(text) ? text : [text]).join('\n\n');
    const notes = [`Read ${totalPages} page${totalPages === 1 ? '' : 's'} of PDF text.`];
    return { ok: true, text: merged, notes };
  } catch {
    return { ok: false, message: UNREADABLE_MESSAGE };
  }
}

/* -------------------------------------------------------------------------
   The entry point.
   ------------------------------------------------------------------------- */

/**
 * Turns one uploaded File into text, or returns a failure a person can act on.
 * Never throws: every reader above catches its own library's errors, and the
 * guards here (size, empty, unknown type, empty result) all return a result
 * object rather than raising. Dispatch is by file extension first and MIME
 * type second, because a name a person can see ("resume.pdf") is a stronger
 * signal of intent than a browser-supplied type that can be missing or wrong,
 * and only falls back to the type when the extension is one this file does not
 * recognise.
 */
export async function extractResumeText(file: File): Promise<ResumeExtraction> {
  // Empty before large: a zero-byte upload is a different, clearer failure
  // than an oversized one, and checking size 0 first means the size-cap
  // message is only ever shown to a file that genuinely has too many bytes.
  if (file.size === 0) {
    return { ok: false, message: 'This file is empty. There is nothing to read.' };
  }
  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      message: 'This file is larger than 4 MB. Please upload a smaller file, or paste the text directly.'
    };
  }

  const extension = extensionOf(file.name);
  const type = file.type.toLowerCase();

  // .doc is caught by name before any reader runs: mammoth reads only .docx,
  // and a person handed a "could not be read" message for a .doc would have no
  // idea the real fix is to re-export. Naming the format and the fix is the
  // honest failure here.
  if (extension === 'doc' || type === 'application/msword') {
    return {
      ok: false,
      message:
        'Old Word .doc files are not supported. Open it in Word and export as .docx or PDF, then upload that.'
    };
  }

  // Markdown and plain text, by extension first.
  if (extension === 'md' || extension === 'markdown') {
    const text = stripMarkdown(await file.text());
    return finishText({ ok: true, text, notes: [] });
  }
  if (extension === 'txt') {
    return finishText({ ok: true, text: await file.text(), notes: [] });
  }

  // DOCX and PDF, by extension.
  if (extension === 'docx') {
    return finishText(await extractDocx(file));
  }
  if (extension === 'pdf') {
    return finishText(await extractPdf(file));
  }

  // The extension was unknown (or absent). Fall back to the MIME type, which
  // covers an upload whose name lost its extension somewhere but whose type
  // the browser still set.
  if (type === 'text/markdown') {
    const text = stripMarkdown(await file.text());
    return finishText({ ok: true, text, notes: [] });
  }
  if (type === 'text/plain') {
    return finishText({ ok: true, text: await file.text(), notes: [] });
  }
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return finishText(await extractDocx(file));
  }
  if (type === 'application/pdf') {
    return finishText(await extractPdf(file));
  }

  // Neither the extension nor the type named a format this file reads. The
  // message says what IS read rather than what was rejected, so a person knows
  // what to upload instead.
  return {
    ok: false,
    message: `This file type is not supported. Upload one of: ${SUPPORTED_TYPES}.`
  };
}

/**
 * The single place the "did we actually get text" judgment is made, so every
 * successful reader answers to one rule. A reader that already failed passes
 * straight through. A reader that succeeded mechanically but produced only
 * whitespace (a scanned image PDF, a .docx with no paragraphs) is turned into
 * the no-text failure here rather than at four separate call sites: extraction
 * that reads nothing is not a success, and must never send an empty string
 * downstream to be reported as "we read your file". The original text is
 * returned unchanged on success; the trim only decides emptiness, it does not
 * clean the text (record-import.ts wants the line shapes exactly as they are).
 */
function finishText(result: ResumeExtraction): ResumeExtraction {
  if (!result.ok) return result;
  if (result.text.trim() === '') {
    return { ok: false, message: NO_TEXT_MESSAGE };
  }
  return result;
}
