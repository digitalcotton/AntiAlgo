import type { APIRoute, GetStaticPaths } from 'astro';
import {
  ABSENCE,
  ageOf,
  formatDate,
  formatDays,
  loadJobs,
  markStateOf,
  sourceLabel,
  sweptStamp,
  type Job
} from '../../lib/data';
import { statusStamp } from '../../components/job-detail/detail';
import {
  CARD,
  CARD_DEFS,
  CARD_GROUND,
  CARD_WORDMARK,
  CONTENT_WIDTH,
  PAD,
  PALETTE,
  cardFoot,
  esc,
  svgResponse,
  wrap
} from '../../lib/og-card';

/**
 * The share card for one posting, at /jobs/<slug>.og.svg.
 *
 * The frame, the palette, the embedded faces and the wrapper are shared with
 * the site card and the kill card in src/lib/og-card.ts, which is also where
 * the reasoning behind an SVG rather than a PNG is written down. What is here
 * is what makes this card this card: the verification stamp, the posting's own
 * facts as posted, and the fit score.
 */

export const getStaticPaths = (() =>
  loadJobs().map((job) => ({ params: { slug: job.slug }, props: { job } }))) satisfies GetStaticPaths;

const TITLE_SIZE = 54;
const TITLE_LEADING = 64;
const TITLE_MAX_LINES = 3;

/**
 * The verification mark, drawn on the same 48 unit grid as Mark.astro.
 *
 * A nested svg with its own viewBox rather than re-derived circles and squares.
 * Scaling the numbers by hand produced a mark whose square filled its ring, and
 * the closed state came out solid when the legend says it is hollow. Reusing
 * the grid means the glyph on a share card and the glyph in a table row are the
 * same drawing at two sizes, which is what a mark family has to be.
 *
 * The re-verified knockout is drawn against the card's own raised surface, the
 * one thing that is genuinely different here: the notch is a punch-out, so it
 * has to be filled with what is actually behind it.
 */
function mark(job: Job): string {
  const state = markStateOf(job);
  const stroke = state === 'closed' ? PALETTE.markClosed : PALETTE.markLive;
  const core =
    state === 'closed'
      ? `<rect x="17" y="17" width="14" height="14" fill="none" stroke="${stroke}" stroke-width="4"/>`
      : `<rect x="16" y="16" width="16" height="16" fill="${stroke}"/>`;
  const notch =
    state === 're-verified'
      ? `<circle cx="24" cy="4" r="6" fill="${PALETTE.raised}" stroke="${stroke}" stroke-width="4"/>`
      : '';
  return `<svg x="0" y="-18" width="24" height="24" viewBox="0 0 48 48"><circle cx="24" cy="24" r="19" fill="none" stroke="${stroke}" stroke-width="5"/>${core}${notch}</svg>`;
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function render(job: Job): string {
  const isClosed = job.status === 'closed';
  const markColor = isClosed ? PALETTE.markClosed : PALETTE.markLive;
  const age = ageOf(job);

  // A role card exists only for a posted row, so the title is always there. The
  // fallback is the company rather than a placeholder, because a card with no
  // headline at all is worse than one headed by the name that is certain.
  const titleLines = wrap(job.title ?? job.company, TITLE_SIZE, CONTENT_WIDTH, TITLE_MAX_LINES);
  const titleTop = 250;

  const facts = [
    job.comp_posted ?? `${ABSENCE.value.toUpperCase()} AT SOURCE`,
    job.location.toUpperCase(),
    age ? formatDays(age.days).toUpperCase() : ABSENCE.date.toUpperCase()
  ].join('  ·  ');

  const stamp = isClosed
    ? `${statusStamp(job).toUpperCase()}${job.closed_on ? ` · DETECTED ${String(formatDate(job.closed_on)).toUpperCase()}` : ''}`
    : statusStamp(job).toUpperCase();

  const footLeft = `SWEPT ${sweptStamp().toUpperCase()}`;
  const footRight = `READ DIRECT FROM ${sourceLabel(job).toUpperCase()}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.width}" height="${CARD.height}" viewBox="0 0 ${CARD.width} ${CARD.height}" role="img" aria-label="${esc(`${job.title} at ${job.company}, ${statusStamp(job)}`)}">
  ${CARD_DEFS}

  ${CARD_GROUND}

  ${CARD_WORDMARK}

  <g transform="translate(${PAD}, 160)">
    ${mark(job)}
    <text class="mono" x="34" y="0" font-size="17" fill="${markColor}">${esc(stamp)}</text>
  </g>

  <text class="mono" x="${PAD}" y="205" font-size="17" fill="${PALETTE.muted}">${esc(job.company.toUpperCase())}</text>

  ${titleLines
    .map(
      (line, index) =>
        `<text class="sans" x="${PAD}" y="${titleTop + index * TITLE_LEADING}" font-size="${TITLE_SIZE}" letter-spacing="-1" fill="${isClosed ? PALETTE.muted : PALETTE.foreground}">${esc(line)}</text>`
    )
    .join('\n  ')}

  <text class="mono" x="${PAD}" y="${titleTop + titleLines.length * TITLE_LEADING + 24}" font-size="20" fill="${PALETTE.muted}">${esc(facts)}</text>

  ${
    isClosed
      ? `<text class="mono" x="${PAD}" y="${CARD.height - 92}" font-size="20" fill="${PALETTE.muted}">ARCHIVED RECORD, NO APPLICATIONS</text>`
      : `<text class="sans" x="${PAD}" y="${CARD.height - 82}" font-size="60" fill="${PALETTE.foreground}">${job.fit.total}</text>
  <text class="mono" x="${PAD + String(job.fit.total).length * 37 + 6}" y="${CARD.height - 84}" font-size="20" fill="${PALETTE.muted}">/100 FIT, RUBRIC V1</text>`
  }

  ${cardFoot(footLeft, footRight)}
</svg>
`;
}

export const GET: APIRoute = ({ props }) => svgResponse(render(props.job as Job));
