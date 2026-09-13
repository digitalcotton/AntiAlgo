/**
 * password.ts: what a stored password hash looks like, and how it is checked.
 *
 * WHY THIS EXISTS. Left alone, Better Auth hashes and verifies passwords with
 * node's crypto.scrypt at N=16384, r=16, p=1, dkLen=64 (see
 * node_modules/@better-auth/utils/dist/password.node.mjs, the `config` object
 * at the top of the file). That is roughly 32 MB of scrypt's memory cost with
 * a parallelism of one. OWASP's scrypt guidance lists N=2**17,r=8,p=1 as the
 * first choice and N=2**16,r=8,p=2 as an equal-strength alternative; the
 * installed default sits at the memory of a weaker still OWASP alternative
 * (N=2**15,r=8,p=3) with a third of that alternative's total work. Argon2id
 * and bcrypt both need a dependency, and this repository forbids new runtime
 * dependencies (RUN-MASTER section 3), so the fix is heavier scrypt
 * parameters, not a different algorithm.
 *
 * The same file also compares the derived key with plain `===` on hex
 * strings, not a constant-time comparison. Better Auth ships a
 * `constantTimeEqual` helper (node_modules/better-auth/dist/crypto/buffer.mjs)
 * and uses it for the OTP plugins this app does not enable, but not for the
 * one secret comparison every sign-in actually performs. Every comparison in
 * this file goes through node's `crypto.timingSafeEqual` instead, and never
 * `===`, on Buffers whose lengths are checked first (timingSafeEqual throws
 * on a length mismatch, and a throw here must never look like a crash to the
 * caller).
 *
 * THE PART THAT MUST NOT BE WRONG. This module's hash() is wired in as
 * `emailAndPassword.password.hash` and verify() as
 * `emailAndPassword.password.verify` in src/lib/auth.ts. From the moment that
 * lands, every new password is hashed here. But every password hashed BEFORE
 * that moment is still sitting in the database in Better Auth's old format,
 * salt:key in hex, produced by the parameters above. If verify() only knew the
 * new format, the owner's own account, hashed months before this file existed,
 * would fail every sign-in forever, with no error that points at why. So
 * verify() reads the stored string to decide which parameters made it, rather
 * than assuming today's parameters, and it accepts both formats for as long as
 * an old-format row can still exist. Nothing here ever deletes or rewrites a
 * row; that is the rehash seam in auth.ts's databaseHooks, a separate and
 * narrower piece of code that only ever runs after a password has already
 * verified.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/**
 * Today's parameters. N=2**16, r=8, p=2, dkLen=64 is one of OWASP's listed
 * scrypt configurations (roughly 67 MB of memory cost, 128*N*r bytes), chosen
 * over the also-listed N=2**17,r=8,p=1 because it costs the same and keeps a
 * comfortably lower ceiling for a serverless function's memory budget.
 *
 * THESE NUMBERS ARE READ IN EXACTLY ONE PLACE THAT MATTERS: hash(). verify()
 * never reads them for a stored hash it did not just create in the same call;
 * it reads the parameters out of the stored string instead. See
 * verifyCurrentFormat() below for why that split is the entire point.
 */
const CURRENT_PARAMS = { N: 2 ** 16, r: 8, p: 2, dkLen: 64 } as const;

/**
 * Better Auth's own defaults, reproduced here so a pre-existing hash can still
 * be checked. Quoted, not guessed: node_modules/@better-auth/utils/dist/
 * password.node.mjs, `const config = { N: 16384, r: 16, p: 1, dkLen: 64 }`.
 * If that file's defaults ever change, this constant goes stale and every
 * hash made under the old defaults starts failing to verify; there is no way
 * to detect that automatically; it is why claim 1 in this file's originating
 * audit is worth re-checking by hand if @better-auth/utils is ever upgraded.
 */
const BETTER_AUTH_LEGACY_PARAMS = { N: 16384, r: 16, p: 1, dkLen: 64 } as const;

/**
 * node's crypto.scrypt refuses to run when its memory footprint would exceed
 * `maxmem`, and maxmem DEFAULTS TO 32 MB. THE TRAP: CURRENT_PARAMS alone (N=
 * 2**16, r=8, p=2) needs more than that, so an unmodified crypto.scrypt call
 * throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS on every single hash and verify,
 * meaning every sign-up and every sign-in, the moment this file is wired in.
 * That failure mode is silent in the sense that it looks like a crash
 * unrelated to password strength, not like a parameters problem, so it is
 * worth writing the arithmetic down rather than hardcoding a number that
 * happens to work today.
 *
 * The minimum sufficient value was measured, not assumed: on this machine's
 * node (v22, engines pin the deployed target at 24.x), crypto.scryptSync with
 * N=65536, r=8, p=2 succeeded at maxmem = 128*N*r*p (134217728) and still
 * succeeded one byte under that, meaning 128*N*r*p is the boundary itself, not
 * a loose upper bound with room to spare. Doubling it here is the same margin
 * Better Auth's own password.node.mjs takes on its default parameters
 * (`maxmem: 128 * config.N * config.r * 2`), for the same reason: a boundary
 * that has already been shown to be exact is not a boundary to sit exactly
 * on, in case a slightly different OpenSSL build measures the working set a
 * little differently.
 */
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
      // NFKC, because Better Auth's hasher normalises this way (password.node.mjs,
      // `password.normalize("NFKC")`). A hash made under one normalisation and
      // checked under another is a hash that silently never verifies again for
      // anyone whose password contains a character with more than one Unicode
      // representation. Applied on every path, not only the legacy one, so a
      // hash made by hash() here and one made by Better Auth's own hasher stay
      // interchangeable in that respect too.
      password.normalize('NFKC'),
      salt,
      params.dkLen,
      { N: params.N, r: params.r, p: params.p, maxmem: requiredMaxmem(params.N, params.r, params.p) },
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      }
    );
  });
}

/**
 * Constant-time comparison of two buffers of possibly different lengths.
 *
 * timingSafeEqual THROWS on a length mismatch rather than returning false, and
 * a thrown error out of verify() is exactly the failure this whole module
 * exists to avoid turning into a crash: a corrupted row, a truncated key, or
 * an attacker's malformed input must all fail a sign-in quietly, the same way
 * a wrong password does, not surface as a 500. The length check here is the
 * guard that keeps that throw from ever happening.
 */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function toB64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * base64url decoding of attacker-controlled input. Buffer.from with a bad
 * alphabet does not throw in node, it silently drops what it cannot parse, so
 * a garbage string decodes to SOME buffer rather than raising an error. That
 * is fine for this module's purposes: a garbage salt or key just derives to
 * or is compared against something that will not match, and safeEqual's
 * length guard and the scrypt derivation both handle whatever comes out
 * without throwing.
 */
function fromB64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/**
 * The stored format this module writes: `scrypt$N$r$p$salt$key`, decimal
 * parameters, salt and key each base64url-encoded (RFC 4648 section 5, the
 * URL-safe alphabet with padding omitted, node's built-in 'base64url'
 * encoding). dkLen is not a field: every hash this module writes uses
 * CURRENT_PARAMS.dkLen (64), and verifyCurrentFormat() below checks the
 * stored key decodes to exactly that many bytes before ever calling scrypt.
 * That is a security guard, not a shortcut: scrypt's output is a true prefix
 * of its own longer output, so deriving at whatever length a stored key
 * happens to be, rather than at a fixed expected length, would let a
 * truncated or corrupted key verify against a shortened derivation instead
 * of being rejected. See the comment on that guard for how this was caught.
 *
 * TOLD APART FROM BETTER AUTH'S FORMAT BY CONSTRUCTION. Better Auth's format
 * is `${saltHex}:${keyHex}`, hex characters and one colon, no `$`. base64url's
 * alphabet (A-Z, a-z, 0-9, -, _) also never contains `$`. So a string starting
 * with the literal prefix "scrypt$" cannot be a Better Auth hash, and a Better
 * Auth hash can never start with it. verify() below uses exactly that prefix
 * check to route between the two formats; nothing here guesses.
 */
const CURRENT_FORMAT_PREFIX = 'scrypt$';

/**
 * Hash a password with today's parameters, in the format this module owns.
 *
 * WHY EVERY CALL MINTS ITS OWN SALT. A shared or predictable salt turns scrypt
 * into a lookup-table problem the moment two accounts share a password; 16
 * random bytes per call is the same width Better Auth's own hasher uses
 * (password.node.mjs, `randomBytes(16)`), kept here rather than shrunk for no
 * reason.
 */
export async function hash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptDerive(password, salt, CURRENT_PARAMS);
  return [
    CURRENT_FORMAT_PREFIX.slice(0, -1),
    CURRENT_PARAMS.N,
    CURRENT_PARAMS.r,
    CURRENT_PARAMS.p,
    toB64Url(salt),
    toB64Url(key)
  ].join('$');
}

/**
 * Verify a hash written by THIS module's hash().
 *
 * READS PARAMETERS FROM THE STRING, NEVER FROM CURRENT_PARAMS. This is the
 * one line that makes the whole scheme survive a future parameter bump. The
 * day CURRENT_PARAMS changes to something stronger, every hash minted before
 * that day was made with the OLD numbers; deriving with the new numbers
 * instead of the stored ones would produce a different key from a correct
 * password and silently lock out every account that has not signed in since
 * the change. Parsing N, r, and p out of the stored string and deriving with
 * exactly those is what keeps a hash from yesterday checkable today and a
 * hash from today checkable after the next bump.
 *
 * Returns false, never throws, for anything that is not a well-formed
 * instance of this format: wrong field count, non-numeric or non-positive
 * parameters, or a key/salt that fails to decode to a nonzero length. A
 * malformed stored value is exactly as likely to be a corrupted row as an
 * attack, and either way the correct behaviour is the same as a wrong
 * password, not a crash.
 */
async function verifyCurrentFormat(stored: string, password: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || N <= 0) return false;
  if (!Number.isInteger(r) || r <= 0) return false;
  if (!Number.isInteger(p) || p <= 0) return false;
  if (!saltRaw || !keyRaw) return false;

  const salt = fromB64Url(saltRaw);
  const storedKey = fromB64Url(keyRaw);
  if (salt.length === 0 || storedKey.length === 0) return false;

  // dkLen is fixed at CURRENT_PARAMS.dkLen for every hash this module has
  // ever written, REGARDLESS of what the stored string's key decodes to. This
  // is deliberate and not the same choice as reading N, r, and p from the
  // string: scrypt's output is a true prefix of its own longer output (the
  // same derivation at a shorter dkLen reproduces the first bytes of the
  // longer one), which was caught empirically by this file's own truncated-
  // key test failing until this comment was written. Deriving at
  // `storedKey.length` instead of a fixed width would have meant a truncated
  // key always verifies against a shortened derivation of the same correct
  // password, and worse, against ANY password whose first byte of scrypt
  // output happens to match at a one-byte key. A wrong-length stored key must
  // never verify no matter what password is offered, so it is rejected here,
  // before scrypt ever runs, rather than accepted at whatever length it
  // happens to be.
  if (storedKey.length !== CURRENT_PARAMS.dkLen) return false;

  let derived: Buffer;
  try {
    derived = await scryptDerive(password, salt, { N, r, p, dkLen: CURRENT_PARAMS.dkLen });
  } catch {
    // A parameter combination scrypt itself refuses (for example N, r, p
    // large enough that requiredMaxmem() overflows a safe integer, or N not a
    // power of two) is not this caller's password to blame. Fail closed.
    return false;
  }
  return safeEqual(derived, storedKey);
}

/**
 * Verify a hash written by BETTER AUTH'S OWN HASHER, reproduced exactly.
 *
 * QUOTED FROM node_modules/@better-auth/utils/dist/password.node.mjs:
 *
 *   const salt = randomBytes(16).toString("hex");
 *   const key = await generateKey(password, salt);   // scrypt(password, salt, ...)
 *   return `${salt}:${key.toString("hex")}`;
 *
 * TWO DETAILS THAT ARE EASY TO GET WRONG AND WOULD LOCK OUT EVERY EXISTING
 * ACCOUNT IF GOTTEN WRONG HERE:
 *
 * 1. The salt half of the stored string is a HEX STRING, but it is never
 *    hex-DECODED before being used as scrypt's salt. It is passed to
 *    node's crypto.scrypt as a plain JavaScript string, which node encodes to
 *    bytes as UTF-8, meaning the actual salt bytes fed into scrypt are the 32
 *    ASCII characters of the hex string itself, not the 16 bytes that hex
 *    string represents. Hex-decoding it here (an easy, "more correct
 *    looking" mistake) would derive a different key from every correct
 *    password and reject every existing account. This function reproduces
 *    the bug-for-bug behaviour deliberately, because compatibility with what
 *    is actually stored is the only thing this function is for.
 * 2. The key half IS hex-decoded, because that half is compared against, not
 *    fed into, a KDF: `key.toString("hex")` on the way in means the stored
 *    text is genuinely hex-encoded bytes there.
 *
 * Claim 3 from the audit (the `===` comparison) is also fixed here: this
 * function derives the same way password.node.mjs does and then compares with
 * safeEqual(), never `===`.
 */
async function verifyBetterAuthFormat(stored: string, password: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [saltHex, keyHex] = parts;
  if (!saltHex || !keyHex) return false;

  const storedKey = Buffer.from(keyHex, 'hex');
  // Fixed at BETTER_AUTH_LEGACY_PARAMS.dkLen (64), not at storedKey's own
  // decoded length, for the exact reason explained at the matching guard in
  // verifyCurrentFormat() above: scrypt's output is a prefix of its own
  // longer output, so deriving at whatever length a (possibly truncated or
  // corrupted) stored key happens to be would let a wrong-length key verify
  // against a shortened derivation instead of being rejected outright.
  if (storedKey.length !== BETTER_AUTH_LEGACY_PARAMS.dkLen) return false;

  let derived: Buffer;
  try {
    // The salt argument is the raw hex STRING, per the comment above, not a
    // decoded buffer.
    derived = await scryptDerive(password, saltHex, {
      N: BETTER_AUTH_LEGACY_PARAMS.N,
      r: BETTER_AUTH_LEGACY_PARAMS.r,
      p: BETTER_AUTH_LEGACY_PARAMS.p,
      dkLen: BETTER_AUTH_LEGACY_PARAMS.dkLen
    });
  } catch {
    return false;
  }
  return safeEqual(derived, storedKey);
}

/**
 * The entry point Better Auth calls on every sign-in, at
 * `emailAndPassword.password.verify` in src/lib/auth.ts.
 *
 * THE BRANCH ORDER IS THE WHOLE DESIGN. Every hash this module has ever
 * written starts with "scrypt$", which cannot occur in Better Auth's own
 * salt:key hex format (see CURRENT_FORMAT_PREFIX above), so the prefix check
 * is a correct, non-guessing router between "hashed here" and "hashed by
 * Better Auth's default before this file existed", and both branches are
 * exercised: see password.test.ts, in particular the case that generates a
 * real hash with @better-auth/utils's own hashPassword() and confirms this
 * function accepts it. Any error anywhere in either branch is caught and
 * turned into `false`; a bug in this function must read as a failed sign-in,
 * never as a 500 that a reader has no way to explain.
 */
export async function verify(data: { hash: string; password: string }): Promise<boolean> {
  try {
    if (data.hash.startsWith(CURRENT_FORMAT_PREFIX)) {
      return await verifyCurrentFormat(data.hash, data.password);
    }
    return await verifyBetterAuthFormat(data.hash, data.password);
  } catch {
    return false;
  }
}

/**
 * True when a stored hash was not made with today's CURRENT_PARAMS: either it
 * is still in Better Auth's original format, or it is in this module's own
 * format but was written under an earlier version of CURRENT_PARAMS.
 *
 * WIRED FROM auth.ts, NOT FROM HERE. Better Auth's `emailAndPassword.password`
 * option (node_modules/@better-auth/core/dist/types/init-options.d.mts) is
 * only `{ hash, verify }`; there is no rehash hook on that option itself. The
 * caller lives in src/lib/auth.ts's `databaseHooks.session.create.after`,
 * which is the earliest point after a verified sign-in that has both the
 * plaintext password (off the sign-in request body, the same way this file's
 * `sourceFromRequest` already reads signup_source off a request) and write
 * access to the account row (`context.context.internalAdapter.updateAccount`).
 * See the comment there for why that hook, and not this file, does the actual
 * rewrite: this function only judges a stored string, it never touches the
 * database, so it stays testable without one.
 */
export function needsRehash(stored: string): boolean {
  if (!stored.startsWith(CURRENT_FORMAT_PREFIX)) return true;
  const parts = stored.split('$');
  if (parts.length !== 6) return true;
  const [, nRaw, rRaw, pRaw] = parts;
  return !(
    Number(nRaw) === CURRENT_PARAMS.N &&
    Number(rRaw) === CURRENT_PARAMS.r &&
    Number(pRaw) === CURRENT_PARAMS.p
  );
}
