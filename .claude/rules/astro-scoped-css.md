---
paths:
  - "src/**/*.astro"
  - "src/styles/*.css"
---
Two rules about CSS in this codebase, both learned the hard way.

**A scoped rule always outranks a shared one.** Astro compiles a component's
`<style>` selector to `.thing[data-astro-cid-xxxx]` — specificity 0,2,0 — which
beats a plain `.thing` in `src/styles/global.css` (0,1,0) regardless of source
order. 241 of 1,472 class names in this repo are styled in more than one file. The
worst case is live: `.cta` is defined in `global.css:487` and redefined scoped in
`index.astro`, `how-it-works.astro`, `your-key.astro` and `upgrade.astro`, so
**editing the site's one button does nothing on those four pages.** Before changing
a shared class, grep for every file that declares it.

**A scoped rule never reaches an element built by script.** An element created by
`document.createElement` carries no `data-astro-cid` attribute, so the component's
own scoped styles do not apply to it. Style those from a global sheet or set the
attribute yourself.

`src/styles/tokens.css` and `src/styles/themes.css` are **build output** —
`style-dictionary` regenerates them from `tokens/*.json` on every `npm run dev`. A
hand-edit there disappears, which reads as "I fixed it and it came back".
