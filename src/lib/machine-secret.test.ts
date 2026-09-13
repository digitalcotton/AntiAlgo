import { afterEach, describe, expect, it } from 'vitest';
import { machineFetchSecret, machineRequestAuth } from './machine-secret';

function request(auth?: string): Request {
  return new Request('https://example.test/machine/posting-fetch/claim', { headers: auth ? { authorization: auth } : {} });
}

describe('machineRequestAuth', () => {
  const original = process.env.MACHINE_FETCH_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.MACHINE_FETCH_SECRET;
    else process.env.MACHINE_FETCH_SECRET = original;
  });

  it('is unset when the deployment has no secret, whatever the header says', () => {
    delete process.env.MACHINE_FETCH_SECRET;
    expect(machineFetchSecret()).toBeNull();
    expect(machineRequestAuth(request('Bearer anything'))).toBe('unset');
  });
  it('matches only the exact bearer', () => {
    process.env.MACHINE_FETCH_SECRET = 'correct-horse';
    expect(machineRequestAuth(request('Bearer correct-horse'))).toBe('ok');
    expect(machineRequestAuth(request('Bearer correct-hors'))).toBe('mismatch');
    expect(machineRequestAuth(request('Bearer correct-horse2'))).toBe('mismatch');
    expect(machineRequestAuth(request('correct-horse'))).toBe('mismatch');
    expect(machineRequestAuth(request())).toBe('mismatch');
  });
});
