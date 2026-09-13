import { describe, expect, it } from 'vitest';
import { hashPassword as betterAuthHash } from '@better-auth/utils/password';
import { hash, verify, needsRehash } from './password';

// password.ts is the one place that turns a plaintext password into a stored
// hash and back. The stakes are asymmetric: a wrong password failing to
// verify is the system working, but a RIGHT password failing to verify locks
// somebody, potentially the owner, out of their own account with no error
// that explains why. These tests are written to that asymmetry: round trips,
// a real hash from Better Auth's own hasher, and a battery of malformed
// inputs that must all fail closed rather than throw.

describe('hash() and verify(): round trip', () => {
  it('verifies a password against its own hash', async () => {
    const stored = await hash('correct horse battery staple');
    expect(await verify({ hash: stored, password: 'correct horse battery staple' })).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hash('correct horse battery staple');
    expect(await verify({ hash: stored, password: 'wrong password entirely' })).toBe(false);
  });

  it('does not throw at the chosen parameters (the maxmem trap)', async () => {
    // node's crypto.scrypt defaults maxmem to 32 MB and throws
    // ERR_CRYPTO_INVALID_SCRYPT_PARAMS when N=2**16, r=8, p=2 exceeds it.
    // hash() must pass an explicit maxmem large enough for its own
    // parameters; if it does not, this call rejects instead of resolving.
    await expect(hash('anything')).resolves.toEqual(expect.any(String));
  });

  it('writes a self-describing string in the documented shape', async () => {
    const stored = await hash('shape check');
    const parts = stored.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe('65536'); // 2**16
    expect(parts[2]).toBe('8');
    expect(parts[3]).toBe('2');
  });
});

describe('verify(): accepts a real Better Auth hash', () => {
  it("verifies a hash produced by @better-auth/utils's own hashPassword()", async () => {
    // THIS IS THE TEST THAT STOPS THE OWNER BEING LOCKED OUT. It does not use
    // a hand-written fixture string, because a fixture only proves this file
    // can parse what it assumes the format to be. Generating a hash with the
    // library's own hasher and feeding it to this module's verify() proves
    // this file can parse what the format actually is, salt encoding,
    // hex-versus-raw handling and all.
    const password = 'a real owner password, chosen once, forgotten never';
    const betterAuthStored = await betterAuthHash(password);

    // Sanity check on the fixture itself: this must be Better Auth's format,
    // not accidentally something that also parses as this module's format.
    expect(betterAuthStored).not.toMatch(/^scrypt\$/);
    expect(betterAuthStored.split(':')).toHaveLength(2);

    expect(await verify({ hash: betterAuthStored, password })).toBe(true);
    expect(await verify({ hash: betterAuthStored, password: 'not the password' })).toBe(false);
  });
});

describe('verify(): reads stored parameters, not current constants', () => {
  it("still verifies a hash written with different N, r, p than today's CURRENT_PARAMS", async () => {
    // Built directly in this module's own format with deliberately different
    // numbers, standing in for "hashed months ago, before a parameter bump".
    // If verify() ever starts deriving with today's CURRENT_PARAMS instead of
    // the parameters parsed out of the string, this is the test that catches
    // it: the derived key would not match a key made with different N or p,
    // and this would start failing the moment CURRENT_PARAMS in password.ts
    // changes to anything else.
    const { scryptSync } = await import('node:crypto');
    const N = 2 ** 14; // deliberately not CURRENT_PARAMS.N (2**16)
    const r = 8;
    const p = 5; // deliberately not CURRENT_PARAMS.p (2)
    const dkLen = 64;
    const password = 'parameters travel with the hash';
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex').subarray(0, 16);
    const key = scryptSync(password, salt, dkLen, {
      N,
      r,
      p,
      maxmem: 128 * N * r * p * 2
    });
    const stored = ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');

    expect(await verify({ hash: stored, password })).toBe(true);
    expect(await verify({ hash: stored, password: 'a different password' })).toBe(false);
  });
});

describe('verify(): fails closed, never throws, on malformed input', () => {
  it('returns false for an empty string', async () => {
    await expect(verify({ hash: '', password: 'anything' })).resolves.toBe(false);
  });

  it('returns false for a string with no recognisable shape', async () => {
    await expect(verify({ hash: 'not a hash of any kind', password: 'anything' })).resolves.toBe(
      false
    );
  });

  it('returns false for the current format with a truncated key', async () => {
    const stored = await hash('truncate me');
    const parts = stored.split('$');
    parts[5] = parts[5].slice(0, 8); // chop the key down to a handful of bytes
    const truncated = parts.join('$');
    await expect(verify({ hash: truncated, password: 'truncate me' })).resolves.toBe(false);
  });

  it('returns false for the current format with a key of the wrong length', async () => {
    const stored = await hash('wrong length');
    const parts = stored.split('$');
    // Replace the key with a well-formed but differently-sized value rather
    // than truncating it, so this exercises the length-mismatch path
    // distinctly from the truncation case above.
    parts[5] = Buffer.from('short').toString('base64url');
    const wrongLength = parts.join('$');
    await expect(verify({ hash: wrongLength, password: 'wrong length' })).resolves.toBe(false);
  });

  it('returns false for a legacy-shaped string with a truncated key', async () => {
    const betterAuthStored = await betterAuthHash('legacy truncate');
    const [saltHex, keyHex] = betterAuthStored.split(':');
    const truncated = `${saltHex}:${keyHex.slice(0, 10)}`;
    await expect(verify({ hash: truncated, password: 'legacy truncate' })).resolves.toBe(false);
  });

  it('returns false for a current-format string with a non-numeric parameter', async () => {
    const stored = await hash('bad params');
    const parts = stored.split('$');
    parts[1] = 'not-a-number';
    await expect(verify({ hash: parts.join('$'), password: 'bad params' })).resolves.toBe(false);
  });

  it('returns false for a current-format string with the wrong field count', async () => {
    await expect(
      verify({ hash: 'scrypt$65536$8$2$onlyonefield', password: 'anything' })
    ).resolves.toBe(false);
  });
});

describe('needsRehash()', () => {
  it('is true for a Better Auth format hash', async () => {
    const betterAuthStored = await betterAuthHash('needs upgrading');
    expect(needsRehash(betterAuthStored)).toBe(true);
  });

  it("is false for a hash written by this module's own hash() at current parameters", async () => {
    const stored = await hash('already current');
    expect(needsRehash(stored)).toBe(false);
  });

  it("is true for this module's own format written with stale parameters", () => {
    const stale = 'scrypt$16384$8$1$c2FsdA$a2V5';
    expect(needsRehash(stale)).toBe(true);
  });
});
