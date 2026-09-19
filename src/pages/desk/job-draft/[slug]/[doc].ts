/**
 * GET /desk/job-draft/[slug]/[doc]: download the drafted resume or cover letter
 * for one posting (RUN-DRAFT.md phase 4). doc is 'resume' or 'cover'; the
 * optional ?format= is 'pdf' (the default) or 'docx'.
 *
 * The file is generated from the render already stored for this (person,
 * posting) by src/lib's vanilla writers: src/lib/pdf-resume.ts for the PDF,
 * src/lib/docx-resume.ts for the .docx. Both draw from the SAME styled line
 * list (docx-resume.ts delegates its lines to pdf-resume.ts), so a person's
 * .pdf and .docx of one document say the same thing: single column, standard
 * headings, the contact block in the body, black text. Each names the person as
 * author and nothing it is not entitled to claim. Neither depends on the theme
 * the reader was viewing in.
 *
 * OWNER SCOPED, THE SAME RULE THE RESULT PAGE STATES. A signed-out request, an
 * unknown slug, a doc that is neither resume nor cover, and a draft that has not
 * finished all get the plain 404 below; the render is read scoped to the
 * viewer's own id, so a slug alone never builds a PDF from a stranger's record.
 * '/desk' is a gated prefix, so middleware walls a signed-in non-member first.
 */
import type { APIContext } from 'astro';
import { draftableJobBySlug } from '../../../../lib/draft-job';
import { getJobRenders } from '../../../../lib/generated-render-store';
import {
  buildResumePdf,
  buildCoverPdf,
  coverHasBody,
  resumeHasBody,
  RESUME_PDF_PRODUCER
} from '../../../../lib/pdf-resume';
import { buildResumeDocx, buildCoverDocx } from '../../../../lib/docx-resume';
import type { ResumeRender, CoverRender } from '../../../../lib/tailor';
import { personName } from '../../../../lib/record-store';
import { attachmentDisposition, draftDocFilename } from '../../../../lib/draft-filename';

/** The Word MIME type, the OpenXML wordprocessing document media type. Named
    once here so the response header is not a magic string. */
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const prerender = false;

function notFound(): Response {
  return new Response('Not found.', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

export async function GET(context: APIContext): Promise<Response> {
  const viewer = context.locals.viewer;
  if (!viewer) return notFound();

  const slug = context.params.slug ?? '';
  const doc = context.params.doc ?? '';
  if (doc !== 'resume' && doc !== 'cover') return notFound();

  const job = slug ? await draftableJobBySlug(slug, viewer.userId) : null;
  if (!job) return notFound();

  const { resume, cover } = await getJobRenders(viewer.userId, slug);
  const row = doc === 'resume' ? resume : cover;
  // Not started, or still drafting: nothing to download yet. The result page is
  // where a reader waits; a bare 404 here is the honest "no file" answer.
  if (!row || row.status === 'pending' || row.payload == null) return notFound();

  const render = row.payload as ResumeRender | CoverRender;

  // A settled render can still have nothing to draw: an empty record yields a
  // resume with no sections, and a record of roles with empty descriptions
  // yields a cover with no bullets (see coverHasBody). Both are non-null and
  // pass the status guard above, so without this a blank one-page PDF would
  // download. Refused the same honest "no file" way, with the reason on the
  // result page's gap note, not in a blank document.
  const hasBody =
    doc === 'resume' ? resumeHasBody(render as ResumeRender) : coverHasBody(render as CoverRender);
  if (!hasBody) return notFound();

  // The format: 'docx' when explicitly asked, PDF otherwise. Any other value
  // (a typo, a missing param) falls through to the PDF, the long-standing
  // default, so an old link with no ?format= downloads exactly as before.
  const format = context.url.searchParams.get('format') === 'docx' ? 'docx' : 'pdf';

  const author = render.header?.name ?? null;

  let bytes: Uint8Array;
  if (format === 'docx') {
    // The .docx writer derives its author from the render header itself (the
    // same source as below), so it takes no meta argument; it reads no clock,
    // producing the same bytes for the same render (see docx.ts).
    bytes =
      doc === 'resume' ? buildResumeDocx(render as ResumeRender) : buildCoverDocx(render as CoverRender);
  } else {
    const meta = { author, producer: RESUME_PDF_PRODUCER, created: new Date() };
    bytes =
      doc === 'resume' ? buildResumePdf(render as ResumeRender, meta) : buildCoverPdf(render as CoverRender, meta);
  }

  // The file is named for the person and the company, not for this site's
  // slug (src/lib/draft-filename.ts), with the format's extension. The
  // profile's names first; a profile that cannot be read is a plainer
  // filename, never a failed download.
  let names: { firstName: string; lastName: string } | null = null;
  try {
    names = await personName(viewer.userId);
  } catch (error) {
    console.error(`desk/job-draft/${slug}/${doc}: could not read the person's name for the filename.`, error);
  }
  const filename = draftDocFilename(
    {
      firstName: names?.firstName,
      lastName: names?.lastName,
      fallbackName: author,
      doc,
      company: job.company
    },
    format
  );
  // A Uint8Array is a valid response body at runtime; the cast is only for the
  // BodyInit type, which does not name Uint8Array in this lib version.
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': format === 'docx' ? DOCX_CONTENT_TYPE : 'application/pdf',
      'Content-Disposition': attachmentDisposition(filename),
      // A drafted document is per-person and per-request; never cache it at a
      // shared edge.
      'Cache-Control': 'private, no-store'
    }
  });
}
