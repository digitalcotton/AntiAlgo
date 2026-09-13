/**
 * pdf.ts: a small, dependency-free PDF writer for the drafted resume and cover
 * letter (RUN-DRAFT.md phase 4, absorbing RUN-HARDEN F11).
 *
 * WHY VANILLA, AND WHAT THAT BUYS. The constraints canon forbids a new runtime
 * dependency (MASTER-SPEC 1.4, RUN-MASTER section 3: "implement the vanilla
 * alternative instead"), so this file emits the PDF bytes itself rather than
 * pulling in pdfkit or pdf-lib. That is not only a rule kept: a hand-written
 * single-column text PDF is exactly the shape the parsing vendors ask for
 * (RESUME-RULES.md, "single column, top to bottom"), and because this file
 * writes every text-showing operator itself, the parse-proof gate can prove the
 * template preserves the record's fields once, byte-for-byte, rather than
 * linting a user's export every time (F29's argument).
 *
 * THE ONE STANDARD FONT, AND ITS CHARACTER SET. Helvetica (a base-14 font every
 * reader ships, so nothing is embedded) with WinAnsiEncoding. A ToUnicode CMap
 * is written for the whole WinAnsi set, so a reader's text extractor maps each
 * byte back to the Unicode it came from, which is what makes "byte-intact"
 * true and not a coincidence of one extractor's font heuristics. WinAnsi covers
 * ASCII, the Latin-1 letters (accented names), and the CP1252 punctuation
 * (smart quotes, the dashes). A character outside that set cannot be drawn by a
 * standard font and is written as '?'; encodeWinAnsi() reports when it had to,
 * so a caller (the parse-proof gate) can assert a fixture stays inside the set
 * and a real export can note the substitution rather than pretend it did not
 * happen. Full Unicode needs an embedded subset font, which is a later,
 * supervised pass, not a vanilla one.
 *
 * NO HIDDEN TEXT, BY CONSTRUCTION. Every glyph is black (0 0 0 rg), at a
 * readable size, positioned inside the page's own media box, wrapped so no line
 * runs past the right margin. There is no white text, no off-page text, and no
 * second invisible layer: this file has no code path that could draw one, which
 * is the property F31's own gate checks for on the output.
 */

/* -------------------------------------------------------------------------
   WinAnsi (CP1252): the bytes a standard font draws, and the Unicode each
   maps back to. 0x00-0x7F is ASCII, 0xA0-0xFF is Latin-1, and the 0x80-0x9F
   band is CP1252's own punctuation. Built once as a byte-to-Unicode table;
   the reverse map turns a JS string into those bytes.
   ------------------------------------------------------------------------- */

const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178
};

function buildByteToUnicode(): Map<number, number> {
  const map = new Map<number, number>();
  for (let b = 0x00; b <= 0x7f; b++) map.set(b, b);
  for (let b = 0xa0; b <= 0xff; b++) map.set(b, b);
  for (const [b, u] of Object.entries(CP1252_HIGH)) map.set(Number(b), u);
  return map;
}

const BYTE_TO_UNICODE = buildByteToUnicode();
const UNICODE_TO_BYTE = new Map<number, number>([...BYTE_TO_UNICODE].map(([b, u]) => [u, b]));

const QUESTION_MARK = 0x3f;

/** One character (by code point) to its WinAnsi byte, or the '?' byte when the
    standard font cannot draw it. */
function byteFor(codePoint: number): number {
  return UNICODE_TO_BYTE.get(codePoint) ?? QUESTION_MARK;
}

/** Encode a string to WinAnsi bytes. `substituted` is true when any character
    fell outside the set and was written as '?', so a caller can tell a faithful
    line from a lossy one. */
export function encodeWinAnsi(text: string): { bytes: number[]; substituted: boolean } {
  const bytes: number[] = [];
  let substituted = false;
  // Compose first (NFC): a decomposed accent (an "e" plus a combining acute) is
  // two code points, and the combining mark is not in WinAnsi, so without this
  // an accented name would encode as "e?" rather than the single Latin-1 letter
  // the standard font can draw. NFC turns canonically-equivalent input into the
  // one code point WinAnsi holds, so the same accented character always encodes
  // and always draws, whichever way the record happened to store it.
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0) as number;
    const b = byteFor(cp);
    if (b === QUESTION_MARK && cp !== QUESTION_MARK) substituted = true;
    bytes.push(b);
  }
  return { bytes, substituted };
}

/* -------------------------------------------------------------------------
   Helvetica widths (1000-unit em), for wrapping so no line runs off the page.
   The printable ASCII values are Adobe's own AFM numbers; anything outside
   that (an accented letter, a smart quote) takes a conservative default that
   is at least as wide as the real glyph, so a wrapped line never underruns its
   true width and never overflows the right margin.
   ------------------------------------------------------------------------- */

const HELVETICA_ASCII_WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, '[': 278,
  '\\': 278, ']': 278, '^': 469, _: 556, '`': 333, a: 556, b: 556, c: 500, d: 556,
  e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556,
  o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500,
  y: 500, z: 500, '{': 334, '|': 260, '}': 334, '~': 584
};

const DEFAULT_WIDTH = 722;

function charWidth(ch: string): number {
  return HELVETICA_ASCII_WIDTHS[ch] ?? DEFAULT_WIDTH;
}

function textWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) units += charWidth(ch);
  return (units / 1000) * fontSize;
}

/* -------------------------------------------------------------------------
   Layout: a flat list of styled lines is all this writer draws. A caller
   (pdf-resume.ts's builders) turns a render into these; this file wraps each
   to the usable width and stacks them down the page, breaking to a new page
   when the bottom margin is reached.
   ------------------------------------------------------------------------- */

export interface StyledLine {
  readonly text: string;
  /** Point size. */
  readonly size: number;
  /** Helvetica-Bold instead of Helvetica. */
  readonly bold?: boolean;
  /** Extra space, in points, above this line (section breaks). */
  readonly spaceBefore?: number;
}

export interface PdfMeta {
  /** The person, as author. null when the record has no name. */
  readonly author: string | null;
  /** The renderer that produced the file. */
  readonly producer: string;
  /** The real creation time. Passed in, never read from a clock here, so the
      output is a pure function of its inputs (the parse-proof gate needs that). */
  readonly created: Date;
}

// US Letter, 72pt (one inch) margins.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 72;
const MARGIN_TOP = 720;
const MARGIN_BOTTOM = 72;
const USABLE_WIDTH = PAGE_WIDTH - 2 * MARGIN_X;

/** Wrap one styled line to the usable width, on spaces, never mid-word unless a
    single word is itself wider than the page (then it is broken by character so
    it still cannot run off the margin). */
function wrap(line: StyledLine): string[] {
  if (textWidth(line.text, line.size) <= USABLE_WIDTH) return [line.text];
  const words = line.text.split(' ');
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (textWidth(candidate, line.size) <= USABLE_WIDTH) {
      current = candidate;
      continue;
    }
    if (current !== '') out.push(current);
    if (textWidth(word, line.size) <= USABLE_WIDTH) {
      current = word;
    } else {
      // A single over-wide word: break it by character so nothing overflows.
      let piece = '';
      for (const ch of word) {
        if (textWidth(piece + ch, line.size) <= USABLE_WIDTH) {
          piece += ch;
        } else {
          if (piece !== '') out.push(piece);
          piece = ch;
        }
      }
      current = piece;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

/* -------------------------------------------------------------------------
   PDF emission. Latin1 bytes throughout (the content stream and the strings
   are WinAnsi, which is a superset of Latin1 for the codes we emit), so a byte
   offset equals a string index and the xref is computed from running lengths.
   ------------------------------------------------------------------------- */

/** Escape the three characters a PDF literal string treats specially. Operates
    on already-WinAnsi bytes rendered back to a latin1 string. */
function pdfEscape(latin1: string): string {
  return latin1.replace(/[\\()]/g, (m) => `\\${m}`);
}

/** A WinAnsi byte array as a latin1 string, for embedding in the content
    stream (where each byte is one character 0x00-0xFF). */
function bytesToLatin1(bytes: number[]): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function pdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** The ToUnicode CMap: every WinAnsi byte to its Unicode, so extraction is
    exact. One bfchar entry per defined code. */
function toUnicodeCMap(): string {
  const entries = [...BYTE_TO_UNICODE.entries()].sort((a, b) => a[0] - b[0]);
  const lines = entries
    .map(([b, u]) => `<${b.toString(16).padStart(2, '0')}> <${u.toString(16).padStart(4, '0')}>`)
    .join('\n');
  return (
    '/CIDInit /ProcSet findresource begin\n' +
    '12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<00> <ff>\nendcodespacerange\n' +
    `${entries.length} beginbfchar\n${lines}\nendbfchar\n` +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend'
  );
}

/**
 * Build the PDF for one document from its styled lines. Pure: the same lines
 * and meta always produce the same bytes (pdfDate reads meta.created, never a
 * clock), which the parse-proof gate relies on.
 */
export function buildPdf(lines: readonly StyledLine[], meta: PdfMeta): Uint8Array {
  // A document with no lines is a blank page, and a blank page is never a valid
  // download. Callers decide, before they reach this, whether a render has a
  // body worth building (resumeHasBody/coverHasBody in pdf-resume.ts); this is
  // the belt-and-suspenders floor under that decision, so no path can ever emit
  // a one-page PDF of nothing without saying so.
  if (lines.length === 0) {
    throw new Error('buildPdf: refusing to build a PDF with no lines.');
  }

  // 1. Flow the lines into pages, wrapping each and breaking on the bottom
  //    margin. Each drawn line records its page, its baseline y, and its bytes.
  interface Drawn {
    readonly page: number;
    readonly y: number;
    readonly size: number;
    readonly bold: boolean;
    readonly latin1: string;
  }
  const drawn: Drawn[] = [];
  let page = 0;
  let y = MARGIN_TOP;
  let substituted = false;

  for (const line of lines) {
    if (line.spaceBefore) y -= line.spaceBefore;
    const wrapped = wrap(line);
    const leading = line.size * 1.35;
    for (const piece of wrapped) {
      if (y < MARGIN_BOTTOM) {
        page += 1;
        y = MARGIN_TOP;
      }
      const enc = encodeWinAnsi(piece);
      if (enc.substituted) substituted = true;
      drawn.push({ page, y, size: line.size, bold: !!line.bold, latin1: bytesToLatin1(enc.bytes) });
      y -= leading;
    }
  }
  const pageCount = page + 1;

  // 2. One content stream per page. Each line: black fill, font, size, moved to
  //    an absolute position with Tm, shown with Tj. Positions are always inside
  //    the media box (x = MARGIN_X, wrap keeps the right edge in; y between the
  //    two margins), so nothing is ever off-page.
  const streams: string[] = [];
  for (let p = 0; p < pageCount; p++) {
    let content = '0 0 0 rg\nBT\n';
    for (const d of drawn) {
      if (d.page !== p) continue;
      const font = d.bold ? '/FB' : '/FR';
      content += `${font} ${d.size} Tf\n1 0 0 1 ${MARGIN_X} ${d.y.toFixed(2)} Tm\n(${pdfEscape(d.latin1)}) Tj\n`;
    }
    content += 'ET';
    streams.push(content);
  }

  // 3. Objects. Fixed low objects, then one Page and one Contents per page.
  //    Object numbering: 1 Catalog, 2 Pages, 3 Font Regular, 4 Font Bold,
  //    5 ToUnicode, 6 Info; then pages and contents interleaved from 7.
  const cmap = toUnicodeCMap();
  const fontResources = '/Font << /FR 3 0 R /FB 4 0 R >>';

  const pageObjNums: number[] = [];
  const contentObjNums: number[] = [];
  let next = 7;
  for (let p = 0; p < pageCount; p++) {
    pageObjNums.push(next++);
    contentObjNums.push(next++);
  }

  const authorLine = meta.author ? `/Author (${pdfEscape(bytesToLatin1(encodeWinAnsi(meta.author).bytes))})` : '';
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >>`,
    `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
    // Info: exactly the three facts RUN-DRAFT names, and nothing else. The
    // person as author, this renderer as producer, the real date. No /Title, no
    // /Creator, no app version, nothing that would be a claim this file is not
    // entitled to make. The parse-proof gate asserts this dictionary carries no
    // fourth key.
    `<< ${authorLine} /Producer (${pdfEscape(meta.producer)}) /CreationDate (${pdfDate(meta.created)}) >>`
  ];
  for (let p = 0; p < pageCount; p++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << ${fontResources} >> /Contents ${contentObjNums[p]} 0 R >>`
    );
    objects.push(`<< /Length ${streams[p].length} >>\nstream\n${streams[p]}\nendstream`);
  }

  // 4. Serialize with a correct xref table.
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  const pdf = body + xref + trailer;
  const out = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) out[i] = pdf.charCodeAt(i) & 0xff;
  // `substituted` is not thrown on: a real export with an unrepresentable
  // character still produces a file. The parse-proof gate asserts its own
  // fixtures never substitute; a caller that wants to warn a person can call
  // encodeWinAnsi() itself. Kept as a computed local so the intent is on record.
  void substituted;
  return out;
}
