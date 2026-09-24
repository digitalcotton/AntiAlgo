---
paths:
  - "src/components/**/*.astro"
---
A dropdown that closes on `focusout` eats its own clicks in Safari and Firefox on
macOS: pressing a row moves focus before the click resolves, the panel closes, and
the click lands on nothing. Refuse the default on the row's `mousedown` so focus
never leaves the field.

This is a browser-behaviour bug, not a logic bug, so it passes every test that does
not use a real WebKit or Firefox engine. `test/sweep/controls.interaction.spec.ts`
runs under both `webkit-interactions` and `firefox-interactions`, and Firefox IS
installed as of 2026-09-24.

ONE MEASURED LIMIT: Playwright's Firefox automation did not reproduce this race even
with the guard removed by hand — its synthetic input does not order mousedown and
focusout the way a real trackpad press does. WebKit does reproduce it. So a green
Firefox run is not evidence about this specific bug, and the Firefox half of it still
wants a human check on real macOS.
