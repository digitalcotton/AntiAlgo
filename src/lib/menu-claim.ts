/**
 * menu-claim.ts: one menu open at a time across the board's strip, written once.
 *
 * BROWSER ONLY. Imported by the <script> blocks of Filters.astro (the strip's
 * dropdowns and the Desk titles list) and SearchBox.astro (the suggestion
 * panel), never by a page's frontmatter: it touches `document` and nothing else,
 * and it opens no connection of its own.
 *
 * WHY IT EXISTS. The strip's menus and the search panel are drawn by two
 * scripts that never import each other. Each one closed the other's menu only
 * by accident: Filters.astro's document click handler returns early for any
 * click inside a `.filter` cell, and the search box lives in one, so a strip
 * menu stayed open under a panel the reader had just typed into. An event on
 * the document is the smallest thing both can speak without either owning the
 * other, and keeping its name and its two verbs here is what stops the pair
 * agreeing by convention only (.claude/rules/client-script-contracts.md).
 *
 * THE RULE, STATED ONCE. A menu that opens, or a field that takes focus to open
 * one, CLAIMS the menu slot under its own owner name. Every other owner hears
 * the claim and closes. The claimant never hears itself.
 */

/** Who can hold the one open slot. 'strip' is every dropdown in the filter row
    plus the Desk titles list; 'search' is the suggestion panel. */
export type MenuOwner = 'strip' | 'search';

/** The event's name, on `document`. Exported for the one test that proves both
    components use this module instead of spelling it twice. */
export const MENU_CLAIM_EVENT = 'antialgo:menu-claim';

/** Say that `owner` now holds the open slot. Everyone else closes. */
export function claimMenu(owner: MenuOwner): void {
  document.dispatchEvent(new CustomEvent<{ owner: MenuOwner }>(MENU_CLAIM_EVENT, { detail: { owner } }));
}

/** Run `release` whenever any owner other than `owner` claims the slot. */
export function onMenuClaimed(owner: MenuOwner, release: () => void): void {
  document.addEventListener(MENU_CLAIM_EVENT, (event) => {
    const claimant = (event as CustomEvent<{ owner: MenuOwner }>).detail?.owner;
    if (claimant !== owner) release();
  });
}
