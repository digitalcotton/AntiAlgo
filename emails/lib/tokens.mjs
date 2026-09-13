/**
 * Token resolution for email.
 *
 * THIS IS THE ONE PLACE ON THIS PROPERTY WHERE A VALUE CANNOT BE var(--token).
 *
 * Every visual value in the site comes from a custom property. Mail clients do
 * not support custom properties: Outlook's Word rendering engine has never
 * supported them, and Gmail strips the :root block that would define them, so
 * `color: var(--color-foreground)` arrives at a reader as no colour at all. An
 * email therefore has to carry literal values, inline, on every element.
 *
 * The tempting move is to type the hex codes into the templates. That is how a
 * design system starts lying: the emails drift from the site one nudged value at
 * a time, and nothing anywhere fails when they do. BUILD.md ruling 1 moved
 * mark-live by one digit for contrast, and a hand-typed email would still be
 * shipping the old value today.
 *
 * So the values still come FROM the token pipeline, one step further along it.
 * `npm run tokens` compiles the DTCG sources to src/styles/tokens.css, and this
 * module parses that compiled artifact, follows every var() chain to a literal,
 * and hands the templates a `t()` function. The email is downstream of Style
 * Dictionary exactly as the site is; it simply resolves the reference at build
 * time instead of at paint time.
 *
 * The consequences, stated because they are the price of the approach:
 *
 *   1. A token change reaches the emails only when they are rebuilt. That is a
 *      real staleness risk and the reason `node scripts/build-emails.mjs` prints
 *      the source file's modification time on every run.
 *   2. A missing or unresolvable token throws. There is no fallback value
 *      anywhere in this file. A fallback is a second, unmanaged source of truth,
 *      and it would hide the exact drift this module exists to prevent.
 *   3. Only the light theme is read. tokens.css holds the light values and
 *      themes.css remaps them for dark; emails are light only, so the dark remap
 *      is deliberately never opened. See DECISIONS.md.
 */

import { readFileSync, statSync } from 'node:fs';

/** The root font size the site computes rem against, from global.css. */
const ROOT_PX = 16;

/**
 * Parses `--name: value;` declarations out of the compiled token stylesheet.
 *
 * A regex rather than a CSS parser because the input is a generated file with
 * one declaration per line and no nesting, and adding a parser dependency to
 * read a file this repository generates itself would be the more fragile of the
 * two options. The comment tail Style Dictionary emits after each value is
 * stripped, since it carries the token description and not the value.
 */
function parseDeclarations(css) {
  const found = new Map();
  const declaration = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim;
  let match;
  while ((match = declaration.exec(css)) !== null) {
    const value = match[2].replace(/\/\*\*[\s\S]*?\*\//g, '').trim();
    found.set(match[1], value);
  }
  return found;
}

/**
 * Removes the first family from a font stack.
 *
 * The token stacks are written brand face first, then generics. The brand face
 * is the licensed file the site loads with @font-face, and an email cannot load
 * it, so this drops exactly that entry and leaves the rest of the token's own
 * ordering intact. It is a quoted name in every current token, and the quoting
 * is what makes the split unambiguous.
 */
function dropBrandFamily(stack) {
  const first = /^\s*(['"])(?:[^'"]*)\1\s*,\s*/.exec(stack);
  if (first) return stack.slice(first[0].length);
  // An unquoted first entry is still a family name and still gets dropped, but
  // this is worth knowing about: the token sources have changed shape.
  const comma = stack.indexOf(',');
  return comma === -1 ? stack : stack.slice(comma + 1).trim();
}

export class TokenSet {
  constructor(cssPath) {
    let css;
    try {
      css = readFileSync(cssPath, 'utf8');
    } catch {
      throw new Error(
        `emails: could not read ${cssPath}. That file is generated, not committed: run "npm run tokens" first. The emails resolve every colour, size and spacing value out of it, so there is nothing to build without it.`
      );
    }

    this.path = cssPath;
    this.generatedAt = statSync(cssPath).mtime;
    this.declarations = parseDeclarations(css);

    if (this.declarations.size === 0) {
      throw new Error(`emails: ${cssPath} parsed to zero token declarations. The compiled token file has changed shape.`);
    }
  }

  /**
   * One token, resolved to a literal.
   *
   * Semantic tokens point at primitives (`--color-foreground: var(--gray-950)`),
   * so resolution follows the chain until it reaches a value with no var() left
   * in it. The depth cap is not defensive decoration: a cycle in the token
   * sources would otherwise hang the build with no message.
   */
  raw(name) {
    const key = name.startsWith('--') ? name : `--${name}`;
    let value = this.declarations.get(key);
    if (value === undefined) {
      throw new Error(
        `emails: no token "${key}" in ${this.path}. Emails may not invent a value, so this is either a typo or a token that needs adding to tokens/ and compiling with "npm run tokens".`
      );
    }

    for (let hop = 0; hop < 10 && value.includes('var('); hop += 1) {
      value = value.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/gi, (_, referenced) => {
        const next = this.declarations.get(referenced);
        if (next === undefined) {
          throw new Error(`emails: token "${key}" points at "${referenced}", which ${this.path} does not define.`);
        }
        return next.replace(/\/\*\*[\s\S]*?\*\//g, '').trim();
      });
    }

    if (value.includes('var(')) {
      throw new Error(`emails: token "${key}" still holds a var() after ten hops. The token sources have a reference cycle.`);
    }

    return value;
  }

  /**
   * A length token as whole pixels.
   *
   * Mail clients handle px predictably and rem badly: Outlook ignores rem
   * entirely, and several webmail clients resolve it against their own shell
   * rather than the message, so the same email renders at two sizes depending on
   * who opened it. Converting here keeps the ramp intact (the value is still the
   * token's value) while giving every client the one unit all of them agree on.
   */
  px(name) {
    const value = this.raw(name);
    const rem = /^(-?[\d.]+)rem$/.exec(value);
    if (rem) return Math.round(Number(rem[1]) * ROOT_PX);
    const px = /^(-?[\d.]+)px$/.exec(value);
    if (px) return Math.round(Number(px[1]));
    const bare = /^(-?[\d.]+)$/.exec(value);
    if (bare) return Math.round(Number(bare[1]));
    throw new Error(`emails: token "${name}" is "${value}", which is not a length this can convert to pixels.`);
  }

  /** A unitless token used as written: weights, line heights, opacity. */
  number(name) {
    const value = this.raw(name);
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`emails: token "${name}" is "${value}", which is not a number.`);
    }
    return parsed;
  }

  /**
   * The two voices, rebuilt for mail.
   *
   * Standing rule 3 is two typefaces: N27 for editorial, Basier Square Mono for
   * machine assertions. Neither can reach an inbox. Web fonts are not the answer
   * either: only Apple Mail and a short list of clients honour @font-face, so
   * most readers would get a fallback anyway while every reader paid for the
   * request.
   *
   * THE BRAND FAMILY IS DROPPED, NOT KEPT AS A FIRST CHOICE. That is the
   * opposite of the obvious move and it was decided by measurement, not taste.
   * The first build of these emails carried the token stack unchanged, brand
   * family first, on the reasoning that a reader who happens to have the face
   * installed should see the real thing. Opened in a browser on this machine,
   * every sans line rendered as tofu boxes: a font named N27 is installed here,
   * `font-family: 'N27'` matched it, and it drew no Latin glyphs at all.
   * Measured with a canvas probe: "The weekly digest" at 36px is 673.3px wide in
   * the matched N27 against 288.1px in Helvetica, which is the width signature
   * of a row of missing-glyph boxes. Basier Square Mono is not installed here
   * and fell through cleanly, so only one of the two was hit.
   *
   * On the site that risk does not exist, because @font-face names the exact
   * file the browser must use. In an email there is no @font-face, so naming a
   * family is a bet that every reader with that family name installed has the
   * same cut of it. This one lost the bet on the first machine that opened it.
   * A brand face is worth a lot; it is not worth an unreadable email.
   *
   * What survives is the part of standing rule 3 that actually carries meaning:
   * proportional for editorial, monospace for machine assertions. Every mail
   * client on earth can draw that distinction, and a reader can still tell a
   * measurement from a sentence at a glance.
   *
   * Still derived from the token rather than retyped: the generic families the
   * token names are kept in the order it names them, and the mail-safe faces are
   * spliced in before the generic. A change to the token stack reaches the
   * emails on the next build.
   */
  sansStack() {
    return dropBrandFamily(this.raw('font-family-sans')).replace(
      /sans-serif\s*$/,
      'Helvetica Neue, Helvetica, Arial, sans-serif'
    );
  }

  monoStack() {
    return dropBrandFamily(this.raw('font-family-mono')).replace(
      /monospace\s*$/,
      'SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace'
    );
  }
}

export function loadTokens(cssPath) {
  return new TokenSet(cssPath);
}
