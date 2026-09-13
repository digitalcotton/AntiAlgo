import { describe, expect, it } from 'vitest';
import {
  LINK_PLATFORMS,
  LINK_PLATFORM_IDS,
  detectPlatform,
  isLinkPlatform,
  linkPlatformLabel,
  normaliseLinkUrl
} from './profile-links';

describe('detectPlatform: the platform is read off the hostname, not typed', () => {
  it('names the known platforms, subdomains included', () => {
    expect(detectPlatform('linkedin.com')).toBe('linkedin');
    expect(detectPlatform('www.linkedin.com')).toBe('linkedin');
    expect(detectPlatform('github.com')).toBe('github');
    expect(detectPlatform('gist.github.com')).toBe('github');
    expect(detectPlatform('x.com')).toBe('twitter');
    expect(detectPlatform('twitter.com')).toBe('twitter');
    expect(detectPlatform('bsky.app')).toBe('bluesky');
    expect(detectPlatform('dribbble.com')).toBe('dribbble');
    expect(detectPlatform('behance.net')).toBe('behance');
  });

  it('falls back to website for anything it does not recognise', () => {
    expect(detectPlatform('example.com')).toBe('website');
    expect(detectPlatform('some-portfolio.dev')).toBe('website');
  });

  it('normaliseLinkUrl detects the platform from a full url', () => {
    const result = normaliseLinkUrl('https://www.linkedin.com/in/rowan');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.platform).toBe('linkedin');
  });
});

// profile-links.ts is the pure half of a person's job-related links. The one
// decision worth guarding hard is normaliseLinkUrl(): the profile page renders
// a stored URL back as an <a href>, so a value like javascript: or data: that
// slipped through would be a script-execution vector. These tests pin the
// scheme refusal that keeps that from happening, alongside the ordinary
// accept/normalise behaviour.

describe('normaliseLinkUrl: accepts and normalises real web links', () => {
  it('keeps a full https URL as-is', () => {
    const result = normaliseLinkUrl('https://github.com/rowan');
    expect(result).toEqual({ ok: true, url: 'https://github.com/rowan', platform: 'github' });
  });

  it('keeps a full http URL as-is (http is allowed, not only https)', () => {
    const result = normaliseLinkUrl('http://example.com/portfolio');
    expect(result.ok).toBe(true);
  });

  it('reads a scheme-less string as https, the way an address bar does', () => {
    const result = normaliseLinkUrl('github.com/rowan');
    expect(result).toEqual({ ok: true, url: 'https://github.com/rowan', platform: 'github' });
  });

  it('trims surrounding whitespace before parsing', () => {
    const result = normaliseLinkUrl('   https://dribbble.com/rowan   ');
    expect(result).toEqual({ ok: true, url: 'https://dribbble.com/rowan', platform: 'dribbble' });
  });
});

describe('normaliseLinkUrl: refuses anything that is not an http(s) web link', () => {
  it('refuses a javascript: URL, and does not turn it into https://javascript:', () => {
    const result = normaliseLinkUrl('javascript:alert(1)');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('http');
  });

  it('refuses a data: URL', () => {
    expect(normaliseLinkUrl('data:text/html,<script>alert(1)</script>').ok).toBe(false);
  });

  it('refuses a scheme it does not allow, like ftp', () => {
    expect(normaliseLinkUrl('ftp://files.example.com').ok).toBe(false);
  });

  it('refuses an empty string and a whitespace-only string', () => {
    expect(normaliseLinkUrl('').ok).toBe(false);
    expect(normaliseLinkUrl('    ').ok).toBe(false);
  });

  it('refuses something that cannot parse as a web address', () => {
    // A space in the host makes this unparseable even after the https prefix.
    expect(normaliseLinkUrl('not a real address').ok).toBe(false);
  });

  it('refuses a URL past the length cap', () => {
    const tooLong = `https://example.com/${'a'.repeat(600)}`;
    const result = normaliseLinkUrl(tooLong);
    expect(result.ok).toBe(false);
  });
});

describe('the platform vocabulary stays in step with itself and the database', () => {
  it('derives LINK_PLATFORM_IDS from LINK_PLATFORMS, in the same order', () => {
    expect(LINK_PLATFORM_IDS).toEqual(LINK_PLATFORMS.map((p) => p.id));
  });

  it('matches db/014_profile_link.sql exactly: the same ten platform ids', () => {
    // Kept in step by hand with the CHECK in db/014_profile_link.sql (the same
    // hand-kept pair keychain.ts's PROVIDERS and db/007's provider CHECK are).
    // If this array changes, that CHECK has to change in the same commit.
    expect([...LINK_PLATFORM_IDS].sort()).toEqual(
      [
        'behance',
        'bluesky',
        'dribbble',
        'github',
        'linkedin',
        'mastodon',
        'other',
        'portfolio',
        'twitter',
        'website'
      ].sort()
    );
  });

  it('isLinkPlatform accepts a known id and rejects anything else', () => {
    expect(isLinkPlatform('github')).toBe(true);
    expect(isLinkPlatform('not-a-platform')).toBe(false);
    expect(isLinkPlatform(null)).toBe(false);
    expect(isLinkPlatform(42)).toBe(false);
  });

  it('labels every platform, and falls back to the id for an unknown one', () => {
    expect(linkPlatformLabel('github')).toBe('GitHub');
    expect(linkPlatformLabel('twitter')).toBe('Twitter / X');
  });
});
