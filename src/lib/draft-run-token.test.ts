import { describe, expect, it } from 'vitest';
import { isDraftRunPath, signRunToken, verifyRunToken, type RunPayload } from './draft-run-token';

describe('isDraftRunPath(): the one path middleware exempts from the gate', () => {
  it('matches only the /run leaf of a single job slug', () => {
    expect(isDraftRunPath('/desk/job-draft/acme-staff-designer/run')).toBe(true);
    expect(isDraftRunPath('/desk/job-draft/x/run')).toBe(true);
  });

  it('rejects the sibling endpoints, a trailing slash, and other server-to-server paths', () => {
    expect(isDraftRunPath('/desk/job-draft/x/status')).toBe(false);
    expect(isDraftRunPath('/desk/job-draft/x/resume')).toBe(false);
    expect(isDraftRunPath('/desk/job-draft/x/restore')).toBe(false);
    expect(isDraftRunPath('/desk/job-draft/x/run/')).toBe(false);
    expect(isDraftRunPath('/desk/job-draft/a/b/run')).toBe(false);
    expect(isDraftRunPath('/machine/posting-fetch/claim')).toBe(false);
    expect(isDraftRunPath('/desk/job-draft')).toBe(false);
  });
});

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
  steer: null,
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

  it('carries a steer through sign -> verify unchanged (the whole point of the field)', () => {
    const steered: RunPayload = {
      ...payload,
      steer: { chips: ['shorter', 'technical'], note: 'lead with the agent work' }
    };
    const back = verifyRunToken(signRunToken(steered, SECRET), SECRET, NOW);
    expect(back).toEqual(steered);
    expect(back?.steer).toEqual({ chips: ['shorter', 'technical'], note: 'lead with the agent work' });
  });

  it('drops a malformed steer to null rather than rejecting the token', () => {
    // A steer that is not object-shaped, or whose chips are not an array of
    // strings, is dropped: the token still verifies, the render is just not
    // steered. Consistent with the file treating a steer as data, not a gate.
    const notObject = { ...payload, steer: 'shorter please' } as unknown as RunPayload;
    const okNoSteer = verifyRunToken(signRunToken(notObject, SECRET), SECRET, NOW);
    expect(okNoSteer).not.toBeNull();
    expect(okNoSteer?.steer).toBeNull();

    const badChips = { ...payload, steer: { chips: 'shorter', note: null } } as unknown as RunPayload;
    const okBadChips = verifyRunToken(signRunToken(badChips, SECRET), SECRET, NOW);
    expect(okBadChips).not.toBeNull();
    expect(okBadChips?.steer).toBeNull();

    const badNote = { ...payload, steer: { chips: [], note: 42 } } as unknown as RunPayload;
    const okBadNote = verifyRunToken(signRunToken(badNote, SECRET), SECRET, NOW);
    expect(okBadNote).not.toBeNull();
    expect(okBadNote?.steer).toBeNull();
  });
});
