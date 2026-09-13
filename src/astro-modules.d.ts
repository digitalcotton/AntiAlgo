/**
 * What a `.astro` file looks like to plain tsc.
 *
 * WHY THIS IS NEEDED AT ALL. Astro type-checks `.astro` files through its own
 * language server, which `npm run check` (astro check) drives. Plain
 * `tsc --noEmit` has no such plugin: it reads `import Card from './Card.astro'`
 * and can only report that no module by that name exists. That never came up
 * while nothing but `.astro` files imported `.astro` files. Wave 2 added render
 * tests, which are `.ts`, and every one of them imports the real component so
 * that what a test renders is what a build renders.
 *
 * THE TYPE IS NARROW ON PURPOSE. AstroComponentFactory is astro's own type for
 * a compiled component, so a value imported this way can be handed to the
 * container's renderToString() and to nothing else. What this declaration
 * deliberately does NOT do is describe a component's props: tsc cannot read a
 * `.astro` file's Props interface, so a props object passed from a test is
 * unchecked here. `astro check` still checks every `.astro` to `.astro` call
 * site with full prop types, so the coverage lost is exactly one narrow case,
 * a test's own props object, and stating that plainly is better than an `any`
 * that pretends nothing was lost.
 */
declare module '*.astro' {
  import type { AstroComponentFactory } from 'astro/runtime/server/index.js';

  const Component: AstroComponentFactory;
  export default Component;
}
