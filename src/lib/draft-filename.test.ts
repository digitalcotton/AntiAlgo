import { describe, expect, it } from 'vitest';
import { attachmentDisposition, draftPdfFilename } from './draft-filename';

describe('draftPdfFilename', () => {
  it('names the person, the document, and the company', () => {
    expect(draftPdfFilename({ firstName: 'Ryan', lastName: 'Payne', doc: 'resume', company: 'Brex' })).toBe('Ryan Payne resume for Brex.pdf');
    expect(draftPdfFilename({ firstName: 'Ryan', lastName: 'Payne', doc: 'cover', company: 'Brex' })).toBe('Ryan Payne cover letter for Brex.pdf');
  });
  it('falls back to the render header name, then to the plain document name', () => {
    expect(draftPdfFilename({ firstName: '', lastName: '', fallbackName: 'R. Payne', doc: 'resume', company: 'Acme' })).toBe('R. Payne resume for Acme.pdf');
    expect(draftPdfFilename({ doc: 'cover', company: null })).toBe('Cover letter.pdf');
    expect(draftPdfFilename({ firstName: 'Ryan', doc: 'resume', company: null })).toBe('Ryan resume.pdf');
  });
  it('strips what a filesystem refuses and squashes whitespace', () => {
    expect(draftPdfFilename({ firstName: ' Ryan ', lastName: 'Pa/yne', doc: 'resume', company: 'Acme: "Labs" <Inc>' })).toBe('Ryan Payne resume for Acme Labs Inc.pdf');
  });
  it('caps a runaway company name', () => {
    const name = draftPdfFilename({ firstName: 'A', lastName: 'B', doc: 'resume', company: 'x'.repeat(500) });
    expect(name.length).toBeLessThan(120);
  });
});

describe('attachmentDisposition', () => {
  it('carries an ASCII name and the encoded name', () => {
    expect(attachmentDisposition('Ryan Payne resume for Brex.pdf')).toBe(
      "attachment; filename=\"Ryan Payne resume for Brex.pdf\"; filename*=UTF-8''Ryan%20Payne%20resume%20for%20Brex.pdf"
    );
    expect(attachmentDisposition('Zoë resume.pdf')).toContain('filename="Zo_ resume.pdf"');
    expect(attachmentDisposition('Zoë resume.pdf')).toContain("filename*=UTF-8''Zo%C3%AB%20resume.pdf");
  });
});
