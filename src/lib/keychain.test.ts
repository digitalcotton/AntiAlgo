import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KeychainTamperError,
  _resetMasterSecretForTests,
  decryptKey,
  encryptKey,
  fingerprint,
  last4,
  validateKeyShape,
  type EncryptedKeyParts
} from './keychain';

// keychain.ts is the one place a bring-your-own provider key is sealed and
// opened. The stakes run the same direction as password.ts's own tests,
// stated there as an asymmetry: a wrong password failing to verify is the
// system working. Here the asymmetry is sharper, because the thing being
// protected is not a password but a live, billable credential to a real
// provider account. A row that decrypts for the wrong user, or an error
// message that leaks a fragment of a key, is not a bug that locks someone
// out; it is a bug that hands someone else's API key, or a byte of it, to
// whoever is asking. These tests are written to that asymmetry.

/**
 * A real KEY_ENCRYPTION_SECRET, generated the way the module's own error
 * message tells an operator to generate one (`openssl rand -base64 32`),
 * set and restored around every test the same way flags.test.ts saves and
 * restores SITE_EDITION. _resetMasterSecretForTests() clears the module's
 * internal cache so a test that unsets the variable actually observes the
 * unset state, rather than reading a value an earlier test already cached.
 */
function withMasterSecret<T>(run: () => T): T {
  const prior = process.env.KEY_ENCRYPTION_SECRET;
  process.env.KEY_ENCRYPTION_SECRET = randomBytes(32).toString('base64');
  _resetMasterSecretForTests();
  try {
    return run();
  } finally {
    if (prior === undefined) delete process.env.KEY_ENCRYPTION_SECRET;
    else process.env.KEY_ENCRYPTION_SECRET = prior;
    _resetMasterSecretForTests();
  }
}

// A key shaped like a real Anthropic key but obviously not one: the 'test'
// segment and the padding are never going to collide with a live secret.
// Never a real-looking live key anywhere in this file.
const FAKE_KEY = 'sk-ant-test-' + 'a'.repeat(40);

describe('encryptKey()/decryptKey(): round trip', () => {
  it('decrypts back to the exact plaintext it was given', () => {
    withMasterSecret(() => {
      const parts = encryptKey('user_1', FAKE_KEY);
      expect(decryptKey('user_1', parts)).toBe(FAKE_KEY);
    });
  });

  it('round trips a key containing unicode without corruption', () => {
    withMasterSecret(() => {
      const withUnicode = 'sk-ant-test-' + 'café'.repeat(6);
      const parts = encryptKey('user_1', withUnicode);
      expect(decryptKey('user_1', parts)).toBe(withUnicode);
    });
  });
});

describe('encryptKey(): the per-user subkey binding', () => {
  it("cannot be decrypted by a different user's id: wrong user fails the same way a tampered row does", () => {
    withMasterSecret(() => {
      const parts = encryptKey('user_1', FAKE_KEY);
      // No detail about the failure leaks through: a wrong-user attempt and
      // a genuinely corrupted row are indistinguishable to the caller, which
      // is the point. See keychain.ts's subkey() comment for why HKDF with
      // the user id as salt is what makes this true rather than assumed.
      expect(() => decryptKey('user_2', parts)).toThrow(KeychainTamperError);
    });
  });

  it('decrypts correctly for the same user id that encrypted it, after a second, different user encrypts too', () => {
    withMasterSecret(() => {
      const partsA = encryptKey('user_1', FAKE_KEY);
      const otherKey = 'sk-ant-test-' + 'b'.repeat(40);
      const partsB = encryptKey('user_2', otherKey);

      expect(decryptKey('user_1', partsA)).toBe(FAKE_KEY);
      expect(decryptKey('user_2', partsB)).toBe(otherKey);
      // Cross-wired: user_1's parts under user_2's id, and vice versa, both
      // fail. Proves the binding runs both directions, not just one.
      expect(() => decryptKey('user_2', partsA)).toThrow(KeychainTamperError);
      expect(() => decryptKey('user_1', partsB)).toThrow(KeychainTamperError);
    });
  });
});

describe('encryptKey(): IV freshness', () => {
  it('never reuses an iv across two encrypts of the same plaintext for the same user', () => {
    withMasterSecret(() => {
      const first = encryptKey('user_1', FAKE_KEY);
      const second = encryptKey('user_1', FAKE_KEY);
      expect(first.iv.equals(second.iv)).toBe(false);
      // The ciphertexts differ too, as a direct consequence of the iv
      // differing under GCM, even though the plaintext and key are identical.
      expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    });
  });

  it('mints a 12-byte iv, the standard GCM nonce length', () => {
    withMasterSecret(() => {
      const parts = encryptKey('user_1', FAKE_KEY);
      expect(parts.iv.length).toBe(12);
    });
  });
});

describe('decryptKey(): tamper detection, and what the error does and does not say', () => {
  function sealedParts(): EncryptedKeyParts {
    return encryptKey('user_1', FAKE_KEY);
  }

  it('throws KeychainTamperError on a flipped byte in the ciphertext', () => {
    withMasterSecret(() => {
      const parts = sealedParts();
      const tampered = Buffer.from(parts.ciphertext);
      tampered[0] ^= 0xff;
      expect(() => decryptKey('user_1', { ...parts, ciphertext: tampered })).toThrow(
        KeychainTamperError
      );
    });
  });

  it('throws KeychainTamperError on a flipped byte in the auth tag', () => {
    withMasterSecret(() => {
      const parts = sealedParts();
      const tampered = Buffer.from(parts.authTag);
      tampered[0] ^= 0xff;
      expect(() => decryptKey('user_1', { ...parts, authTag: tampered })).toThrow(KeychainTamperError);
    });
  });

  it('throws KeychainTamperError on a flipped byte in the iv', () => {
    withMasterSecret(() => {
      const parts = sealedParts();
      const tampered = Buffer.from(parts.iv);
      tampered[0] ^= 0xff;
      expect(() => decryptKey('user_1', { ...parts, iv: tampered })).toThrow(KeychainTamperError);
    });
  });

  it('the error message names no key material, no ciphertext, and no encryption parameter, for any of the three tamper cases', () => {
    withMasterSecret(() => {
      const parts = sealedParts();

      const ciphertextTampered = Buffer.from(parts.ciphertext);
      ciphertextTampered[0] ^= 0xff;
      const tagTampered = Buffer.from(parts.authTag);
      tagTampered[0] ^= 0xff;
      const ivTampered = Buffer.from(parts.iv);
      ivTampered[0] ^= 0xff;

      const messages: string[] = [];
      for (const bad of [
        { ...parts, ciphertext: ciphertextTampered },
        { ...parts, authTag: tagTampered },
        { ...parts, iv: ivTampered }
      ]) {
        try {
          decryptKey('user_1', bad);
        } catch (error) {
          messages.push((error as Error).message);
        }
      }

      expect(messages).toHaveLength(3);
      for (const message of messages) {
        expect(message).not.toContain(FAKE_KEY);
        expect(message).not.toContain(parts.ciphertext.toString('base64'));
        expect(message).not.toContain(parts.ciphertext.toString('hex'));
        expect(message).not.toContain(parts.authTag.toString('hex'));
        expect(message).not.toContain(parts.iv.toString('hex'));
      }
      // Every message is the exact same static string: nothing about which
      // buffer was tampered leaks into the text either.
      expect(new Set(messages).size).toBe(1);
    });
  });
});

describe('fingerprint()', () => {
  it('is stable: the same plaintext always fingerprints the same', () => {
    expect(fingerprint(FAKE_KEY)).toBe(fingerprint(FAKE_KEY));
  });

  it('differs for two different plaintexts', () => {
    const other = 'sk-ant-test-' + 'c'.repeat(40);
    expect(fingerprint(FAKE_KEY)).not.toBe(fingerprint(other));
  });

  it('is a 64-character lowercase hex sha256 digest', () => {
    expect(fingerprint(FAKE_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('last4()', () => {
  it('returns the final four characters', () => {
    expect(last4('sk-ant-test-abcdwxyz')).toBe('wxyz');
  });

  it('matches the tail of the source string exactly', () => {
    expect(FAKE_KEY.endsWith(last4(FAKE_KEY))).toBe(true);
  });
});

describe('validateKeyShape()', () => {
  it('accepts a real-shaped sk-ant- key', () => {
    expect(validateKeyShape('anthropic', FAKE_KEY)).toEqual({ ok: true });
  });

  it('accepts a loosely shaped key for the other three providers', () => {
    const plausible = 'sk-' + 'd'.repeat(40);
    expect(validateKeyShape('openai', plausible)).toEqual({ ok: true });
    expect(validateKeyShape('kimi', plausible)).toEqual({ ok: true });
    expect(validateKeyShape('deepseek', plausible)).toEqual({ ok: true });
  });

  it('refuses an anthropic key with no sk-ant- prefix', () => {
    const result = validateKeyShape('anthropic', 'x'.repeat(40));
    expect(result.ok).toBe(false);
  });

  // The draft sends the stored key to the stored provider's endpoint, so a
  // key filed under the wrong one is not a late typo: it hands an Anthropic
  // key to DeepSeek.
  it('refuses an sk-ant- key filed under any other provider', () => {
    for (const provider of ['openai', 'kimi', 'deepseek'] as const) {
      const result = validateKeyShape(provider, FAKE_KEY);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain(provider);
    }
  });

  it('refuses an empty string', () => {
    const result = validateKeyShape('anthropic', '');
    expect(result.ok).toBe(false);
  });

  it('refuses a key containing whitespace', () => {
    const withSpace = 'sk-ant-test-' + 'a'.repeat(20) + ' ' + 'a'.repeat(19);
    const result = validateKeyShape('anthropic', withSpace);
    expect(result.ok).toBe(false);
  });

  it('refuses a key containing a trailing newline, the common paste artifact', () => {
    const result = validateKeyShape('anthropic', FAKE_KEY + '\n');
    expect(result.ok).toBe(false);
  });

  it('refuses a key containing control characters', () => {
    const withControl = 'sk-ant-test-' + 'a'.repeat(20) + '' + 'a'.repeat(19);
    const result = validateKeyShape('anthropic', withControl);
    expect(result.ok).toBe(false);
  });

  it('refuses a key shorter than the minimum length', () => {
    const result = validateKeyShape('anthropic', 'sk-ant-a');
    expect(result.ok).toBe(false);
  });

  it('refuses a key longer than the maximum length', () => {
    const result = validateKeyShape('anthropic', 'sk-ant-test-' + 'a'.repeat(600));
    expect(result.ok).toBe(false);
  });

  it('does not echo the plaintext back in the failure reason, for any refusal case', () => {
    const secretish = 'sk-ant-test-' + 'e'.repeat(20) + ' ' + 'e'.repeat(19);
    const result = validateKeyShape('anthropic', secretish);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain(secretish);
    }
  });
});

describe('KEY_ENCRYPTION_SECRET: required, lazily, and named on failure', () => {
  const prior = process.env.KEY_ENCRYPTION_SECRET;

  beforeEach(() => {
    delete process.env.KEY_ENCRYPTION_SECRET;
    _resetMasterSecretForTests();
  });

  afterEach(() => {
    if (prior === undefined) delete process.env.KEY_ENCRYPTION_SECRET;
    else process.env.KEY_ENCRYPTION_SECRET = prior;
    _resetMasterSecretForTests();
  });

  it('throws, naming the variable, when unset', () => {
    expect(() => encryptKey('user_1', FAKE_KEY)).toThrow(/KEY_ENCRYPTION_SECRET/);
  });

  it("says where to set it, so the failure reads as an answer, not a dead end", () => {
    expect(() => encryptKey('user_1', FAKE_KEY)).toThrow(/Vercel/);
  });

  it('throws, naming the variable, when set but too short to be real random data', () => {
    process.env.KEY_ENCRYPTION_SECRET = Buffer.from('too short').toString('base64');
    _resetMasterSecretForTests();
    expect(() => encryptKey('user_1', FAKE_KEY)).toThrow(/KEY_ENCRYPTION_SECRET/);
  });

  it('never reaches decryptKey either, since both derive the same subkey the same way', () => {
    expect(() =>
      decryptKey('user_1', {
        ciphertext: Buffer.alloc(0),
        iv: Buffer.alloc(12),
        authTag: Buffer.alloc(16)
      })
    ).toThrow(/KEY_ENCRYPTION_SECRET/);
  });
});
