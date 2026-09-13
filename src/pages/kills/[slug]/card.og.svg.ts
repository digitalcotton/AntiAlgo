import type { APIRoute, GetStaticPaths } from 'astro';
import {
  formatDate,
  killDuration,
  killSlug,
  killsWithCards,
  measuredByUs,
  sweptStamp,
  type Kill
} from '../../../lib/data';
import { displayUrl } from '../../../data/site';
import { routeFor } from '../../../data/nav';
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
} from '../../../lib/og-card';

/**
 * The social card for one kill, at /kills/<slug>/card.og.svg.
 *
 * WHY IT IS A SEPARATE THING FROM /kills/<slug>/card. That route is the share
 * card as a page: a reader opens it, screenshots it, and posts the picture.
 * This is the image a platform fetches when somebody pastes the link, and until
 * now every one of the fourteen card pages pointed at the site-wide
 * `/og-image.png`, which did not exist. So the most shared artifact on the site
 * unfurled as a broken image, and when it unfurled at all it would have shown a
 * generic card rather than the record being shared. One card per record fixes
 * both halves.
 *
 * WHAT IT DRAWS, AND THE ONE THING IT REFUSES TO. The company, the title, the
 * observation the machine recorded, the measured span with the two dates it was
 * measured from, and the sweep. No 9.8 day reference line: on the page that
 * line is drawn with its source printed beside it, and a card is cropped by
 * whoever shows it, so a comparison whose citation can be cut off is a
 * comparison this site does not make. The digest email reached the same answer
 * for the same reason: 685 days beside "First published Oct 1, 2024" needs no
 * chart.
 *
 * A row whose duration was reported elsewhere draws no span at all, per
 * SESSION-07-KILL-LIST.md ruling 4. The bar is a measurement, and where we hold
 * none the card says so rather than borrowing somebody else's number.
 */

// Built over the record and not only over tonight, so the image behind a card
// somebody shared in August still renders in December. Same set as card.astro,
// from one function, because an image route and its page route that disagree
// produce a page whose social preview is a 404.
export const getStaticPaths = (() =>
  killsWithCards().map((kill) => ({ params: { slug: killSlug(kill) }, props: { kill } }))) satisfies GetStaticPaths;

const TITLE_SIZE = 50;
const TITLE_LEADING = 60;
const TITLE_MAX_LINES = 2;

const REASON_SIZE = 24;
const REASON_LEADING = 34;
const REASON_MAX_LINES = 3;

/**
 * The closed mark is drawn inline on the same 48 unit grid as Mark.astro: ring
 * plus a hollow core, in the muted tone. A closed posting is an honest archive
 * record and never an alarm, so the loss colour stays on the span and off the
 * glyph, which is the legend canon in tokens/README.md.
 */
function render(kill: Kill): string {
  const duration = measuredByUs(kill) ? killDuration(kill) : null;

  const titleLines = wrap(kill.title, TITLE_SIZE, CONTENT_WIDTH, TITLE_MAX_LINES);
  const titleTop = 250;
  const reasonTop = titleTop + titleLines.length * TITLE_LEADING + 20;
  const reasonLines = wrap(kill.reason, REASON_SIZE, CONTENT_WIDTH, REASON_MAX_LINES);

  const killedOn = formatDate(kill.killed_on);
  const stamp = killedOn ? `KILLED BY RULE · ${killedOn.toUpperCase()}` : 'KILLED BY RULE';

  // The span, and its own provenance. Where we measured it, the two dates it
  // was measured between are printed beside it, because a span with no endpoints
  // is a number a reader cannot check.
  const span = duration
    ? `<text class="sans" x="${PAD}" y="${CARD.height - 82}" font-size="60" fill="${PALETTE.statLoss}">${duration.days}</text>
  <text class="mono" x="${PAD + String(duration.days).length * 37 + 6}" y="${CARD.height - 84}" font-size="20" fill="${PALETTE.muted}">DAYS OPEN · ${esc(String(formatDate(duration.from)).toUpperCase())} TO ${esc(String(formatDate(duration.to)).toUpperCase())}</text>`
    : `<text class="mono" x="${PAD}" y="${CARD.height - 92}" font-size="20" fill="${PALETTE.muted}">NO FIRST-PUBLISHED DATE AT SOURCE, SO NO SPAN WAS MEASURED</text>`;

  const footLeft = `SWEPT ${sweptStamp().toUpperCase()}`;
  // The same address the HTML card prints, through the same helper. It used to
  // be built here by hand and there by hand, from two different constants, and
  // the two disagreed: this line was right and _ShareCard.astro's was doubled.
  // A typed '/kills' also sidesteps the route registry, so a rename would have
  // moved the page and left the card advertising the old path.
  const footRight = displayUrl(routeFor('kills')).toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.width}" height="${CARD.height}" viewBox="0 0 ${CARD.width} ${CARD.height}" role="img" aria-label="${esc(`${kill.title} at ${kill.company}, killed by rule`)}">
  ${CARD_DEFS}

  ${CARD_GROUND}

  ${CARD_WORDMARK}

  <g transform="translate(${PAD}, 160)">
    <svg x="0" y="-18" width="24" height="24" viewBox="0 0 48 48"><circle cx="24" cy="24" r="19" fill="none" stroke="${PALETTE.markClosed}" stroke-width="5"/><rect x="17" y="17" width="14" height="14" fill="none" stroke="${PALETTE.markClosed}" stroke-width="4"/></svg>
    <text class="mono" x="34" y="0" font-size="17" fill="${PALETTE.markClosed}">${esc(stamp)}</text>
  </g>

  <text class="mono" x="${PAD}" y="205" font-size="17" fill="${PALETTE.muted}">${esc(kill.company.toUpperCase())}</text>

  ${titleLines
    .map(
      (line, index) =>
        `<text class="sans" x="${PAD}" y="${titleTop + index * TITLE_LEADING}" font-size="${TITLE_SIZE}" letter-spacing="-1" fill="${PALETTE.foreground}">${esc(line)}</text>`
    )
    .join('\n  ')}

  ${reasonLines
    .map(
      (line, index) =>
        `<text class="prose" x="${PAD}" y="${reasonTop + index * REASON_LEADING}" font-size="${REASON_SIZE}" fill="${PALETTE.muted}">${esc(line)}</text>`
    )
    .join('\n  ')}

  ${span}

  ${cardFoot(footLeft, footRight)}
</svg>
`;
}

export const GET: APIRoute = ({ props }) => svgResponse(render(props.kill as Kill));
