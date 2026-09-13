import { describe, expect, it } from 'vitest';
import { signRunToken, verifyRunToken, type RunPayload } from './draft-run-token';

/**
 * The signed hand-off between the job-draft POST and the run endpoint. Pure,
 * so every case is a plain in/out: a token verifies only with the secret that
 * made it, only before it expires, and only when its payload is shaped like a
 * RunPayload. Anything else is null, never a throw.
 */

const NOW = 1_000_000;
const SECRET = 'my-secret';

const payload: RunPayload = {
  v: 1,
  renderId: 'r-1',
  userId: 'u-1',
  jobId: 'acme-role',
  kind: 'cover',
  provider: 'anthropic',
  reason: 'I like the craft',
  exp: 2_000_000
};

describe('draft-run-token: sign and verify', () => {
  it('round-trips to the same payload', () => {
    const token = signRunToken(payload, SECRET);
    expect(verifyRunToken(token, SECRET, NOW)).toEqual(payload);
  });

  it('rejects a tampered payload segment (the signature no longer matches)', () => {
    const token = signRunToken(payload, SECRET);
    const [encoded, signature] = token.split('.');
    const tampered = Buffer.from(JSON.stringify({ ...payload, userId: 'someone-else' }), 'utf8').toString('base64url');
    expect(verifyRunToken(`${tampered}.${signature}`, SECRET, NOW)).toBeNull();
    expect(encoded).not.toBe(tampered);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signRunToken(payload, 'some-other-secret');
    expect(verifyRunToken(token, SECRET, NOW)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signRunToken({ ...payload, exp: NOW }, SECRET);
    expect(verifyRunToken(token, SECRET, NOW)).toBeNull();
    expect(verifyRunToken(signRunToken({ ...payload, exp: NOW + 1 }, SECRET), SECRET, NOW)).not.toBeNull();
  });

  it('rejects a malformed string without throwing', () => {
    expect(verifyRunToken('no-dot-here', SECRET, NOW)).toBeNull();
    expect(verifyRunToken('.', SECRET, NOW)).toBeNull();
    expect(verifyRunToken('', SECRET, NOW)).toBeNull();
    expect(verifyRunToken('abc.', SECRET, NOW)).toBeNull();
  });

  it('rejects a correctly signed payload that is not shaped like a RunPayload', () => {
    const bad = { ...payload, kind: 'other' } as unknown as RunPayload;
    expect(verifyRunToken(signRunToken(bad, SECRET), SECRET, NOW)).toBeNull();
    const badProvider = { ...payload, provider: 'not-a-provider' } as unknown as RunPayload;
    expect(verifyRunToken(signRunToken(badProvider, SECRET), SECRET, NOW)).toBeNull();
  });

  it('accepts a null provider and a null reason (the no-key, no-note draft)', () => {
    const bare: RunPayload = { ...payload, provider: null, reason: null };
    expect(verifyRunToken(signRunToken(bare, SECRET), SECRET, NOW)).toEqual(bare);
  });
});
