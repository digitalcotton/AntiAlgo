import type { APIRoute } from 'astro';

// Rendered per request (since 2026-09-20): dark with the report flag, see
// flags.config.mjs FLAGGED_ROUTES ('/report.og.svg' has its own entry).
export const prerender = false;
import { sweptStamp } from '../lib/data';
import { formatReading, killedByRuleTotal } from '../lib/readings';
import { displayUrl } from '../data/site';
import { routeFor } from '../data/nav';
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
} from '../lib/og-card';

/**
 * The social card for the report, at /jobs/report.og.svg.
 *
 * WHY IT EXISTS. The report was the one page type on this site whose card never
 * reached a crawler. Every posting has /role/<slug>.og.svg and every kill has
 * /kills/<slug>/card.og.svg, both wired into og:image, and the report shipped
 * the generic site card: sharing the launch issue showed the same picture as
 * sharing the home page. /report/cover was built for this and nothing ever
 * pointed at it, which is a different defect and is fixed below.
 *
 * WHY IT DOES NOT REPLACE /report/cover, AND WHY THAT IS NOT TWO DESIGNS OF ONE
 * THING. A crawler fetches an image; it cannot rasterise an HTML page. So the
 * two artifacts are for two consumers: /report/cover is the card a person opens
 * and a rasteriser reads, in both themes; this is the
 * file a platform pulls when somebody pastes the link. What would make them a
 * duplication is two copies of the claim, and there are not two: both read the
 * same reading out of the same data layer through src/lib/readings.ts, so the
 * night a sweep measures something else neither can go on saying the old
 * number. That is the same argument /og.svg makes for being a route rather than
 * a checked-in PNG.
 *
 * WHAT IT DRAWS. The headline figure, the sourced sentence behind it, and the
 * source named in the machine voice. It carried a fact from facts.json until
 * 2026-08-19, and now carries a reading instead, so what has to survive the
 * crop changed with it: not a citation but the sweep instant, because a reading
 * with no date on it is a number pretending to be permanent. Both the figure
 * and the stamp sit inside the middle band a platform's crop keeps.
 */

const CLAIM_SIZE = 34;
const CLAIM_LEADING = 46;
const CLAIM_MAX_LINES = 4;

/**
 * The sentence under the figure. Editorial, not a statistic: every numeral on
 * this card is the reading itself, drawn once, and nothing here restates it.
 */
const CLAIM =
  'Five rules ran against every posting we pulled. Each one publishes what it found, and the ones that found nothing publish that.';

function render(): string {
  const figure = formatReading(killedByRuleTotal());

  const claimLines = wrap(CLAIM, CLAIM_SIZE, CONTENT_WIDTH, CLAIM_MAX_LINES);
  const figureTop = 300;
  const claimTop = figureTop + 60;

  const footLeft = `SWEPT ${sweptStamp().toUpperCase()}`;
  // This line was already joining to the origin, which is the correct half of
  // the pair, and it is the reason the built tree could be caught disagreeing
  // with itself. It reads the shared helper now so there is no longer a version
  // of this join anywhere for a later file to copy the wrong one from.
  const footRight = displayUrl(routeFor('report')).toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.width}" height="${CARD.height}" viewBox="0 0 ${CARD.width} ${CARD.height}" role="img" aria-label="${esc(`State of the market, swept ${sweptStamp()}. ${figure} postings were caught by a named rule this sweep.`)}">
  ${CARD_DEFS}

  ${CARD_GROUND}

  ${CARD_WORDMARK}

  <text class="mono" x="${PAD}" y="160" font-size="17" fill="${PALETTE.muted}">STATE OF THE MARKET</text>

  <text class="sans" x="${PAD}" y="${figureTop}" font-size="150" letter-spacing="-4" fill="${PALETTE.statLoss}">${esc(figure)}</text>

  <text class="sans" x="${PAD}" y="${figureTop + 40}" font-size="32" fill="${PALETTE.foreground}">postings were caught by a named rule this sweep.</text>

  ${claimLines
    .map(
      (line, index) =>
        `<text class="prose" x="${PAD}" y="${claimTop + 60 + index * CLAIM_LEADING}" font-size="${CLAIM_SIZE}" fill="${PALETTE.muted}">${esc(line)}</text>`
    )
    .join('\n  ')}

  <text class="mono" x="${PAD}" y="${claimTop + 60 + claimLines.length * CLAIM_LEADING + 24}" font-size="18" fill="${PALETTE.muted}">MEASURED BY THE INDEX, READ DIRECT FROM COMPANY FEEDS</text>

  ${cardFoot(footLeft, footRight)}
</svg>
`;
}

export const GET: APIRoute = () => svgResponse(render());
