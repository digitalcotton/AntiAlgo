import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import primitives from '../../tokens/primitive.tokens.json';
import semantic from '../../tokens/semantic.tokens.json';

/**
 * The shared machinery behind every social card this site emits.
 *
 * Three routes draw one: `/og.svg` (the site card, which every page without a
 * card of its own points at), `/role/[slug].og.svg` (one posting) and
 * `/kills/[slug]/card.og.svg` (one kill). They are three different cards and
 * one frame, so the frame is here: the palette resolved out of the token files,
 * the two faces embedded, the geometry, the wordmark, the wrapper and the foot.
 *
 * WHY SVG AND NOT PNG, WHICH IS THE HONEST ANSWER AND THE UNCOMFORTABLE ONE.
 * A share card wants to be a raster image: several social platforms fetch
 * og:image with a crawler that does not run a renderer, and those will get
 * nothing from these files. Producing a PNG needs a rasteriser that can draw
 * N27 and Basier Square Mono, and this repository ships those two faces as
 * woff2 only. The rasteriser already in the tree (sharp, which arrives with
 * Astro's image service) renders SVG through librsvg, and librsvg cannot read a
 * woff2 face from a data URI: it draws tofu, verified rather than assumed. What
 * unblocks a PNG is written in DECISIONS.md: a ttf or otf cut of the two faces,
 * at which point sharp does it at build time with nothing new installed.
 *
 * IT IS SELF CONTAINED ON PURPOSE. An SVG loaded through an img tag or an
 * og:image cannot fetch anything: no stylesheet, no font file, no second
 * request. So both faces are embedded as base64 woff2 and every colour is
 * resolved out of tokens/ at build time rather than typed. A card is a token
 * consumer like every other surface here; it just cannot use var().
 *
 * ONE THEME. A share card is composited onto a platform's own surface and has
 * no viewer preference to read, so it ships in the light palette, which is the
 * paper this product is printed on.
 */

type TokenNode = { $value?: string } & Record<string, unknown>;

/**
 * Follows a DTCG alias like "{gray.050}" to the primitive it points at.
 *
 * One hop is enough for this palette: semantic colours point at primitives and
 * primitives hold values. A deeper chain throws rather than returning the
 * alias, because a raw "{status.live.on-paper}" painted into an SVG fill would
 * fail silently as a black rectangle and nobody would know which token broke.
 */
function primitive(path: string): string {
  const value = path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], primitives as unknown);
  const found = (value as TokenNode | undefined)?.$value;
  if (typeof found !== 'string') {
    throw new Error(
      `og card: tokens/primitive.tokens.json has no value at "${path}". A card paints from the token files so it cannot drift from the site; a missing token is a broken card, not a default colour.`
    );
  }
  return found;
}

export function color(name: string): string {
  const entry = (semantic.color as Record<string, TokenNode | undefined>)[name];
  const raw = entry?.$value;
  if (typeof raw !== 'string') {
    throw new Error(`og card: tokens/semantic.tokens.json has no colour named "${name}".`);
  }
  const alias = /^\{(.+)\}$/.exec(raw);
  return alias ? primitive(alias[1]) : raw;
}

export const PALETTE = {
  surface: color('surface'),
  raised: color('surface-raised'),
  foreground: color('foreground'),
  muted: color('muted'),
  line: color('line'),
  lineStrong: color('line-strong'),
  markLive: color('mark-live'),
  markClosed: color('mark-closed'),
  statLoss: color('stat-loss')
};

/**
 * Read once per build rather than once per card. Fifty-three cards would
 * otherwise re-read and re-encode the same two files fifty-three times.
 *
 * The path is resolved against the working directory because these are shipped
 * assets under public/, and an endpoint's own module URL points at a bundled
 * chunk rather than at the source tree. If the build is ever run from
 * elsewhere, this throws with the path it looked in, which is a better failure
 * than a card set in the system sans.
 */
function embeddedFont(file: string): string {
  const path = resolve(process.cwd(), 'public', 'fonts', file);
  try {
    return readFileSync(path).toString('base64');
  } catch {
    throw new Error(
      `og card: could not read ${path}. A share card embeds the two faces because an SVG used as an image cannot fetch one. Run the build from the repository root, or run npm run fonts to cut the subsets.`
    );
  }
}

const SANS_BOLD = embeddedFont('n27-bold-latin.woff2');
const SANS_REGULAR = embeddedFont('n27-regular-latin.woff2');
const MONO_MEDIUM = embeddedFont('basiersquaremono-medium-latin.woff2');

/** Geometry. Named, because a number in a draw call explains nothing. */
export const CARD = { width: 1200, height: 630 };
export const PAD = 72;
export const CONTENT_WIDTH = CARD.width - PAD * 2;

/**
 * Greedy wrap by estimated advance width.
 *
 * SVG has no line box, so wrapping is arithmetic. 0.55 em is the measured
 * average advance of N27 Bold across mixed case Latin, which is close enough at
 * these sizes that a line lands within a few percent of the column.
 */
export function wrap(text: string, size: number, width: number, maxLines: number): string[] {
  const perLine = Math.max(8, Math.floor(width / (size * 0.55)));
  const lines: string[] = [];
  let current = '';

  for (const word of text.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= perLine) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);

  if (lines.length === maxLines) {
    // Anything that did not fit is cut rather than shrunk, and the cut is
    // visible. A silently truncated title would read as the employer's own.
    const consumed = lines.join(' ');
    if (consumed.length < text.length) {
      lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(0, perLine - 3))}...`;
    }
  }
  return lines;
}

/** XML escaping. Job titles carry ampersands, and locations carry quote-bearing
    hedges, so this is not theoretical. */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The three @font-face rules and the three classes every card draws with.
 *
 * The regular cut is embedded as well as the bold because a card that carries a
 * sentence needs one: the kill card prints the machine's observation as prose,
 * and prose set in the display weight reads as a second headline. There is no
 * font-synthesis here to fall back on either, so a class asking for 400 with
 * only a 700 face embedded would be drawn by whatever the renderer had, which
 * on a social crawler is nothing recognisable.
 */
export const CARD_DEFS = `<defs>
    <style>
      @font-face { font-family: 'N27'; font-weight: 400; font-style: normal; src: url(data:font/woff2;base64,${SANS_REGULAR}) format('woff2'); }
      @font-face { font-family: 'N27'; font-weight: 700; font-style: normal; src: url(data:font/woff2;base64,${SANS_BOLD}) format('woff2'); }
      @font-face { font-family: 'BasierSquareMono'; font-weight: 500; font-style: normal; src: url(data:font/woff2;base64,${MONO_MEDIUM}) format('woff2'); }
      .sans { font-family: 'N27', ui-sans-serif, system-ui, sans-serif; font-weight: 700; }
      .prose { font-family: 'N27', ui-sans-serif, system-ui, sans-serif; font-weight: 400; }
      .mono { font-family: 'BasierSquareMono', ui-monospace, monospace; font-weight: 500; letter-spacing: 1.6px; }
    </style>
  </defs>`;

/** The paper and its edge. Every card is the same sheet. */
export const CARD_GROUND = `<rect width="${CARD.width}" height="${CARD.height}" fill="${PALETTE.surface}"/>
  <rect x="8" y="8" width="${CARD.width - 16}" height="${CARD.height - 16}" fill="${PALETTE.raised}" stroke="${PALETTE.lineStrong}" stroke-width="2"/>`;

/**
 * The wordmark and its byline, at the top left of every card.
 *
 * Identity at the top and address at the bottom is a cropping decision rather
 * than a symmetry: a screenshot rarely keeps all four edges, and a crop from
 * either end still leaves the card attributable.
 */
export const CARD_WORDMARK = `<g transform="translate(${PAD}, 88)">
    <circle cx="14" cy="0" r="12.5" fill="none" stroke="${PALETTE.foreground}" stroke-width="3.5"/>
    <rect x="9.5" y="-4.5" width="9" height="9" fill="${PALETTE.foreground}"/>
    <text class="sans" x="42" y="8" font-size="26" fill="${PALETTE.foreground}">The Index</text>
    <text class="mono" x="168" y="7" font-size="15" fill="${PALETTE.muted}">BY TOKENSTOAGENTS.AI</text>
  </g>`;

/** The rule above the foot, and the two foot lines. */
export function cardFoot(left: string, right: string): string {
  return `<line x1="${PAD}" y1="${CARD.height - 152}" x2="${CARD.width - PAD}" y2="${CARD.height - 152}" stroke="${PALETTE.line}" stroke-width="1"/>
  <text class="mono" x="${PAD}" y="${CARD.height - 40}" font-size="15" fill="${PALETTE.muted}">${esc(left)}</text>
  <text class="mono" x="${CARD.width - PAD}" y="${CARD.height - 40}" font-size="15" fill="${PALETTE.muted}" text-anchor="end">${esc(right)}</text>`;
}

/** The response every card endpoint returns. One place, so the headers agree. */
export function svgResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // Immutable in practice: a card changes only when a sweep rebuilds it,
      // and a sweep rewrites the whole site.
      'Cache-Control': 'public, max-age=3600'
    }
  });
}
