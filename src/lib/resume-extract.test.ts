import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractResumeText } from './resume-extract';

// resume-extract.ts is the byte-to-text front door for MASTER-SPEC F2's import
// boost: one uploaded File in, one clean string (or an honest failure) out,
// with record-import.ts waiting downstream to read that string. These tests
// prove every branch on REAL bytes, never a mock: the markdown stripper on an
// actual markdown paste, mammoth on a real .docx (a fixture the library ships),
// and unpdf on a real one-page PDF built byte by byte below. The guards (size
// cap, empty, unknown type, .doc) are proven too, because a front door that
// only works on the happy path is the failure this file exists to prevent.

/**
 * Builds a minimal but well-formed single-page PDF whose one line of content
 * shows `text`, with a correct cross-reference table so pdf.js reads it
 * without having to fall back to reindexing. Everything is ASCII, so a byte
 * offset equals a string index and the xref offsets are computed straight from
 * the running body length. This is enough structure for unpdf/pdf.js to find
 * and extract the text-showing operator, which is exactly what a real
 * text-layer resume PDF gives it, just smaller.
 */
function buildMinimalPdf(text: string): ArrayBuffer {
  const header = '%PDF-1.4\n';
  const stream = `BT\n/F1 24 Tf\n72 700 Td\n(${text}) Tj\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ];

  let body = header;
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  // Return a real ArrayBuffer (a valid BlobPart the File constructor accepts
  // directly), filled a byte at a time. Every character is latin1, so a code
  // unit is a byte.
  const pdf = body + xref + trailer;
  const out = new ArrayBuffer(pdf.length);
  const view = new Uint8Array(out);
  for (let i = 0; i < pdf.length; i++) view[i] = pdf.charCodeAt(i);
  return out;
}

describe('extractResumeText(): markdown', () => {
  const markdown = [
    '# Senior Product Designer',
    '',
    '## Experience',
    '',
    '- Led the design system rebuild',
    '* Shipped the **checkout** redesign',
    '+ Owned `onboarding` end to end',
    '',
    '> A pull quote from a review'
  ].join('\n');

  it('strips the markup but keeps every word', async () => {
    const file = new File([markdown], 'resume.md', { type: 'text/markdown' });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No markup survives.
    expect(result.text).not.toContain('#');
    expect(result.text).not.toContain('>');
    expect(result.text).not.toContain('*');
    expect(result.text).not.toContain('`');

    // Every word survives, and the emphasis words are unwrapped, not deleted.
    expect(result.text).toContain('Senior Product Designer');
    expect(result.text).toContain('Experience');
    expect(result.text).toContain('Led the design system rebuild');
    expect(result.text).toContain('Shipped the checkout redesign');
    expect(result.text).toContain('Owned onboarding end to end');
    expect(result.text).toContain('A pull quote from a review');
  });

  it('keeps line breaks intact so the downstream parser still sees line shapes', async () => {
    const file = new File([markdown], 'resume.md', { type: 'text/markdown' });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The title sits alone on the first line, with the markup gone.
    expect(result.text.split('\n')[0]).toBe('Senior Product Designer');
  });
});

describe('extractResumeText(): plain text', () => {
  it('round-trips a .txt file unchanged', async () => {
    const body = 'Ada Lovelace\nAnalytical Engine Programmer\n1842 - 1843';
    const file = new File([body], 'resume.txt', { type: 'text/plain' });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(body);
    expect(result.notes).toEqual([]);
  });
});

describe('extractResumeText(): guardrails', () => {
  it('rejects a file over 4 MB before reading it', async () => {
    // One byte past the cap. size is checked from the File's own byte count,
    // so this never actually reads four megabytes of text.
    const big = 'a'.repeat(4 * 1024 * 1024 + 1);
    const file = new File([big], 'resume.txt', { type: 'text/plain' });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('4 MB');
  });

  it('rejects an empty (zero-byte) file', async () => {
    const file = new File([], 'resume.txt', { type: 'text/plain' });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('empty');
  });

  it('rejects an unknown extension and names what IS supported', async () => {
    const file = new File(['{\\rtf1 hello}'], 'resume.rtf', { type: 'application/rtf' });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('Markdown, plain text, PDF, or Word (.docx)');
  });

  it('rejects an old binary .doc by name and points at the fix', async () => {
    const file = new File(['anything'], 'resume.doc', { type: 'application/msword' });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('.docx');
  });
});

describe('extractResumeText(): DOCX (real bytes)', () => {
  it('extracts the text of a real .docx via mammoth', async () => {
    // mammoth ships this fixture; it decodes to "Walking on imported air".
    const fixture = resolve(
      process.cwd(),
      'node_modules/mammoth/test/test-data/single-paragraph.docx'
    );
    const bytes = readFileSync(fixture);
    const file = new File([bytes], 'resume.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('Walking on imported air');
  });

  it('fails cleanly, without throwing, on bytes that are not a real .docx', async () => {
    // A .docx is a zip; these bytes are not one, so mammoth throws internally
    // and the reader must turn that into a fixed failure sentence.
    const file = new File(['not a real docx at all'], 'resume.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('could not be read');
    // The failure must never echo the file's contents.
    expect(result.message).not.toContain('not a real docx');
  });
});

describe('extractResumeText(): PDF (real bytes)', () => {
  it('extracts the text of a real one-page PDF via unpdf', async () => {
    const known = 'Ada Lovelace Curriculum Vitae';
    const bytes = buildMinimalPdf(known);
    const file = new File([bytes], 'resume.pdf', { type: 'application/pdf' });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain(known);
    expect(result.notes.join(' ')).toContain('1 page');
  });

  it('dispatches on the application/pdf MIME type when the extension is missing', async () => {
    const known = 'Grace Hopper Compiler Pioneer';
    const bytes = buildMinimalPdf(known);
    // No extension on the name; only the type says PDF.
    const file = new File([bytes], 'resume', { type: 'application/pdf' });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain(known);
  });

  it('fails cleanly on bytes that are not a real PDF', async () => {
    const file = new File(['%PDF-but-not-really'], 'resume.pdf', { type: 'application/pdf' });
    const result = await extractResumeText(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('could not be read');
  });
});
