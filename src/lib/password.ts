/**
 * password.ts: the password hash, in the index's exact format.
 *
 * WHY NOT BETTER AUTH'S DEFAULT. The index hashes with scrypt at N=2^16, r=8,
 * p=2 and stores `scrypt$N$r$p$salt$key` (base64url), and it still verifies
 * the library's own legacy `salt:key` hex format for older rows. An account
 * created here has to be the same row an account created on the index is, so
 * the day the two share a database a password set on either side verifies on
 * both. This file is that format, unchanged.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const CURRENT_PARAMS = { N: 2 ** 16, r: 8, p: 2, dkLen: 64 } as const;
const BETTER_AUTH_LEGACY_PARAMS = { N: 16384, r: 16, p: 1, dkLen: 64 } as const;
const CURRENT_FORMAT_PREFIX = 'scrypt$';

function requiredMaxmem(N: number, r: number, p: number): number {
  return 128 * N * r * p * 2;
}

function scryptDerive(
  password: string,
  salt: string | Buffer,
  params: { N: number; r: number; p: number; dkLen: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password.normalize('NFKC'),
      salt,
      params.dkLen,
      { N: params.N, r: params.r, p: params.p, maxmem: requiredMaxmem(params.N, params.r, params.p) },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function hash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptDerive(password, salt, CURRENT_PARAMS);
  return [
    CURRENT_FORMAT_PREFIX.slice(0, -1),
    CURRENT_PARAMS.N,
    CURRENT_PARAMS.r,
    CURRENT_PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url')
  ].join('$');
}

async function verifyCurrentFormat(stored: string, password: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  if (!saltRaw || !keyRaw) return false;
  const salt = Buffer.from(saltRaw, 'base64url');
  const storedKey = Buffer.from(keyRaw, 'base64url');
  if (salt.length === 0 || storedKey.length !== CURRENT_PARAMS.dkLen) return false;
  try {
    const derived = await scryptDerive(password, salt, { N, r, p, dkLen: CURRENT_PARAMS.dkLen });
    return safeEqual(derived, storedKey);
  } catch {
    return false;
  }
}

async function verifyBetterAuthFormat(stored: string, password: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [saltHex, keyHex] = parts;
  if (!saltHex || !keyHex) return false;
  const storedKey = Buffer.from(keyHex, 'hex');
  if (storedKey.length !== BETTER_AUTH_LEGACY_PARAMS.dkLen) return false;
  try {
    const derived = await scryptDerive(password, saltHex, BETTER_AUTH_LEGACY_PARAMS);
    return safeEqual(derived, storedKey);
  } catch {
    return false;
  }
}

export async function verify(data: { hash: string; password: string }): Promise<boolean> {
  try {
    if (data.hash.startsWith(CURRENT_FORMAT_PREFIX)) return await verifyCurrentFormat(data.hash, data.password);
    return await verifyBetterAuthFormat(data.hash, data.password);
  } catch {
    return false;
  }
}
