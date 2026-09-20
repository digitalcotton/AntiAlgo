/**
 * come-ready-store.ts: the impure half of Come ready (/start). Reads every
 * fact the step model in come-ready.ts is a function of, from the stores
 * that already own them (the Desk's home build for titles and lanes, the
 * keychain for keys, the record for entries, links, name and letter, the
 * parse buffer, the renders table, the added postings), and hands back one
 * view the page and its components render from. Nothing here writes, except
 * landing a finished resumé read into the record on the way in, exactly as
 * /profile does before it reads the record.
 */
import type { Viewer } from './entitlement';
import { db, isConfigured } from './db';
import { buildComeReady, editionFor, type ComeReady, type Edition } from './come-ready';
import { buildDeskHome, type DeskHomeData } from './desk-home';
import { getWritingModel, keyMeta } from './keychain-store';
import { keyStorageIsConfigured, type Provider } from './keychain';
import { GENERATION_PROVIDER_ORDER, PROVIDER_REGISTRY } from './generation-providers';
import { getCoverLetter, listEntries, listLinks, personName, type CoverLetterOnFile, type StoredEntry } from './record-store';
import type { StoredLink } from './profile-links';
import { getParse, type StoredParse } from './resume-parse-store';
import { landReadyParse, type AppliedProposals } from './resume-parse-apply';
import { listPostingFetches, type StoredPostingFetch } from './posting-fetch-store';
import { listWatches } from './ledger-watch-store';
import { isOn } from './flags';

export interface ConnectedKey {
  provider: Provider;
  /** The registry's display name, e.g. "Kimi (Moonshot AI)". */
  label: string;
  last4: string;
  addedAt: Date;
  /** Friendly model labels, resolved the way Settings resolves them. */
  writesWith: string;
  readsWith: string;
}

export interface ComeReadyTitle {
  title: string;
  /** Null when the sweep could not be read this request. */
  liveCount: number | null;
  titlesLive: number | null;
  titlesTotal: number | null;
}

export interface ComeReadyView {
  edition: Edition;
  model: ComeReady;
  /** The Desk's own build, or null when it could not be read (the page then
      shows the Desk's own warming-up words where the sweep would be). */
  home: DeskHomeData | null;
  coreTitles: ComeReadyTitle[];
  stretchTitles: string[];
  key: ConnectedKey | null;
  /** Whether keys can be stored on this deployment at all (byok on and the
      encryption secret set). */
  keysConfigured: boolean;
  entries: StoredEntry[];
  links: StoredLink[];
  nameSet: boolean;
  letter: CoverLetterOnFile | null;
  parse: StoredParse | null;
  /** A read that landed on this very load, with its counts. */
  landed: AppliedProposals | null;
  /** The most recent posting the member added by link, or null. */
  addedJob: StoredPostingFetch | null;
  /** When the account was created (the waitlist's "joined" date). */
  joinedAt: Date | null;
}

/** Whether this person has ever drafted for a posting: one render row with a
    job attached. The paid flow's completion signal. */
export async function hasAnyJobRender(userId: string): Promise<boolean> {
  const { rows } = await db().query('SELECT 1 FROM generated_render WHERE user_id = $1 AND job_id IS NOT NULL LIMIT 1', [userId]);
  return rows.length > 0;
}

async function joinedAtOf(userId: string): Promise<Date | null> {
  const { rows } = await db().query<{ created_at: Date }>('SELECT created_at FROM app_user_profile WHERE user_id = $1 LIMIT 1', [userId]);
  return rows[0]?.created_at ?? null;
}

/** The Desk's build, tried twice the way /desk tries it: a cold function can
    hit one transient connection error that a second attempt clears. */
async function deskHome(userId: string): Promise<DeskHomeData | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await buildDeskHome(userId);
    } catch (error) {
      console.error(`come-ready: Desk build attempt ${attempt + 1} failed.`, error);
    }
  }
  return null;
}

async function connectedKey(userId: string): Promise<ConnectedKey | null> {
  const rows = await keyMeta(userId);
  const row = GENERATION_PROVIDER_ORDER.map((id) => rows.find((r) => r.provider === id)).find((r) => r !== undefined) ?? null;
  if (!row) return null;
  const def = PROVIDER_REGISTRY[row.provider];
  const chosen = (await getWritingModel(userId, row.provider)) ?? def.defaultWritingModel;
  const writesWith = def.writingModels.find((m) => m.id === chosen)?.label ?? chosen;
  const readsWith = def.writingModels.find((m) => m.id === def.copyModel)?.label ?? def.copyModel;
  return { provider: row.provider, label: def.label, last4: row.last4, addedAt: row.createdAt, writesWith, readsWith };
}

export async function loadComeReady(viewer: Viewer, requested: string | null): Promise<ComeReadyView> {
  const edition = editionFor(viewer.tier);
  const userId = viewer.userId;
  const configured = isConfigured();
  const keysConfigured = isOn('byok') && keyStorageIsConfigured();

  const empty: ComeReadyView = {
    edition,
    model: buildComeReady({
      edition,
      emailVerified: viewer.emailVerified,
      coreTitles: [],
      key: null,
      entries: 0,
      links: 0,
      parsePending: false,
      letterOnFile: false,
      drafts: 0,
      addedJob: null,
      requested
    }),
    home: null,
    coreTitles: [],
    stretchTitles: [],
    key: null,
    keysConfigured,
    entries: [],
    links: [],
    nameSet: false,
    letter: null,
    parse: null,
    landed: null,
    addedJob: null,
    joinedAt: null
  };
  if (!configured) return empty;

  if (edition === 'waitlisted') {
    return { ...empty, joinedAt: await joinedAtOf(userId) };
  }

  // A finished read that is still in the buffer lands first, so the record
  // counts below include it (the same order /profile uses).
  const landed = edition === 'paid' ? await landReadyParse(userId) : null;

  const [home, watches, key, entries, links, name, letter, parse, drafts, fetches] = await Promise.all([
    deskHome(userId),
    listWatches(userId),
    edition === 'paid' && keysConfigured ? connectedKey(userId) : Promise.resolve(null),
    edition === 'paid' ? listEntries(userId) : Promise.resolve([] as StoredEntry[]),
    edition === 'paid' ? listLinks(userId) : Promise.resolve([] as StoredLink[]),
    edition === 'paid' ? personName(userId) : Promise.resolve(null),
    edition === 'paid' ? getCoverLetter(userId) : Promise.resolve(null),
    edition === 'paid' ? getParse(userId) : Promise.resolve(null),
    edition === 'paid' ? hasAnyJobRender(userId) : Promise.resolve(false),
    edition === 'free' && isOn('add_posting') ? listPostingFetches(userId) : Promise.resolve([] as StoredPostingFetch[])
  ]);

  // Titles: the Desk's measured view when the sweep read, else the watched
  // rows themselves with no counts claimed.
  const coreTitles: ComeReadyTitle[] = home
    ? home.coreTitles.map((t) => ({ title: t.title, liveCount: t.liveCount, titlesLive: t.titlesLive, titlesTotal: t.titlesTotal }))
    : watches.filter((w) => w.shelf === 'core').map((w) => ({ title: w.title, liveCount: null, titlesLive: null, titlesTotal: null }));
  const stretchTitles = home ? home.stretchTitles.map((t) => t.title) : watches.filter((w) => w.shelf === 'stretch').map((w) => w.title);

  const addedJob = fetches[0] ?? null;
  const nameSet = Boolean(name && (name.firstName || name.lastName));

  const model = buildComeReady({
    edition,
    emailVerified: viewer.emailVerified,
    coreTitles: coreTitles.map((t) => ({ title: t.title, liveCount: t.liveCount })),
    key: key ? { providerLabel: key.label, last4: key.last4 } : null,
    entries: entries.length,
    links: links.length,
    parsePending: parse?.status === 'pending',
    letterOnFile: letter !== null,
    drafts: drafts ? 1 : 0,
    addedJob: addedJob
      ? { title: addedJob.title ?? `A posting from ${hostOf(addedJob.url)}`, company: addedJob.company, fit: null }
      : null,
    requested
  });

  return {
    edition,
    model,
    home,
    coreTitles,
    stretchTitles,
    key,
    keysConfigured,
    entries,
    links,
    nameSet,
    letter,
    parse,
    landed,
    addedJob,
    joinedAt: null
  };
}

/** The hostname a member-added posting came from, the way its own page
    names it (added-posting.ts hostnameOf, without the www). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'the company site';
  } catch {
    return 'the company site';
  }
}
