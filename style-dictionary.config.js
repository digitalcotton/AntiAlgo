/**
 * Three-tier DTCG tokens compiled to CSS custom properties, same contract as
 * the mothership: values pass through verbatim, only the name is transformed,
 * and references stay as var() so the tier structure survives into the browser.
 * The output is the single source of style. Regenerate it, never hand-edit it.
 *
 * One deliberate difference from site/style-dictionary.config.js. There, every
 * semantic colour remaps to a step of the gray ramp, because that site has no
 * accent colour at all: emphasis is inversion, full stop. The Index cannot hold
 * that line honestly. It has to say "this was verified" and "this many died",
 * and a mark that means something has to be legible as meaning rather than as
 * emphasis. So the ramp gains exactly two non-neutral pairs, and the remap
 * accepts a full token path as well as a bare gray step.
 *
 * The guarantee the mothership's format provides is kept exactly: every
 * semantic colour must appear in DARK_REMAP and must resolve to a primitive
 * that exists, or the build throws. Adding a colour and forgetting dark mode
 * is a failed build, not a bug someone finds in a screenshot later.
 */

/* Semantic colour token -> the primitive it becomes on ink.
   A bare string is a gray ramp step. A dotted string is a full primitive path. */
export const DARK_REMAP = {
  surface: '950',
  'surface-inverse': '050',
  'surface-raised': '900',
  foreground: '050',
  'foreground-inverse': '950',
  muted: '400',
  'muted-inverse': '600',

  /* There is no `dim` entry, and there is not meant to be one. `dim` was
     gray.500, the tone one step quieter than `muted`, and the contrast audit on
     2026-08-17 retired it: gray.500 clears AA at none of the sizes it carried,
     on any light surface, and gray.600 turned out to be the lightest tone on
     this ramp that does clear it. Every former usage is `muted` now. If you are
     here because you are reinstating a quieter tone, the constraint to check
     first is reports/contrast-audit.md, not this file. */

  line: '800',
  'line-strong': '600',
  'hover-surface': '800',
  // The age strip's drag handle and rail, brought in with the board's
  // AgePlot component. gray.800 on paper, gray.200 on ink — its own mirror,
  // not the standard hover-surface remap.
  control: '200',

  // The two live marks keep their meaning across themes by changing value.
  'mark-live': 'status.live.on-ink',
  // Closed stays neutral on both themes, one step lighter so it reads on ink.
  'mark-closed': '400',
  'banner-stale': 'status.stale.on-ink',
  'stat-loss': 'status.loss.on-ink',

  // The hatch inverts to its dark pair, so an empty slot still reads as empty.
  'hatch-a': '900',
  'hatch-b': '925',

  // The one accent. Same value in both themes, so it remaps to its own primitive
  // rather than to a gray step: the brand does not dim on ink.
  signal: 'signal.base'
};

const resolve = (dictionary, spec, key) => {
  const path = spec.includes('.') ? spec.split('.') : ['gray', spec];
  const target = dictionary.allTokens.find(
    (t) => t.path.length === path.length && t.path.every((seg, i) => seg === path[i])
  );
  if (!target) {
    throw new Error(`css/theme-dark: dark remap for color.${key} points at missing primitive ${path.join('.')}`);
  }
  return target;
};

export default {
  source: ['tokens/**/*.tokens.json'],
  hooks: {
    formats: {
      'css/theme-dark': ({ dictionary }) => {
        const semantic = dictionary.allTokens.filter((t) => t.path[0] === 'color');
        const lines = semantic.map((t) => {
          const key = t.path.slice(1).join('-');
          const spec = DARK_REMAP[key];
          if (!spec) {
            throw new Error(`css/theme-dark: semantic token color.${key} has no dark remap`);
          }
          return `  --${t.name}: var(--${resolve(dictionary, spec, key).name});`;
        });
        return [
          '/**',
          ' * Do not edit directly, this file was auto-generated.',
          ' * Dark theme: the semantic layer remapped onto the primitives.',
          ' */',
          '',
          ":root[data-theme='dark'] {",
          ...lines,
          '}',
          ''
        ].join('\n');
      }
    }
  },
  platforms: {
    css: {
      transforms: ['name/kebab'],
      buildPath: 'src/styles/',
      files: [
        {
          destination: 'tokens.css',
          format: 'css/variables',
          options: { outputReferences: true, selector: ':root' }
        },
        { destination: 'themes.css', format: 'css/theme-dark' }
      ]
    }
  }
};
