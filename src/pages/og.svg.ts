import type { APIRoute } from 'astro';
import { loadStats, sweptStamp } from '../lib/data';
import { formatReading, killedByRuleTotal } from '../lib/readings';
import { SITE, displayUrl } from '../data/site';
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
 * The site card, at /og.svg. What every route without a card of its own points
 * at when it is shared.
 *
 * WHY IT EXISTS, WHICH IS A DEFECT REPORT AS MUCH AS A FEATURE. `SITE.ogImage`
 * pointed at `/og-image.png` and no such file was ever in `public/`. Twenty-two
 * built routes shipped it as both og:image and twitter:image, so every social
 * preview on this site resolved to a 404, including the kill share cards, which
 * SESSION-07-KILL-LIST.md calls the growth engine. A link crawl over the built
 * tree does not catch it, because the reference lives in a meta content
 * attribute rather than in an href.
 *
 * A checked-in PNG would have been the quicker fix and the wrong one for the
 * same reason `/report/cover` is a route: this card carries four sweep numbers,
 * and a PNG of them is a screenshot of a claim. No gate can read it, and it
 * keeps saying 27% on the morning sweep 002 makes that false. As a route it
 * reads the same data layer as every page, and the numbers on it are the
 * numbers in `src/data/stats.json` by construction.
 *
 * Everything drawn here is either the product's own name, the index page's own
 * headline, or a figure out of stats.json. No statistic from `facts.json`
 * appears: a research citation needs its source beside it, and a card that is
 * cropped by the platform showing it is the worst surface on which to promise
 * that a source line survives.
 */

const HEADLINE = 'Design roles at AI-native companies, verified last night.';
const HEADLINE_SIZE = 58;
const HEADLINE_LEADING = 70;
const HEADLINE_MAX_LINES = 3;

/** One sweep figure: the numeral over its label, in a row of four. */
function tile(x: number, y: number, value: string, label: string, loss = false): string {
  return `<g transform="translate(${x}, ${y})">
    <text class="sans" x="0" y="0" font-size="52" fill="${loss ? PALETTE.statLoss : PALETTE.foreground}">${esc(value)}</text>
    <text class="mono" x="0" y="30" font-size="15" fill="${PALETTE.muted}">${esc(label)}</text>
  </g>`;
}

function render(): string {
  const stats = loadStats();
  const lines = wrap(HEADLINE, HEADLINE_SIZE, CONTENT_WIDTH, HEADLINE_MAX_LINES);
  const headTop = 250;

  const tilesTop = CARD.height - 108;
  const columnWidth = CONTENT_WIDTH / 4;

  const footLeft = `SWEPT ${sweptStamp().toUpperCase()}`;
  // The site's own address: the index route, which is the base and nothing
  // else, joined to the origin by the one helper every card now uses. Written
  // this way rather than as SITE.url with the scheme stripped so that the four
  // cards on this site build their footer address identically.
  const footRight = displayUrl(routeFor('index')).toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.width}" height="${CARD.height}" viewBox="0 0 ${CARD.width} ${CARD.height}" role="img" aria-label="${esc(`${SITE.name}. ${HEADLINE}`)}">
  ${CARD_DEFS}

  ${CARD_GROUND}

  ${CARD_WORDMARK}

  <text class="mono" x="${PAD}" y="160" font-size="17" fill="${PALETTE.markLive}">VERIFIED AT SOURCE, NIGHTLY</text>

  ${lines
    .map(
      (line, index) =>
        `<text class="sans" x="${PAD}" y="${headTop + index * HEADLINE_LEADING}" font-size="${HEADLINE_SIZE}" letter-spacing="-1" fill="${PALETTE.foreground}">${esc(line)}</text>`
    )
    .join('\n  ')}

  ${tile(PAD, tilesTop, String(stats.boards), 'BOARDS READ')}
  ${tile(PAD + columnWidth, tilesTop, String(stats.verified_live), 'VERIFIED LIVE')}
  ${tile(PAD + columnWidth * 2, tilesTop, String(stats.killed), 'KILLED', true)}
  ${tile(PAD + columnWidth * 3, tilesTop, formatReading(killedByRuleTotal()), 'KILLED BY RULE', true)}

  ${cardFoot(footLeft, footRight)}
</svg>
`;
}

export const GET: APIRoute = () => svgResponse(render());
