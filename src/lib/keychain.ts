/**
 * keychain.ts: what a stored bring-your-own provider key looks like, and how
 * it is sealed and opened. Pure, like record.ts and provider.ts: no database
 * connection anywhere in this file, no fetch, no import of anything that
 * touches a network or a pool. The impure half, the actual reads and writes
 * against db/007_user_provider_key.sql, lives in keychain-store.ts, which
 * calls into this file rather than the other way around. Same split
 * record-store.ts's own header describes for the Profile Record: this file
 * decides, that one does I/O and decides nothing.
 *
 * WHY THIS EXISTS. MASTER-SPEC decision D7: post-launch, a person may hand
 * this app their own Anthropic, OpenAI, Kimi, or DeepSeek API key so
 * generation bills to them, not to this product. D7's compliance shape is
 * explicit: "user-entered keys, per-user encrypted or client-side, never
 * pooled." A plaintext API key sitting in a database row is a single
 * database breach away from being every customer's provider bill and every
 * customer's provider account, at once. This file is the encryption half of
 * meeting that shape.
 *
 * THE TWO MOMENTS. A plaintext provider key exists in exactly two places
 * this codebase ever lets it exist as plaintext: the POST body that
 * delivered it from the person who typed it, and the return value of
 * decryptKey() at the instant generation is about to call the provider.
 * Everywhere else, on disk, in memory between those two moments, in a log
 * line, in an error message, in an account export, in a rendered page, it
 * is either ciphertext or it does not exist. Concretely, in this file:
 *   - encryptKey() takes plaintext in and returns ciphertext, iv, and
 *     authTag out. It never logs, never returns the plaintext alongside the
 *     ciphertext, and the plaintext argument is never written to anything
 *     this function holds onto after it returns.
 *   - decryptKey() is the ONLY function in this module that turns ciphertext
 *     back into plaintext, and its caller (keychain-store.ts's
 *     getDecryptedKey(), and only that function) exists for exactly one
 *     reason: to hand the plaintext to a provider call at the moment
 *     generation needs it, not to cache it, store it, or pass it anywhere
 *     that outlives that call.
 *   - Every other function that touches a key operates on it without ever
 *     seeing it whole in a form that could leak: fingerprint() and last4()
 *     each take plaintext in and return something that is deliberately NOT
 *     the key (a one-way hash, four characters), and validateKeyShape()
 *     inspects shape without ever being handed anything it echoes back.
 * A thrown error anywhere in this file is checked, by comment and by test,
 * to never interpolate the plaintext, the ciphertext, or any encryption
 * parameter that narrows a brute-force search. See decryptKey()'s own
 * comment for the one place that guarantee is easiest to get wrong.
 *
 * WHY AES-256-GCM AND NOT SOMETHING ELSE. GCM is an AEAD cipher: it
 * encrypts and authenticates in one pass, so a tampered ciphertext or a
 * tampered tag fails to decrypt at all rather than decrypting into garbage
 * that a caller has to notice is garbage on its own. AES-256 is a NIST- and
 * OWASP-recommended symmetric cipher with no known practical break, node's
 * `node:crypto` supports it natively, and this repository forbids new
 * runtime dependencies (the same constraint password.ts's header cites for
 * why it did not reach for Argon2id or bcrypt), so a cipher already built
 * into node was the only real option worth choosing between.
 *
 * WHAT THIS FILE CANNOT PROTECT AGAINST, STATED PLAINLY RATHER THAN IMPLIED.
 *   - A compromised server process, mid-request, holding KEY_ENCRYPTION_SECRET
 *     in memory and a decrypted key in a local variable, is not something
 *     encryption at rest defends against. That is a runtime compromise, not
 *     a database breach, and the only real mitigation is keeping the window
 *     between decryptKey() and the provider call as short as possible,
 *     which is keychain-store.ts's job, not this file's.
 *   - KEY_ENCRYPTION_SECRET itself is a single shared secret. Anyone who can
 *     read Vercel's environment variables for this project can decrypt
 *     every stored key for every user. This file does not attempt per-user
 *     secret custody (a client-side or per-user root key), which D7's
 *     "per-user encrypted OR client-side" language allows as an alternative
 *     shape; this run chose server-side encryption with a per-user derived
 *     subkey, which binds a ciphertext to its owner but does not remove the
 *     server's own custody of the master secret.
 *   - Rotation of KEY_ENCRYPTION_SECRET itself has no code path here. If
 *     that secret is ever rotated, every stored ciphertext becomes
 *     undecryptable the moment the new secret is live, because the HKDF
 *     subkey derivation runs off it. That is a deliberate non-feature of
 *     this pass, not an oversight: re-encrypting every stored key under a
 *     rotated master secret is a migration, and this task is the crypto
 *     primitives it would migrate, not the migration itself.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes
} from 'node:crypto';

/** The four providers db/007_user_provider_key.sql's CHECK constraint
    permits. Kept here, not imported from a migration file, because this
    module has to stay buildable without a database connection; the two
    lists have to be kept in agreement by hand, the same way flags.test.ts's
    own comment describes for a config file re-exported rather than owned
    by the type that checks it. */
export const PROVIDERS = ['anthropic', 'openai', 'kimi', 'deepseek'] as const;
export type Provider = (typeof PROVIDERS)[number];

/* -------------------------------------------------------------------------
   The master secret. Read lazily, at first use, never at import time.

   WHY LAZY. A module-level `const MASTER = required('KEY_ENCRYPTION_SECRET')`
   would throw the moment this file is imported, which happens at build time
   for any route that imports it even indirectly (Astro's build walks the
   whole import graph to know what to prerender). BYOK key storage is a
   post-launch feature nobody has to configure to build or deploy the rest of
   the site; the build must never need KEY_ENCRYPTION_SECRET, only the first
   actual key write or read does. Reading it inside a function, called only
   when encryptKey()/decryptKey() actually run, is what keeps the two
   separate: the variable is required at the moment it is needed, and not a
   moment before.
   ------------------------------------------------------------------------- */

let cachedMaster: Buffer | null = null;

/**
 * Same shape as db.ts's own required(): names the variable and says where
 * to set it, so a missing secret fails loudly with an answer instead of a
 * null pointer three layers down. Cached after the first successful read,
 * not because reading process.env is expensive, but so a caller who reads
 * `KEY_ENCRYPTION_SECRET` from a mutated process.env mid-process (a test,
 * mainly) sees the same behaviour the real deployed process would: one
 * value, decided once, for the life of the process.
 */
function requiredMasterSecret(): Buffer {
  if (cachedMaster) return cachedMaster;

  const raw = process.env.KEY_ENCRYPTION_SECRET;
  if (!raw) {
    throw new Error(
      'KEY_ENCRYPTION_SECRET is not set. Generate one with `openssl rand -base64 32` ' +
        'and set it in Vercel, Project, Settings, Environment Variables. Every stored ' +
        'provider key is sealed and opened with this secret; there is no default.'
    );
  }

  const decoded = Buffer.from(raw, 'base64');
  // Buffer.from with a bad base64 alphabet does not throw in node, the same
  // trap password.ts's fromB64Url() comment documents for decoding
  // attacker-controlled input; here the input is operator-controlled, not
  // attacker-controlled, but the failure mode is the same silent one, so it
  // is caught the same way: a length floor, checked after decoding, not a
  // try/catch around a call that would not have thrown.
  if (decoded.length < 32) {
    throw new Error(
      `KEY_ENCRYPTION_SECRET decodes to ${decoded.length} bytes; it must decode to at least ` +
        '32 bytes of random data. Generate one with `openssl rand -base64 32` and set it in ' +
        'Vercel, Project, Settings, Environment Variables.'
    );
  }

  cachedMaster = decoded;
  return cachedMaster;
}

/** Test-only escape hatch: clears the cached master secret so a test that
    sets and unsets KEY_ENCRYPTION_SECRET around itself (the save/restore
    pattern flags.test.ts uses for SITE_EDITION) is not left reading a value
    cached by an earlier test. Not exported for any other reason; production
    code never needs to un-cache a secret mid-process. */
/**
 * Is key storage configured on this deployment?
 *
 * WHY A CALLER NEEDS TO ASK. KEY_ENCRYPTION_SECRET is resolved lazily (see
 * above), so a deployment missing it builds fine, boots fine, and fails only
 * at the moment somebody pastes a key. A page that offers a form which is
 * certain to throw on submit is worse than one that says the feature is not
 * configured here, and the only way to tell the difference used to be to
 * call encryptKey() on a made-up value and catch the throw. That worked, and
 * it meant a page render did a full AES-256-GCM encryption of a fake string
 * to answer a yes-or-no question, with a comment explaining the trick.
 *
 * This asks the question directly. It returns false for every reason the
 * secret could be unusable (absent, empty, not decodable, too short), which
 * is deliberately one answer rather than four: a caller deciding whether to
 * render a form does not need to know which way the environment is wrong,
 * and an error message that told a visitor would be describing this
 * deployment's configuration to a stranger. Whoever set the variable gets
 * the specific reason, from requiredMasterSecret()'s own throw, at the
 * moment they try to use it.
 */
export function keyStorageIsConfigured(): boolean {
  try {
    requiredMasterSecret();
    return true;
  } catch {
    return false;
  }
}

export function _resetMasterSecretForTests(): void {
  cachedMaster = null;
}

/**
 * The per-user subkey every encrypt and decrypt actually runs under.
 *
 * WHY A SUBKEY PER USER, RATHER THAN ENCRYPTING EVERY ROW UNDER THE MASTER
 * SECRET DIRECTLY. HKDF with the user's id as salt means the key that seals
 * user A's row is cryptographically different from the key that would seal
 * an identical plaintext for user B. That is what makes a copied row
 * meaningless: if an attacker (or a bug) copies user A's ciphertext, iv, and
 * authTag onto user B's row, decryptKey(userB, ...) derives B's subkey, not
 * A's, and GCM's authentication tag fails to verify against a ciphertext
 * that was never sealed with that key, the same clean tamper failure a
 * genuinely corrupted row produces. See keychain.test.ts's "wrong user
 * cannot decrypt another user's ciphertext" case, which is this property,
 * not a coincidence of the test setup.
 *
 * 'sha256' matches the hash this file already uses for fingerprint(), one
 * fewer primitive to reason about. The info string is a fixed, literal
 * label rather than the provider name, deliberately: HKDF's info parameter
 * exists to separate different uses of the same (master, salt) pair, and
 * this file only ever derives one kind of subkey (a provider-key sealing
 * key) per user, so a fixed label is honest about that and a provider-
 * specific label would imply a separation this design does not need,
 * because the ciphertext, iv, and authTag are already stored per (user,
 * provider) row by keychain-store.ts's own primary key.
 */
function subkey(userId: string): Buffer {
  const master = requiredMasterSecret();
  const salt = Buffer.from(userId, 'utf8');
  const info = Buffer.from('user-provider-key', 'utf8');
  return Buffer.from(hkdfSync('sha256', master, salt, info, 32));
}

/** What keychain-store.ts persists into ciphertext/iv/auth_tag. Three
    Buffers, matching the three bytea columns db/007 owns; no plaintext
    field exists on this type anywhere, so there is no property a careless
    caller could log or return by habit and accidentally ship a key. */
export interface EncryptedKeyParts {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Seals one plaintext provider key for one user. A fresh, random 12-byte IV
 * every call, never reused.
 *
 * WHY 12 BYTES. NIST SP 800-38D, the GCM specification, recommends a 96-bit
 * (12-byte) IV as the standard case: it is the length GCM's own construction
 * is most efficient and best analysed at, and it is the length node's
 * `createCipheriv('aes-256-gcm', ...)` and `createDecipheriv` both default
 * their internal tag handling around.
 *
 * WHY THE IV MUST NEVER REPEAT UNDER THE SAME KEY, AND WHY THAT IS WORTH A
 * COMMENT RATHER THAN AN ASSUMPTION. GCM's confidentiality and its
 * authentication both depend on the (key, IV) pair being unique. Two
 * messages encrypted under the same key with the same IV leak the XOR of
 * their plaintexts to anyone who has both ciphertexts, and worse, let an
 * attacker who obtains that XOR forge a valid authentication tag for a
 * message of their choosing under that key. That failure is not a
 * theoretical footnote, it is GCM's best known practical break, which is
 * why this function calls randomBytes(12) fresh on every single call rather
 * than accepting an IV as an argument or deriving one deterministically:
 * there is no path through this function that can hand two encryptions
 * under the same subkey the same IV.
 */
export function encryptKey(userId: string, plaintext: string): EncryptedKeyParts {
  const key = subkey(userId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/** Thrown by decryptKey() on any failure: a tampered ciphertext, a tampered
    tag, a tampered iv, or ciphertext sealed under a different user's
    subkey. THE MESSAGE IS A FIXED, STATIC STRING WITH NO INTERPOLATION,
    checked by keychain.test.ts, because GCM's own failure carries no
    information worth surfacing beyond "this did not verify", and any
    detail this error added (which byte range, which parameter, a fragment
    of either buffer) would be exactly the kind of oracle a tamper detector
    must not become. */
export class KeychainTamperError extends Error {
  constructor() {
    super(
      'keychain: stored provider key failed to decrypt. The row is either corrupted or ' +
        'was not sealed for this user; it cannot be recovered.'
    );
    this.name = 'KeychainTamperError';
  }
}

/**
 * Opens one sealed provider key for one user. THE ONLY FUNCTION IN THIS
 * MODULE THAT TURNS CIPHERTEXT BACK INTO PLAINTEXT. Every failure path,
 * a bad auth tag, a truncated ciphertext, an iv that does not match what
 * the ciphertext was sealed under, a ciphertext sealed for a different
 * user's subkey, all land in node's own decrypt throwing, and all of them
 * are caught here and re-thrown as the one clean, static-message
 * KeychainTamperError, never node's own error object, which on some
 * versions and some failure modes can carry buffer contents or lengths in
 * its own message. Catching broadly and re-throwing narrowly is the guard;
 * letting node's original error escape uncaught is the mistake this
 * function exists to never make.
 */
export function decryptKey(userId: string, parts: EncryptedKeyParts): string {
  const key = subkey(userId);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, parts.iv);
    decipher.setAuthTag(parts.authTag);
    const plaintext = Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new KeychainTamperError();
  }
}

/** A one-way fingerprint of a plaintext key, for de-duplication and support
    ("is this the same key you sent us before") without ever storing or
    logging the key itself. Plain sha256, not the per-user HKDF subkey: a
    fingerprint's whole purpose is to be comparable, including potentially
    across users or across a key's own rotation history, which a per-user
    derived value could not do. sha256 of an API key is not reversible, and
    is deliberately NOT secret-keyed, because it is stored and displayed
    (keychain-store.ts's keyMeta()) and a keyed MAC displayed next to its
    own key would leak nothing new but would misstate what the value is
    for. */
export function fingerprint(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** The final four characters of a plaintext key, for display
    ("...a1b2") the way every card-on-file UI shows a last-four rather than
    a full number. Not a security control, a recognition aid: four
    characters of a 20+ character key is not a meaningful reduction in
    search space for an attacker who does not already have the rest. */
export function last4(plaintext: string): string {
  return plaintext.slice(-4);
}

const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 512;
const ANTHROPIC_PREFIX = 'sk-ant-';

export type KeyShapeResult = { ok: true } | { ok: false; reason: string };

/**
 * Shape validation only, run before encryptKey() ever sees a plaintext.
 * This is not the same job as validateEntry() in record.ts, which decides
 * whether a whole object is well-formed; this is a single string, and the
 * bar is "obviously not a pasted API key" (empty, whitespace, control
 * characters, wildly wrong length), not "matches a provider's real format
 * byte for byte".
 *
 * ANTHROPIC GETS ONE REAL CHECK, THE OTHER THREE GET SHAPE ONLY. Anthropic
 * publishes 'sk-ant-' as its key prefix as a stable, documented contract, so
 * refusing anything that does not start with it catches a pasted org id, a
 * bearer token from a different service, or a copy-paste of the wrong
 * field, before it is ever sent to Anthropic's API and rejected there
 * anyway. OpenAI, Kimi, and DeepSeek get no equivalent prefix check,
 * deliberately: their prefixes ('sk-' for OpenAI, others unpublished or
 * unstable) are not a contractual guarantee the way Anthropic's is, and a
 * validator that hardcodes an assumed prefix for a format it does not
 * actually own risks locking out a real, working key the moment that
 * provider changes its own key format without telling this codebase. Loose
 * sanity (non-empty, printable, length-bounded) is the honest amount of
 * validation to do on a format this module does not control.
 */
/**
 * WHICH KEY DRAFTS, as a pure rule (db/206 stores the designation; the
 * reads live in keychain-store.ts draftingProvider).
 *
 * In order, with no third branch:
 *   1. the designated provider, when its key is still on file;
 *   2. the only key on file, when there is exactly one, because "the only
 *      one" is not a choice between vendors;
 *   3. null.
 *
 * WHAT THIS REPLACED, AND WHY. The pipeline used to take the first key it
 * found in the order this module happens to list its providers in. Nobody
 * chose that order and no reader could see it, so connecting a second key
 * silently moved a person's drafting, and their bill, to another company.
 * Null here is not a failure: the pipeline already handles "no provider
 * key" by running the deterministic writer and saying so on the draft. What
 * null is not is permission to pick a vendor on someone's behalf.
 */
export function pickDraftingProvider(designated: Provider | null, onFile: readonly Provider[]): Provider | null {
  if (designated !== null && onFile.includes(designated)) return designated;
  return onFile.length === 1 ? onFile[0] : null;
}

export function validateKeyShape(provider: Provider, plaintext: string): KeyShapeResult {
  if (plaintext.length === 0) {
    return { ok: false, reason: 'key is empty' };
  }
  if (plaintext.length < MIN_KEY_LENGTH || plaintext.length > MAX_KEY_LENGTH) {
    return {
      ok: false,
      reason: `key length must be between ${MIN_KEY_LENGTH} and ${MAX_KEY_LENGTH} characters`
    };
  }
  // \s catches spaces, tabs, and newlines. A pasted key with a trailing
  // newline (the single most common paste artifact from a terminal or a
  // password manager) is exactly the case this guards, and it is refused
  // here rather than silently trimmed, because silently trimming would mean
  // the stored key and the key the person believes they saved can differ.
  if (/\s/.test(plaintext)) {
    return { ok: false, reason: 'key contains whitespace' };
  }
  // Control characters (U+0000 to U+001F, and U+007F) have no place in an
  // API key and are a reliable signal of a corrupted paste or a binary file
  // dropped into a text field.
  if (/[\x00-\x1f\x7f]/.test(plaintext)) {
    return { ok: false, reason: 'key contains control characters' };
  }
  if (provider === 'anthropic' && !plaintext.startsWith(ANTHROPIC_PREFIX)) {
    return { ok: false, reason: `anthropic keys start with '${ANTHROPIC_PREFIX}'` };
  }
  // AND THE REVERSE, WHICH MATTERS MORE. A key filed under the wrong
  // provider is not a typo that fails later: the draft calls that provider's
  // endpoint with this key in the Authorization header, so an Anthropic key
  // stored as a DeepSeek key would be transmitted to DeepSeek. The prefix is
  // the only tell any of the four gives: sk-ant- is Anthropic and nobody
  // else's, while OpenAI, Kimi and DeepSeek all issue plain sk- keys that
  // cannot be told apart here. So this closes the one case that can be
  // known, and the first draft remains the test for the rest.
  if (provider !== 'anthropic' && plaintext.startsWith(ANTHROPIC_PREFIX)) {
    return { ok: false, reason: `a key starting with '${ANTHROPIC_PREFIX}' is an anthropic key, not a ${provider} key` };
  }
  return { ok: true };
}
