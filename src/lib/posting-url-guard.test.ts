/**
 * posting-url-guard.test.ts: every fake resolver here is the whole point --
 * no test in this file may resolve a real name or open a real socket, the
 * same discipline `test_postfetch.py` states in its own header. Guard cases
 * are ported one-for-one from `test_postfetch.py`'s `Guard` class where the
 * two URL parsers agree on what a host even is, plus the cases that class
 * could not have needed: JavaScript's `URL` canonicalizes an obfuscated IPv4
 * literal (octal, decimal, hex) into plain dotted-decimal before this module
 * ever sees it, so this file proves that closes rather than opens a gap, and
 * it drives the hand-written IPv4/IPv6 classifier (there is no `ipaddress`
 * module here) hard enough to catch an IPv4-mapped or IPv4-compatible IPv6
 * address smuggling a private v4 address through in its low 32 bits.
 */
import { describe, expect, it } from 'vitest';
import { guardPostingUrl } from './posting-url-guard';

/** Always answers with one public address, the way `test_postfetch.py`'s own
    `public()` fixture does. */
const publicResolver = async () => ['93.184.216.34'];

/** Answers with whichever single address the test names. */
const resolvesTo = (address: string) => async () => [address];

describe('guardPostingUrl: the obvious refusals (ported from test_postfetch.Guard.test_refuses_the_obvious)', () => {
  it.each([
    ['http://example.com/x', 'not https'],
    ['ftp://example.com/', 'not https'],
    ['https://127.0.0.1/', 'an IPv4 literal host'],
    ['https://10.0.0.5/j', 'an IPv4 literal host'],
    ['https://localhost/', 'the bare name localhost'],
    ['https://mini.local/x', 'a .local suffix'],
    ['https://[::1]/', 'an IPv6 literal host']
  ])('refuses %s (%s)', async (url) => {
    expect(await guardPostingUrl(url, publicResolver)).toBe('refused_url');
  });

  it('refuses a URL that fails to parse at all', async () => {
    expect(await guardPostingUrl('not a url', publicResolver)).toBe('refused_url');
  });
});

describe('guardPostingUrl: every blocked host suffix, not just .local', () => {
  it.each(['.local', '.internal', '.lan', '.localhost', '.home', '.arpa'])(
    'refuses a host ending %s',
    async (suffix) => {
      expect(await guardPostingUrl(`https://box${suffix}/x`, publicResolver)).toBe('refused_url');
    }
  );
});

describe('guardPostingUrl: names that resolve inside (ported from test_refuses_names_that_resolve_inside)', () => {
  it.each([
    ['10.1.2.3', 'RFC 1918 private'],
    ['192.168.1.133', 'RFC 1918 private'],
    ['172.16.0.9', 'RFC 1918 private'],
    ['127.0.0.2', 'loopback, not just 127.0.0.1'],
    ['169.254.1.1', 'link-local'],
    ['100.102.11.23', 'Tailscale / carrier-grade NAT range'],
    ['fe80::1', 'IPv6 link-local'],
    ['::1', 'IPv6 loopback'],
    ['0.0.0.0', 'unspecified']
  ])('refuses a public-looking name that resolves to %s (%s)', async (address) => {
    expect(await guardPostingUrl('https://example.com/j', resolvesTo(address))).toBe('refused_url');
  });
});

describe('guardPostingUrl: allows a genuinely public name (ported from test_allows_a_public_name)', () => {
  it('allows a board host that resolves publicly', async () => {
    expect(await guardPostingUrl('https://boards.greenhouse.io/brex/jobs/1', publicResolver)).toBeNull();
  });

  it('refuses when the resolver itself throws', async () => {
    const throws = async () => {
      throw new Error('dns');
    };
    expect(await guardPostingUrl('https://example.com/', throws)).toBe('refused_url');
  });

  it('refuses when the resolver answers with nothing', async () => {
    const empty = async () => [];
    expect(await guardPostingUrl('https://example.com/', empty)).toBe('refused_url');
  });
});

describe('guardPostingUrl: obfuscated IPv4 literals, which a raw urlsplit host would miss', () => {
  it.each([
    ['https://2130706433/', 'decimal'],
    ['https://0x7f.0.0.1/', 'hex octet'],
    ['https://0x7f000001/', 'hex whole address'],
    ['https://017700000001/', 'octal'],
    ['https://0177.0.0.1/', 'octal octet'],
    ['https://127.1/', 'short form (inet_aton style)']
  ])('refuses %s (%s) because URL canonicalizes it to a loopback literal', async (url) => {
    expect(await guardPostingUrl(url, publicResolver)).toBe('refused_url');
  });
});

describe('guardPostingUrl: IPv4-mapped and IPv4-compatible IPv6 addresses are unwrapped, not trusted as-is', () => {
  it('refuses a resolved address that is a private IPv4 address mapped into IPv6', async () => {
    expect(await guardPostingUrl('https://example.com/', resolvesTo('::ffff:10.0.0.1'))).toBe('refused_url');
  });

  it('refuses the same address in its compressed hex form, as a real resolver would return it', async () => {
    // "::ffff:10.0.0.1" and "::ffff:a00:1" are the same address; a resolver
    // is free to hand back either spelling.
    expect(await guardPostingUrl('https://example.com/', resolvesTo('::ffff:a00:1'))).toBe('refused_url');
  });

  it('refuses a loopback address using the deprecated IPv4-compatible IPv6 form', async () => {
    expect(await guardPostingUrl('https://example.com/', resolvesTo('::127.0.0.1'))).toBe('refused_url');
  });

  it('refuses a Tailscale-range address mapped into IPv6', async () => {
    expect(await guardPostingUrl('https://example.com/', resolvesTo('::ffff:100.64.1.2'))).toBe('refused_url');
  });

  it('still allows a public IPv4 address that merely happens to arrive mapped into IPv6', async () => {
    expect(await guardPostingUrl('https://example.com/', resolvesTo('::ffff:93.184.216.34'))).toBeNull();
  });

  it('an IPv6-literal host using the mapped form is refused before any resolution happens', async () => {
    expect(await guardPostingUrl('https://[::ffff:10.0.0.1]/', publicResolver)).toBe('refused_url');
  });
});

describe('guardPostingUrl: IPv6 ranges beyond loopback and link-local', () => {
  it.each([
    ['fc00::1', 'unique local (private)'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation range'],
    ['::', 'unspecified']
  ])('refuses a resolved address of %s (%s)', async (address) => {
    expect(await guardPostingUrl('https://example.com/', resolvesTo(address))).toBe('refused_url');
  });

  it('allows a genuinely public IPv6 address', async () => {
    expect(await guardPostingUrl('https://example.com/', resolvesTo('2606:4700:4700::1111'))).toBeNull();
  });
});

describe('guardPostingUrl: one bad address among several sinks the whole host', () => {
  it('refuses when only one of several resolved addresses is internal', async () => {
    const mixed = async () => ['93.184.216.34', '10.0.0.9'];
    expect(await guardPostingUrl('https://example.com/', mixed)).toBe('refused_url');
  });

  it('allows when every resolved address is public', async () => {
    const allPublic = async () => ['93.184.216.34', '2606:4700:4700::1111'];
    expect(await guardPostingUrl('https://example.com/', allPublic)).toBeNull();
  });
});

describe('guardPostingUrl: host normalization matches postfetch.py (lowercase, trailing dot, uppercase scheme)', () => {
  it('allows a mixed-case host and an uppercase scheme', async () => {
    expect(await guardPostingUrl('HTTPS://Boards.Greenhouse.IO/brex/jobs/1', publicResolver)).toBeNull();
  });

  it('allows a host written with a trailing dot', async () => {
    expect(await guardPostingUrl('https://boards.greenhouse.io./brex/jobs/1', publicResolver)).toBeNull();
  });

  it('still refuses a trailing-dot host that names a blocked suffix', async () => {
    expect(await guardPostingUrl('https://mini.local./x', publicResolver)).toBe('refused_url');
  });
});
