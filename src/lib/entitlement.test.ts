import { describe, expect, it } from 'vitest';
import {
  admittedTier,
  decide,
  DEFAULT_TIER,
  isGated,
  requiredTierFor,
  signupTier,
  TIERS,
  WAITLIST_TIER,
  type Viewer
} from './entitlement';
import { isOn } from '../../flags.config.mjs';

const viewer = (tier: Viewer['tier'], emailVerified = true): Viewer => ({ userId: 'u1', tier, emailVerified });

describe('the ladder', () => {
  it('slots waitlisted between public and member', () => {
    expect(TIERS.indexOf('waitlisted')).toBe(TIERS.indexOf('public') + 1);
    expect(TIERS.indexOf('member')).toBe(TIERS.indexOf('waitlisted') + 1);
  });
});

describe('a member route', () => {
  it('denies a verified, waitlisted account with the waitlisted reason', () => {
    const verdict = decide('/account', viewer('waitlisted'));
    expect(verdict).toEqual({ allow: false, required: 'member', reason: 'waitlisted' });
  });

  it('denies an unverified waitlisted account with email-unverified first', () => {
    const verdict = decide('/account', viewer('waitlisted', false));
    expect(verdict.reason).toBe('email-unverified');
  });

  it('denies an unverified member with email-unverified too', () => {
    expect(decide('/account', viewer('member', false)).reason).toBe('email-unverified');
  });

  it('allows a verified member unchanged', () => {
    expect(decide('/account', viewer('member'))).toEqual({ allow: true, required: 'member', reason: 'allowed' });
  });

  it('allows paid and internal, which outrank member', () => {
    expect(decide('/account', viewer('paid')).allow).toBe(true);
    expect(decide('/account', viewer('internal')).allow).toBe(true);
  });

  it('refuses a signed-out reader', () => {
    expect(decide('/account', null).reason).toBe('signed-out');
  });

  it('refuses a member on an internal route as insufficient-tier, not waitlisted', () => {
    expect(decide('/internal', viewer('member')).reason).toBe('insufficient-tier');
  });

  it('gives a waitlisted account the waitlisted reason on an internal route as well', () => {
    expect(decide('/internal', viewer('waitlisted')).reason).toBe('waitlisted');
  });

  it('ignores a trailing slash', () => {
    expect(decide('/account/', viewer('waitlisted')).reason).toBe('waitlisted');
  });
});

describe('the come-ready route', () => {
  it('/start admits every signed-in tier, waitlisted included, and refuses signed-out', () => {
    expect(requiredTierFor('/start')).toBe('waitlisted');
    expect(decide('/start', null).reason).toBe('signed-out');
    expect(decide('/start', viewer('waitlisted')).allow).toBe(true);
    expect(decide('/start', viewer('member')).allow).toBe(true);
    expect(decide('/start', viewer('paid')).allow).toBe(true);
    expect(decide('/start', viewer('internal')).allow).toBe(true);
    expect(decide('/start', viewer('member', false)).reason).toBe('email-unverified');
  });
});

describe('public routes', () => {
  it('are not gated and allow everyone, including a waitlisted account', () => {
    for (const path of ['/', '/sign-up', '/sign-in', '/waitlist']) {
      expect(isGated(path)).toBe(false);
      expect(requiredTierFor(path)).toBeNull();
      expect(decide(path, viewer('waitlisted')).allow).toBe(true);
      expect(decide(path, null).allow).toBe(true);
    }
  });
});

describe('sign-up under the flag', () => {
  it('creates a waitlisted account while the flag is on', () => {
    expect(signupTier(true)).toBe(WAITLIST_TIER);
  });

  it('never creates a waitlisted account while the flag is off', () => {
    expect(signupTier(false)).toBe(DEFAULT_TIER);
    expect(signupTier(false)).not.toBe(WAITLIST_TIER);
  });

  it('is lit in both editions today', () => {
    expect(isOn('waitlist', 'design')).toBe(true);
    expect(isOn('waitlist', 'broad')).toBe(true);
  });
});

describe('admission', () => {
  it('moves a waitlisted account to member', () => {
    expect(admittedTier('waitlisted')).toBe('member');
  });

  it('is idempotent: admitting a member changes nothing', () => {
    expect(admittedTier(admittedTier('waitlisted'))).toBe('member');
    expect(admittedTier('member')).toBe('member');
  });

  it('never lowers anyone', () => {
    expect(admittedTier('paid')).toBe('paid');
    expect(admittedTier('internal')).toBe('internal');
    expect(admittedTier('public')).toBe('public');
  });
});
