/**
 * The edition key and the flag registry, written once.
 *
 * A plain .mjs at the root, the same reason site.config.mjs is one: several
 * consumers (astro.config.mjs, src/lib/*.ts under Vite, Node scripts, tests)
 * have to agree about these values and none can import the others' language.
 * src/lib/flags.ts re-exports these with types for the TypeScript callers; it
 * adds no logic of its own.
 *
 * MERGED FROM TWO REGISTRIES. AntiAlgo defined only `waitlist` (this repo's
 * own signup-tier gate). The Index defined the rest, for its own seeker wall
 * (`desk`, `profile`, `tailor`, `prelist`, …) and its dark-by-default rollout
 * flags (`prelist_paid`, `profiles_public`, `nav_public`, …). Both sets are
 * real, in force, and now live in one file since the board moved into this
 * repo. `stripe` (Phase 6) was added dark in both editions: the billing lib,
 * checkout route, webhook route and upgrade page all exist in the codebase
 * but are unreachable — see FLAGGED_ROUTES below — until this is flipped on.
 *
 * ONE CODEBASE, TWO EDITIONS. `design` is the product as shipped: the
 * filtered index plus the seeker wall (Desk, Tailor, Profile Record,
 * Pre-List, personalized digest) behind sign-in, plus AntiAlgo's waitlist
 * gate in front of all of it. `broad` is the unfiltered index, out of scope
 * for this run. Only `design` deploys.
 */

export const EDITIONS = ['design', 'broad'];
export const DEFAULT_EDITION = 'design';

/**
 * Which edition this build or request is running as.
 *
 * Reads process.env.SITE_EDITION. Unset is the common case and returns
 * DEFAULT_EDITION rather than requiring the variable everywhere it is
 * imported.
 *
 * SET TO SOMETHING NOT IN EDITIONS, THIS THROWS RATHER THAN FALLING BACK. A
 * typo in the variable must not silently resolve to `design` and deploy
 * looking correct.
 */
export function edition() {
  const raw = process.env.SITE_EDITION;
  if (raw === undefined) return DEFAULT_EDITION;
  if (!EDITIONS.includes(raw)) {
    throw new Error(
      `flags: SITE_EDITION is set to '${raw}', which is not a legal edition. ` +
        `Legal values are ${EDITIONS.join(', ')}. An unrecognised edition must never ` +
        `silently fall back to the default: that would deploy the wrong feature set ` +
        `and every gate would still pass.`
    );
  }
  return raw;
}

/**
 * THE FLAG REGISTRY. The only place a flag's per-edition state is written
 * down. `why` is the citation a later reader needs to change the value
 * without guessing at the reasoning that set it.
 */
export const FLAGS = {
  // OFF in both editions (owner decision, 2026-09-20): the kill list is held
  // back. While off, /kills and everything under it (the share cards and
  // their social images) are dark: the page 404s through FLAGGED_ROUTES, the
  // card routes build no paths, the sitemap skips them, and every link into
  // the list (the tiles' captions, the report's method link, the not-here
  // coda, the Drop's notes) is left out. Flip on to bring the whole set back
  // in one edit.
  kill_list: {
    why:
      'The kill list is held back until it is ready to be a product surface. While off, /kills ' +
      'is a flat 404, no kill share card is built, and no page links into it.',
    editions: { design: false, broad: false }
  },
  // --- AntiAlgo's own flag ---
  waitlist: {
    why:
      'While on, a new account is created at the waitlisted tier instead of DEFAULT_TIER ' +
      '(tiers.config.mjs), and a waitlisted account hitting a member route is sent to the one ' +
      'waitlist page. While off, sign-up behaves exactly as the index does today: a new account ' +
      'is a member. Existing accounts are untouched either way; the flag is read once, at ' +
      'account creation, and never again. Turning it off is the whole migration.',
    editions: { design: true, broad: true }
  },

  // OFF for now: during the pre-launch waitlist nobody is admitted yet, so the
  // sign-in page is held closed and the header's Sign in button is hidden. The
  // page itself is kept intact (src/pages/sign-in.astro), and while the flag is
  // off it redirects a would-be sign-in to the Save my spot flow. Flip this on
  // the day the first admissions go out, so admitted members can sign in.
  signin: {
    why:
      'While off, /sign-in redirects to the Save my spot (sign-up) flow and the header hides its ' +
      'Sign in button, because in the waitlist phase there are no admitted members to sign in yet. ' +
      'Turn on alongside the first batch admission (see scripts/admit.mjs) so members can log in.',
    editions: { design: false, broad: false }
  },

  // --- The Index's flags, copied in as-is (they still govern the same board
  // code, now running in this repo) ---
  add_posting: {
    why:
      'Add a job: a member pastes a job URL, the Mac mini reads it, the posting page drafts for it. ' +
      'One flag covers the Desk intent and the two machine routes under /machine, so turning it off ' +
      'makes the machine routes a flat 404 and hides the button in the same edit.',
    editions: { design: true, broad: true }
  },
  desk: {
    why: 'The seeker command center is the core of the wall RUN-MASTER section 5 puts behind sign-in.',
    editions: { design: true, broad: true }
  },
  profile: {
    why: 'The Profile Record is the seeker data behind sign-in, per the wall.',
    editions: { design: true, broad: true }
  },
  tailor: {
    why: 'The Tailor is a signed-in seeker feature per the wall and RUN-MASTER section 2, item 3.',
    editions: { design: true, broad: true }
  },
  prelist: {
    why: 'Pre-List browsing is public; the flag covers the follow feature the wall gates to sign-in.',
    editions: { design: true, broad: true }
  },
  digest_personal: {
    why: 'The personalized digest is a signed-in seeker feature per the wall; the generic digest signup stays public.',
    editions: { design: true, broad: true }
  },
  sponsor_slot: {
    why: 'MONETIZATION rails ship this run without a checkout, per RUN-MASTER section 2, item 2.',
    editions: { design: true, broad: true }
  },
  data_page: {
    why: 'The /data page is a public surface RUN-MASTER section 2, item 4 names for this run.',
    editions: { design: true, broad: true }
  },
  covenant_page: {
    why: 'The covenant page is a public surface RUN-MASTER section 2, item 4 names for this run.',
    editions: { design: true, broad: true }
  },
  byok: {
    why:
      'MASTER-SPEC D7. The kill switch over bring-your-own-key generation, and the only ' +
      'thing that can turn the whole feature off without a deploy. Lit in both editions ' +
      'because the feature is per-user dark by construction: a person with no key on file ' +
      'reaches no provider, and src/lib/provider.ts deterministicProvider stays the default ' +
      'and the fallback on any failure. This flag exists for the case that construction does ' +
      'not cover, a provider behaving badly for everyone at once, where the answer has to be ' +
      'one value changed rather than a page rewritten.',
    editions: { design: true, broad: true }
  },
  board_actions: {
    why:
      'The board detail page (/board/[slug]) carries the same feed-the-Desk track control the ' +
      "/role page does. Lit in both editions and ON by default, so this is the kill switch the " +
      'beta owner flips to remove that control from the board detail surface without a deploy.',
    editions: { design: true, broad: true }
  },
  onboarding: {
    why:
      'The guided first run on /profile: a short checklist that turns the sign-up dead end into ' +
      'a path. Lit in both editions and ON by default; the kill switch removes the guidance ' +
      'without a deploy.',
    editions: { design: true, broad: true }
  },
  analytics: {
    why:
      'First-party funnel analytics (db/028_analytics_event.sql, src/lib/analytics.ts). Lit in ' +
      'both editions and ON by default; the kill switch stops recording without a deploy.',
    editions: { design: true, broad: true }
  },
  email_send: {
    why:
      "The scheduled confirm-loop nudge, sent from src/pages/tasks/nudge.ts on a Vercel cron. " +
      'Kept OFF here: AntiAlgo has no sender wired (RESEND_API_KEY unset, email verification ' +
      'off per this repo\'s own posture), so this stays dark in both editions until email ships.',
    editions: { design: false, broad: false }
  },
  prelist_paid: {
    why:
      'RUN-FINISH 3.1: the Pre-List goes behind sign-in and a paid tier flag is built dark ' +
      'beside it. Nothing charges anyone yet (Stripe billing is a later phase, flag-gated off), ' +
      'so this is a wall and a flag, not a price.',
    editions: { design: false, broad: false }
  },
  profiles_public: {
    why: 'F8 public profiles ship built, but visibility is locked to private-only; anything above private stays flag-dark.',
    editions: { design: false, broad: false }
  },
  repost_biography: {
    why: 'repost_count is not in the published files and the machine is frozen. The site renders nothing it computes speculatively from data it does not hold.',
    editions: { design: false, broad: false }
  },
  nav_public: {
    why:
      'The job index dropdown shows a signed-out reader the board and nothing else; other links ' +
      'render hidden until a signed-in session reveals them. Dark in both editions.',
    editions: { design: false, broad: false }
  },
  prelist_tab_public: {
    why:
      'The Board / Newly funded switch above the board is a signed-in control, since the Pre-List ' +
      'behind it is already walled to sign-in. Dark in both editions.',
    editions: { design: false, broad: false }
  },
  fit_public: {
    why:
      'The fit score, its why panel, the Fit sort and the fit reasoning on a posting are a ' +
      'signed-in feature, like drafting. Dark in both editions.',
    editions: { design: false, broad: false }
  },

  // --- Phase 6: Stripe billing, wired but dark ---
  stripe: {
    why:
      'Stripe subscription billing for the $7.25/month membership (src/lib/billing.ts, ' +
      'src/pages/billing/checkout.ts, src/pages/billing/webhook.ts, src/pages/upgrade.astro). ' +
      'OFF in both editions: no Stripe account has been connected and no real keys exist in this ' +
      'environment, so STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET/STRIPE_PRICE_ID are unset and ' +
      'billing.ts would throw if it were ever called. The flag makes that moot — FLAGGED_ROUTES ' +
      'below sends /upgrade and everything under /billing to a flat 404, before any handler runs, ' +
      'so nothing is reachable and nothing can charge a card. The webhook only ever moves a tier ' +
      'between member and paid; no ROUTE_POLICY entry requires the paid tier yet, so turning this ' +
      'on someday grants the ability to buy the tier, not access to anything new by itself.',
    editions: { design: false, broad: false }
  }
};

/**
 * Whether a flag is on for an edition. Defaults to the current edition() so a
 * caller checking "is this on" rarely has to pass one.
 *
 * THROWS ON A FLAG NAME NOT IN FLAGS, on purpose. A typo must not read as
 * "off": an off flag is invisible by design, so a silently-off feature from a
 * typo would look identical to a feature correctly gated dark.
 */
export function isOn(flag, ed = edition()) {
  const entry = FLAGS[flag];
  if (!entry) {
    throw new Error(
      `flags: '${flag}' is not a registered flag. Legal names are ${Object.keys(FLAGS).join(', ')}. ` +
        `A typo here must not read as off: an off flag is invisible, so a mistyped one would look ` +
        `identical to a feature correctly gated dark.`
    );
  }
  return entry.editions[ed];
}

/**
 * Route prefixes that are behind a flag, base-free (keys like '/desk', not
 * '/board/desk'), for the same reason entitlement.ts's ROUTE_POLICY is
 * base-free: this stays a pure function of a path, testable with no request,
 * and src/middleware.ts strips the base before a pathname ever reaches
 * flagForRoute() or routeIsLit(). Copied from the Index's registry — these
 * are the routes actually built with `export const prerender = false`, so a
 * flag checked in middleware can gate them (see test/route-census.mjs's
 * assertion in the Index for why a build-time page cannot be gated this way).
 */
/** @type {Record<string, any>} */
export const FLAGGED_ROUTES = {
  // src/pages/kills/index.astro carries `export const prerender = false` so
  // this 404 is decided per request; the card routes under it are prerendered
  // and build no paths while the flag is off (see their getStaticPaths).
  '/kills': 'kill_list',
  // The two machine routes are called by the Mac mini with a shared secret,
  // never by a browser. Dark flag, flat 404.
  '/machine': 'add_posting',
  // src/pages/desk.astro (the titles home), desk/save.ts and
  // desk/application.ts all carry `export const prerender = false`.
  // Longest-prefix matching in flagForRoute() below covers all with this entry.
  '/desk': 'desk',
  // /opportunities is the applications tracker (formerly The Desk at /desk); it
  // rides the same `desk` flag so the tracker and the machine that feeds it turn
  // dark together, exactly as when it lived at /desk.
  '/opportunities': 'desk',
  // The flag is `prelist`, not `prelist_paid`. The dark one is the tier, and
  // a tier is not a door: gating the whole surface on it would wall the
  // Pre-List behind a payment nobody can make. Sign-in gates the rows, in
  // entitlement.ts where the other walls do.
  '/prelist': 'prelist',
  // src/pages/tasks/nudge.ts is a scheduled endpoint, never a static page.
  // Flipping email_send off 404s the cron target.
  '/tasks': 'email_send',
  // src/pages/upgrade.astro explains the $7.25/month membership and posts to
  // /billing/checkout. Dark flag, flat 404, so the pitch and the button are
  // both gone rather than a live page with a dead button.
  '/upgrade': 'stripe',
  // src/pages/billing/checkout.ts and src/pages/billing/webhook.ts both carry
  // `export const prerender = false`. One entry covers both by prefix, same
  // as '/desk' covers desk/save.ts, desk/application.ts, etc. above.
  '/billing': 'stripe'
};

function normaliseRoute(pathname) {
  if (!pathname.startsWith('/')) return '/';
  // Trailing slash never changes which flag applies, for the same reason
  // entitlement.ts's normalise() strips one: a stray slash must not open a
  // door a flag was meant to keep dark.
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return trimmed || '/';
}

/**
 * Longest-prefix match against FLAGGED_ROUTES. Returns the flag name, or null
 * when the path carries no flag at all (the common case for public content).
 */
export function flagForRoute(path) {
  const normalised = normaliseRoute(path);
  let best = null;
  for (const [prefix, flag] of Object.entries(FLAGGED_ROUTES)) {
    if (normalised === prefix || normalised.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, flag };
    }
  }
  return best ? best.flag : null;
}

/**
 * The pure decision function: is this path lit for this edition?
 *
 * True when the path carries no flag (public content is not gated by
 * anything in this file), or when the flag it carries is on. False only when
 * the path is under a flag that is off for this edition.
 */
export function routeIsLit(path, ed = edition()) {
  const flag = flagForRoute(path);
  if (flag === null) return true;
  return isOn(flag, ed);
}
