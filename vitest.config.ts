/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';

/** Astro's own Vite config, so a .astro component could be tested the same way the index does. */
export default getViteConfig({
  test: {
    include: ['{src,test}/**/*.test.{ts,mjs}']
  }
});
