---
paths:
  - "src/components/**/*.astro"
---
A dropdown that closes on `focusout` eats its own clicks in Safari and Firefox on
macOS: pressing a row moves focus before the click resolves, the panel closes, and
the click lands on nothing. Refuse the default on the row's `mousedown` so focus
never leaves the field.

This is a browser-behaviour bug, not a logic bug, so it passes every test that does
not use a real WebKit or Firefox engine. The sweep runs the interaction specs under
WebKit for exactly this reason. Firefox is not installed yet
(`npx playwright install firefox`).
