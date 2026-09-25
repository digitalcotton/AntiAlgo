/**
 * posting-url-guard.ts: the check that runs before this site opens a socket to
 * a URL a member pasted.
 *
 * WHY THIS EXISTS. `docs/posting-fast-read-spec.md` moves the common case of
 * reading a pasted posting off the Mac mini and onto the site itself: the site
 * now calls out to whatever host is in the URL, inline, in the same request
 * that serves the member's page. That is new. Until this pass, the only thing
 * on this site that ever made an outbound HTTP call to an address a stranger
 * chose was the mini, over Tailscale, from a machine that holds no credential
 * but its own fetch secret. Now it is this server, and this server sits in
 * front of the same private network the mini does — including the mini
 * itself. A member who pastes `https://computersex2-mac-mini:11434/` (or its
 * Tailscale IP, or `169.254.x.x`, or a bare `10.x.x.x`) must not get the site
 * to ask that host anything, for the same reason the mini refuses to ask a
 * datacenter IP: an internet-facing service must not be a proxy into whatever
 * network it happens to run on.
 *
 * This module is a straight port of `postfetch.check_url` from the mini's
 * `postfetch.py`, which states its own rule this way: "https only; no IP
 * literals; no localhost, .local, .internal, .lan; every address the name
 * resolves to must be public, which refuses private ranges, loopback,
 * link-local, reserved, multicast and 100.64.0.0/10 (Tailscale's range, which
 * matters on this machine)." It matters here for the identical reason: the
 * Mac mini this site already talks to lives at a Tailscale address, and this
 * guard has to refuse that address by the same rule it refuses any other
 * internal one, not by special-casing the mini's own hostname.
 *
 * PURE ON PURPOSE, LIKE THE FILE IT PORTS. Nothing in this module opens a
 * socket. DNS resolution is the one real side effect a URL check needs, so it
 * is injected as `resolver`, exactly as `postfetch.py` injects its resolver so
 * `test_postfetch.py` runs offline. The default resolver below is the only
 * line in this file that touches the network; every test in
 * `posting-url-guard.test.ts` supplies its own fake instead.
 *
 * WHAT NODE'S URL PARSER BUYS US THAT `urlsplit` DID NOT. Python's
 * `urlsplit` is a syntactic splitter: it hands back whatever string sat
 * between `//` and the next `/`, unexamined. `ipaddress.ip_address(host)`
 * then either recognizes that string as an address in strict dotted-decimal
 * (or colon-hex) form, or it does not — an obfuscated literal like
 * `0x7f.0.0.1`, `2130706433`, or `0177.0.0.1` (all of which some `getaddrinfo`
 * implementations still resolve as 127.0.0.1) would sail past that check as
 * an ordinary-looking hostname. This module instead reads the host through
 * JavaScript's `URL`, whose WHATWG host-parsing algorithm actively
 * canonicalizes an IPv4 host — decimal, octal, hexadecimal, short form,
 * full-width digits, all of it — into plain dotted-decimal before
 * `.hostname` ever returns a value, and folds a dotted IPv4 tail embedded in
 * an IPv6 literal into the same hex-group form the rest of the address uses.
 * Confirmed by hand against this Node build: `new URL('https://2130706433/')
 * .hostname === '127.0.0.1'`, and `new URL('https://[::ffff:10.0.0.1]/')
 * .hostname === '[::ffff:a00:1]'`. That closes a whole bypass class for the
 * host string itself, for free, as a side effect of using a standards-grade
 * URL parser instead of a hand-rolled one. It buys us nothing for addresses a
 * DNS resolver hands back, though — those arrive as plain strings from
 * `dns/promises` or a test fake, never through `URL` — so the IPv4/IPv6
 * parsing below is written to be strict on its own, not to lean on that
 * up-front canonicalization a second time.
 *
 * NO `ipaddress` MODULE. Node has nothing built in that classifies an address
 * as private, loopback, link-local, reserved, multicast, or
 * Tailscale/CGNAT-range, for either address family, so that classification is
 * hand-written here as a list of CIDR blocks checked by prefix. The one
 * classification bug this file is written to specifically not have: an
 * IPv4-mapped IPv6 address (`::ffff:10.0.0.1`) or the older IPv4-compatible
 * form (`::10.0.0.1`, i.e. an all-zero top 80 or 96 bits) carries a real IPv4
 * address in its low 32 bits, and a check that only walks the IPv6 block list
 * without unwrapping that tail would call a private address "public" because
 * it never recognized the address family hiding inside it. `isPublicAddress`
 * below unwraps that tail and re-classifies it as IPv4 before doing anything
 * else, so `::ffff:10.0.0.1` is refused for exactly the reason `10.0.0.1` is.
 * One case that needed no special handling: Tailscale's own IPv6 range
 * (`fd7a:115c:a1e0::/48`) already sits inside `fc00::/7`, the unique-local
 * block this guard blocks outright, so unlike the IPv4 side — where
 * `100.64.0.0/10` is carrier-grade NAT space that sits *outside* every
 * RFC1918 private range and has to be listed on its own, exactly as
 * `postfetch.py`'s `TAILSCALE` constant does — no separate IPv6 Tailscale
 * entry was needed here. That is also why this port keeps the Python
 * original's asymmetry of checking the Tailscale range for IPv4 addresses
 * only: an IPv6 address never needs that extra check to be caught.
 *
 * THE RESIDUAL RISK, CARRIED OVER HONESTLY. `postfetch.py` states it plainly:
 * "the guard resolves the name before the fetch and cannot pin the socket to
 * the address it checked, so a DNS answer that changes inside the timeout
 * window is not caught" — a DNS-rebinding TOCTOU gap, because neither
 * `dns/promises` nor `fetch` gives this codebase a way to resolve once and
 * dial that exact address. `postfetch.py` accepts this because the mini holds
 * no credential but its own fetch secret, and whatever a rebound fetch yields
 * is bytes the site sanitises anyway. The same acceptance holds here, for the
 * same reason: this server holds no credential a rebound target could steal
 * by being fetched, and `docs/posting-fast-read-spec.md` is explicit that
 * "bytes from a page on the internet are untrusted whether the mini fetched
 * them or we did" — `sanitizeCrawledHtml()` in `description.ts` runs on
 * whatever comes back regardless of which address answered. What this guard
 * defends is the request itself (do not let this server be aimed at an
 * internal host), not the honesty of the response, and it does that fully.
 *
 * WHAT THIS MODULE DOES NOT DO. It checks one URL. `docs/posting-fast-read-
 * spec.md` calls for the guard to "re-run on every redirect hop" once
 * `resolvePosting()`/`extractPosting()` exist to follow one — that loop
 * belongs to whichever module walks the redirect chain, not to this one,
 * which only ever sees the URL it is handed.
 */
import { lookup } from 'node:dns/promises';
import type { FailureCode } from './posting-fetch-store';

const REFUSED: FailureCode = 'refused_url';

/** Mirrors `postfetch.py`'s BLOCKED_HOST_SUFFIXES exactly: host shapes that
    are never worth a DNS lookup because they name this machine or a machine
    on its own private segment by construction, not by what an address
    happens to resolve to. */
const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.lan', '.localhost', '.home', '.arpa'] as const;

/**
 * IPv4 ranges that are never a legitimate fetch target for a member-pasted
 * URL: RFC 1918 private space, loopback, link-local, the IANA special-purpose
 * and documentation/benchmark ranges, multicast, reserved Class E, and
 * `100.64.0.0/10` — carrier-grade NAT space that is also the range Tailscale
 * hands out addresses from, named on its own here exactly as `TAILSCALE` is
 * named on its own in `postfetch.py`, because it sits outside every RFC 1918
 * block and a check that only knew RFC 1918 would miss it.
 */
const BLOCKED_IPV4_RANGES = [
  '0.0.0.0/8', // "this network" / unspecified
  '10.0.0.0/8', // private
  '100.64.0.0/10', // carrier-grade NAT / Tailscale
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // documentation (TEST-NET-1)
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // documentation (TEST-NET-2)
  '203.0.113.0/24', // documentation (TEST-NET-3)
  '224.0.0.0/4', // multicast
  '240.0.0.0/4' // reserved Class E, including the 255.255.255.255 broadcast address
] as const;

/**
 * IPv6 ranges that are never a legitimate fetch target, checked once an
 * address has been confirmed not to be an IPv4-mapped or IPv4-compatible
 * address in disguise (see `isPublicAddress`).
 */
const BLOCKED_IPV6_RANGES = [
  '::/128', // unspecified
  '::1/128', // loopback
  '100::/64', // discard-only prefix
  '2001::/23', // IETF protocol assignments
  '2001:2::/48', // benchmarking
  '2001:db8::/32', // documentation
  'fc00::/7', // unique local (private) -- also covers Tailscale's IPv6 range
  'fe80::/10', // link-local
  'ff00::/8' // multicast
] as const;

/** A strict dotted-decimal IPv4 address as four 0-255 octets, or null. No
    leading zeros (an octet is either "0" or has no leading zero), so this
    never disagrees with what `new URL()` would have already canonicalized a
    host into -- it exists mainly to classify addresses a DNS resolver hands
    back, which never pass through a URL parser at all. */
function parseIPv4(input: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(input.trim());
  if (!match) return null;
  const octets: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const text = match[i];
    if (text.length > 1 && text.startsWith('0')) return null;
    const value = Number(text);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** An IPv6 address as eight 16-bit groups, or null. Handles "::" compression
    and an embedded IPv4 tail in either the modern mapped form
    (`::ffff:10.0.0.1`) or the deprecated compatible form (`::10.0.0.1`),
    converting that tail into two hex groups before parsing the rest, since
    that is the one shape a naive group-by-group hex parser would reject or
    silently mis-classify. */
function parseIPv6(input: string): number[] | null {
  let text = input.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zoneIndex = text.indexOf('%');
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);
  if (text.length === 0) return null;

  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const embedded = parseIPv4(text.slice(lastColon + 1));
    if (!embedded) return null;
    const hi = ((embedded[0] << 8) | embedded[1]).toString(16);
    const lo = ((embedded[2] << 8) | embedded[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColonCount = (text.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;
  const hasDoubleColon = doubleColonCount === 1;

  const parseGroup = (group: string): number | null =>
    /^[0-9a-fA-F]{1,4}$/.test(group) ? parseInt(group, 16) : null;

  if (hasDoubleColon) {
    const [leftText, rightText] = text.split('::');
    const leftGroups = leftText ? leftText.split(':') : [];
    const rightGroups = rightText ? rightText.split(':') : [];
    const left = leftGroups.map(parseGroup);
    const right = rightGroups.map(parseGroup);
    if (left.some((n) => n === null) || right.some((n) => n === null)) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    return [...(left as number[]), ...Array(missing).fill(0), ...(right as number[])];
  }

  const groups = text.split(':').map(parseGroup);
  if (groups.length !== 8 || groups.some((n) => n === null)) return null;
  return groups as number[];
}

function ipv4ToInt(octets: number[]): number {
  return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

function inIPv4Range(octets: number[], cidr: string): boolean {
  const [base, lengthText] = cidr.split('/');
  const length = Number(lengthText);
  const mask = length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0;
  return (ipv4ToInt(octets) & mask) === (ipv4ToInt(parseIPv4(base) as number[]) & mask);
}

function inIPv6Range(groups: number[], cidr: string): boolean {
  const [base, lengthText] = cidr.split('/');
  const baseGroups = parseIPv6(base) as number[];
  let bitsLeft = Number(lengthText);
  for (let i = 0; i < 8; i++) {
    if (bitsLeft <= 0) break;
    const bits = Math.min(16, bitsLeft);
    const mask = bits === 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((groups[i] & mask) !== (baseGroups[i] & mask)) return false;
    bitsLeft -= bits;
  }
  return true;
}

function isPublicIPv4(octets: number[]): boolean {
  return !BLOCKED_IPV4_RANGES.some((range) => inIPv4Range(octets, range));
}

/** True when a resolved address is safe to fetch: not private, loopback,
    link-local, reserved, multicast, unspecified, or in the Tailscale/CGNAT
    range, for either address family, and not an IPv6 address that carries one
    of those same IPv4 addresses wrapped in a mapped or compatible form. */
function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isPublicIPv4(v4);

  const v6 = parseIPv6(address);
  if (!v6) return false; // not a recognizable address at all: never call that public

  // An IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) address
  // carries its real address in the low 32 bits. Unwrap and re-classify as
  // IPv4 rather than walking the IPv6 block list, which knows nothing about
  // an address family hiding inside it.
  if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && (v6[5] === 0 || v6[5] === 0xffff)) {
    const embedded = [(v6[6] >> 8) & 0xff, v6[6] & 0xff, (v6[7] >> 8) & 0xff, v6[7] & 0xff];
    return isPublicIPv4(embedded);
  }

  return !BLOCKED_IPV6_RANGES.some((range) => inIPv6Range(v6, range));
}

/** Resolves a hostname to every address it answers with, the way
    `postfetch.py`'s default resolver calls `socket.getaddrinfo` and collects
    every result rather than just the first. `dns/promises`' `lookup` with
    `{ all: true }` is the direct Node equivalent. */
async function defaultResolver(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((record) => record.address);
}

/**
 * None (returned as `null`) when `url` may be fetched; a `FailureCode`
 * otherwise. `resolver` defaults to a real DNS lookup and is the seam every
 * test in `posting-url-guard.test.ts` overrides, so no test here opens a
 * socket.
 */
export async function guardPostingUrl(
  url: string,
  resolver: (host: string) => Promise<string[]> = defaultResolver
): Promise<FailureCode | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return REFUSED;
  }
  if (parsed.protocol !== 'https:') return REFUSED;

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host || host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return REFUSED;
  }
  if (parseIPv4(host) || parseIPv6(host)) return REFUSED; // an IP literal, never

  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    return REFUSED;
  }
  if (!addresses || addresses.length === 0) return REFUSED;

  for (const address of addresses) {
    if (!isPublicAddress(address)) return REFUSED;
  }
  return null;
}
