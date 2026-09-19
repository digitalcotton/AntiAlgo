/**
 * docx.ts: a small, dependency-free .docx writer for the drafted resume and
 * cover letter, the exact sibling of pdf.ts (RUN-DRAFT.md phase 4). pdf.ts
 * hand-writes PDF bytes rather than pull in pdfkit; this file hand-writes the
 * OPC ZIP and the WordprocessingML XML rather than pull in docx or officegen,
 * for the same reason and under the same rule.
 *
 * WHY VANILLA, AND WHAT THAT BUYS. The constraints canon forbids a new runtime
 * dependency (MASTER-SPEC 1.4, RUN-MASTER section 3: "implement the vanilla
 * alternative instead"), which is why pdf.ts exists at all. A .docx is nothing
 * but a ZIP of XML text parts, and Node ships everything needed to emit one
 * (the ZIP container is a handful of fixed-layout records; the XML is strings).
 * So no package is added: this file is to Word what pdf.ts is to PDF. And, as
 * with the PDF, writing every byte here lets the parse-proof property be a
 * property of the template, proved once, rather than something linted on a
 * user's export every time (F29's argument, carried over): a single unbroken
 * <w:t> run per core field is what an ATS recovers whole.
 *
 * THE ZIP: STORE (UNCOMPRESSED), NOT DEFLATE, AND WHY. A ZIP entry may be
 * stored raw (method 0) or DEFLATE-compressed (method 8); both are spec-valid
 * and Word reads either. Node's zlib could DEFLATE (zlib.deflateRawSync) and
 * even compute the CRC (zlib.crc32, Node >=22.2, and engines pins 24.x), so
 * "no new dependency" is satisfied either way. This file STORES, for two
 * reasons that both come straight from the ethos the rest of this codebase is
 * written in:
 *   1. DETERMINISM. pdf.ts's header promises "the same lines and meta always
 *      produce the same bytes", and tailor.ts promises "byte-identical JSON";
 *      purity is the house value the gates lean on. zlib's DEFLATE output is
 *      NOT guaranteed stable across zlib/Node versions (the compressor is free
 *      to pick different-but-valid encodings), so a DEFLATE .docx would be a
 *      function of the zlib build, not only of its inputs. A STORED entry is
 *      the input bytes verbatim, so buildDocx() stays a pure function of
 *      (lines, meta) forever.
 *   2. TRANSPARENCY. Because the part is stored raw, `unzip -p file.docx
 *      word/document.xml` returns exactly the bytes this file wrote. The
 *      parse-proof property (each core field a recoverable unbroken run) is
 *      inspectable in the container itself, the same way pdf.ts's content
 *      stream is readable in the PDF. That is worth more here than the few
 *      kilobytes DEFLATE would save on a two-page document.
 * The CRC-32 each entry still needs is hand-rolled below (a standard table,
 * ~10 lines), so this file depends on nothing at all, not even zlib, which is
 * the most faithful mirror of pdf.ts's "write every operator yourself".
 *
 * PLAIN PARAGRAPHS ONLY, BY CONSTRUCTION. Every line becomes one <w:p> with one
 * <w:r>. There is no code path in this file that can emit a <w:tbl>, a column
 * set, a text box, or an image: a multi-column or table layout is the single
 * biggest reason a resume fails an ATS parser (RESUME-RULES.md, "single column,
 * top to bottom"), so the writer simply has no vocabulary for one. Single font,
 * single column, black text, real text only, no hidden runs, the same
 * guarantees pdf.ts makes about its output.
 */

/* -------------------------------------------------------------------------
   CRC-32 (ISO 3309 / the ZIP polynomial 0xEDB88320), table-driven. The ZIP
   central and local headers each carry the CRC of the entry's uncompressed
   bytes; a reader refuses an entry whose bytes do not match. Hand-rolled so
   this file needs nothing imported, mirroring pdf.ts writing its own text
   operators. (Node's zlib.crc32 would return the same value; see the file
   header on why zlib is not used here at all.)
   ------------------------------------------------------------------------- */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------------
   The line model, byte-for-byte the shape pdf.ts's StyledLine carries, so
   docx-resume.ts can hand this writer the very same line list pdf-resume.ts
   hands the PDF writer, and the two documents can never say different things.
   ------------------------------------------------------------------------- */

export interface DocxLine {
  readonly text: string;
  /** Point size. Word stores sizes in half-points, so this is doubled below. */
  readonly size: number;
  /** Bold run instead of regular. */
  readonly bold?: boolean;
  /** Extra space, in points, above this line (section breaks). Word measures
      paragraph spacing in twips (1/20 pt), so this is multiplied by 20 below. */
  readonly spaceBefore?: number;
}

export interface DocxMeta {
  /** The document title, written into docProps/core.xml (dc:title). */
  readonly title: string;
  /** The person, as author, written into docProps/core.xml (dc:creator). The
      truthful counterpart of the PDF's /Author. Omitted when the record has no
      name, exactly as pdf.ts omits /Author then. */
  readonly author?: string;
}

/* -------------------------------------------------------------------------
   XML escaping. WordprocessingML is XML, so the five predefined entities must
   be escaped in any text or attribute value. Control characters that XML 1.0
   forbids entirely (everything below 0x20 except tab, newline, carriage
   return) are dropped rather than escaped: they cannot legally appear, and a
   resume line has no business carrying one. "Real text only" (the file header)
   is enforced here, not assumed.
   ------------------------------------------------------------------------- */

function escapeXml(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) continue;
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&apos;';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------
   The five WordprocessingML parts (plus docProps/core.xml for the author).
   US Letter with one-inch margins, in twips (1 inch = 1440 twips), the same
   page and margins pdf.ts uses (612x792pt, 72pt margins). Single font (Arial:
   Helvetica, which pdf.ts draws with, is a base-14 PDF font but is not shipped
   on Windows, and Arial is its standard metric-compatible substitute and the
   ATS-safe default), single column, black text.
   ------------------------------------------------------------------------- */

// US Letter, in twips.
const PAGE_WIDTH_TWIPS = 12240;
const PAGE_HEIGHT_TWIPS = 15840;
const MARGIN_TWIPS = 1440;

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** One <w:p> for one line: an optional spacing-before, then a single run whose
    rPr carries bold and the half-point size, then the text. xml:space is
    preserved so leading or trailing spaces in a line (the "   " joins
    pdf-resume.ts uses between contact bits and meta segments) survive intact. */
function paragraphXml(line: DocxLine): string {
  const halfPoints = Math.round(line.size * 2);
  const pPr =
    line.spaceBefore && line.spaceBefore > 0
      ? `<w:pPr><w:spacing w:before="${Math.round(line.spaceBefore * 20)}" w:after="0"/></w:pPr>`
      : '<w:pPr><w:spacing w:after="0"/></w:pPr>';
  const boldTag = line.bold ? '<w:b/>' : '';
  const rPr = `<w:rPr>${boldTag}<w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/></w:rPr>`;
  const text = `<w:t xml:space="preserve">${escapeXml(line.text)}</w:t>`;
  return `<w:p>${pPr}<w:r>${rPr}${text}</w:r></w:p>`;
}

function documentXml(lines: readonly DocxLine[]): string {
  const body = lines.map(paragraphXml).join('');
  // The single section: US Letter, one-inch margins, one column. This is the
  // only place a page shape is declared, and it declares exactly one column,
  // so the document is single-column by construction.
  const sectPr =
    `<w:sectPr>` +
    `<w:pgSz w:w="${PAGE_WIDTH_TWIPS}" w:h="${PAGE_HEIGHT_TWIPS}"/>` +
    `<w:pgMar w:top="${MARGIN_TWIPS}" w:right="${MARGIN_TWIPS}" w:bottom="${MARGIN_TWIPS}" w:left="${MARGIN_TWIPS}" w:header="0" w:footer="0" w:gutter="0"/>` +
    `<w:cols w:space="0"/>` +
    `</w:sectPr>`;
  return (
    XML_DECL +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}${sectPr}</w:body>` +
    '</w:document>'
  );
}

/** Document defaults only: one font, a base size, no styled paragraph styles a
    line would have to name. Every line already carries its own w:sz, so this
    just fixes the family and colour once for the whole document. */
const STYLES_XML =
  XML_DECL +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>' +
  '<w:color w:val="000000"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
  '</w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '</w:styles>';

const CONTENT_TYPES_XML =
  XML_DECL +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '</Types>';

const ROOT_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '</Relationships>';

const DOCUMENT_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

/** docProps/core.xml: the author and the title, the truthful counterpart of
    pdf.ts's Info dictionary. Deliberately carries NO creation timestamp: pdf.ts
    takes its date as a pure meta input so the output stays a function of its
    inputs, and this writer keeps buildDocx() pure the simpler way, by writing
    no clock-derived value at all. */
function corePropsXml(meta: DocxMeta): string {
  const creator = meta.author ? `<dc:creator>${escapeXml(meta.author)}</dc:creator>` : '';
  return (
    XML_DECL +
    '<cp:coreProperties ' +
    'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${escapeXml(meta.title)}</dc:title>` +
    creator +
    '</cp:coreProperties>'
  );
}

/* -------------------------------------------------------------------------
   The ZIP container. Little-endian fixed-layout records, written by hand. Each
   part becomes one STORED entry (method 0): a local header + the raw bytes,
   then a matching central-directory header, then one end-of-central-directory
   record. [Content_Types].xml is written first because OPC requires it be the
   archive's first part.
   ------------------------------------------------------------------------- */

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

interface ZipPart {
  readonly name: string;
  readonly data: Buffer;
}

// A fixed DOS date of 1980-01-01 and time 00:00:00. A real timestamp would make
// the bytes depend on a clock; a zero date field is technically out of range
// (DOS day and month start at 1), so the earliest legal value is used instead,
// keeping the archive both valid and deterministic.
const DOS_DATE = 0x0021; // 1980-01-01
const DOS_TIME = 0x0000; // 00:00:00

function zip(parts: readonly ZipPart[]): Uint8Array {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  let count = 0;

  for (const part of parts) {
    const nameBuf = Buffer.from(part.name, 'utf8');
    const crc = crc32(part.data);
    const size = part.data.length;

    const localHeader = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed to extract (2.0)
      u16(0), // general-purpose bit flag
      u16(0), // compression method: 0 = stored
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(size), // compressed size == uncompressed size for a stored entry
      u32(size), // uncompressed size
      u16(nameBuf.length),
      u16(0) // extra field length
    ]);
    localChunks.push(localHeader, nameBuf, part.data);

    const centralHeader = Buffer.concat([
      u32(0x02014b50), // central directory header signature
      u16(20), // version made by
      u16(20), // version needed to extract
      u16(0), // general-purpose bit flag
      u16(0), // compression method
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBuf.length),
      u16(0), // extra field length
      u16(0), // file comment length
      u16(0), // disk number start
      u16(0), // internal file attributes
      u32(0), // external file attributes
      u32(offset), // relative offset of local header
      nameBuf
    ]);
    centralChunks.push(centralHeader);

    offset += localHeader.length + nameBuf.length + part.data.length;
    count += 1;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const endRecord = Buffer.concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // number of this disk
    u16(0), // disk where central directory starts
    u16(count), // number of central directory records on this disk
    u16(count), // total number of central directory records
    u32(centralDirectory.length), // size of central directory
    u32(offset), // offset of start of central directory
    u16(0) // comment length
  ]);

  return Buffer.concat([...localChunks, centralDirectory, endRecord]);
}

/**
 * Build the .docx for one document from its styled lines. Pure: the same lines
 * and meta always produce the same bytes (no clock is read; the archive dates
 * are fixed constants), the counterpart of buildPdf()'s determinism guarantee.
 */
export function buildDocx(lines: readonly DocxLine[], meta: DocxMeta): Uint8Array {
  // A document with no lines is a blank page, and a blank page is never a valid
  // download. Callers decide, before they reach this, whether a render has a
  // body worth building (resumeHasBody/coverHasBody, reused by docx-resume.ts);
  // this is the belt-and-suspenders floor under that decision, exactly as
  // buildPdf() refuses an empty line list.
  if (lines.length === 0) {
    throw new Error('buildDocx: refusing to build a document with no lines.');
  }

  const parts: ZipPart[] = [
    // [Content_Types].xml MUST be first (OPC requirement).
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS_XML, 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(corePropsXml(meta), 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(lines), 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOCUMENT_RELS_XML, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') }
  ];

  return zip(parts);
}
