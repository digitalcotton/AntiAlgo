/**
 * keychain-store.ts: the impure half of the keychain. Every query
 * db/007_user_provider_key.sql's one table gets, and nothing this file
 * decides on its own: the same split record-store.ts already draws against
 * record.ts, and desk-store.ts against desk.ts, restated here for the same
 * reason. src/lib/keychain.ts is pure and decides (the crypto parameters,
 * the per-user subkey derivation, shape validation); this file does I/O and
 * decides nothing, including about ownership: every function below takes a
 * `userId`, and every function scopes its query to that id. None of them
 * accepts a userId from a request body, because a userId is a viewer fact,
 * resolved server-side from the session by src/lib/viewer.ts, never a form
 * field a caller could type a stranger's id into.
 *
 * PARAMETERISED QUERIES ONLY. No string ever gets concatenated into SQL
 * here; every value a caller supplies travels as a placeholder argument.
 *
 * bytea IN, BUFFER OUT, ALWAYS. node-postgres decodes a bytea column to a
 * Buffer by default, with no configuration this file has to opt into, and
 * every Buffer this file sends back to Postgres (ciphertext, iv, auth_tag)
 * came straight out of keychain.ts's encryptKey(), which returns Buffers for
 * exactly this reason: no hex or base64 round trip anywhere in this file
 * that a byte could go missing or get re-encoded in.
 *
 * THE TWO-MOMENTS RULE, RESTATED FOR THIS FILE. keychain.ts's header says a
 * plaintext key exists in exactly two moments: the POST body that delivered
 * it, and the decrypt at the moment of generation. This file is where that
 * rule is enforced in code, not just in comments: putKey() is the only
 * function here that ever receives a plaintext key as an argument, and it
 * is gone (encrypted, never assigned to anything that outlives this
 * function's own stack frame) before this function's first `await` on a
 * query returns. getDecryptedKey() is THE ONLY function in this file, and
 * the only path in this whole codebase, that turns a stored row back into a
 * plaintext string; every other function here (keyMeta(), hasKey()) either
 * never selects the ciphertext columns at all, or selects and returns them
 * still sealed.
 */
import { db } from './db';
import { isKnownWritingModel } from './generation-providers';
import {
  decryptKey,
  encryptKey,
  fingerprint,
  last4,
  validateKeyShape,
  type EncryptedKeyParts,
  type Provider
} from './keychain';

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Thrown by putKey() when validateKeyShape() refuses the plaintext. The
    message carries validateKeyShape()'s own `reason`, which is always a
    description of the shape (length, whitespace, prefix), never the key
    itself; see keychain.ts's validateKeyShape() for why none of its reason
    strings ever echo the input back. */
export class InvalidKeyShapeError extends Error {
  constructor(reason: string) {
    super(`keychain-store: refused to store key: ${reason}`);
    this.name = 'InvalidKeyShapeError';
  }
}

/* -------------------------------------------------------------------------
   Row shapes and the pure mapper between a row and the shape the rest of
   the app reads. Only keyMeta() has one: getDecryptedKey() and hasKey()
   each return something too small to be worth a named row type, and
   putKey()'s own return value is built from keyMeta()'s mapper directly.
   ------------------------------------------------------------------------- */

export interface KeyMetaRow {
  provider: Provider;
  key_last4: string;
  /** The person's own name for this key (db/013), or null when they added it
      without one. Never a secret: a label a person types to tell two keys
      apart, capped and trimmed at the endpoint before it is ever stored. */
  label: string | null;
  created_at: Date | string;
  rotated_at: Date | string | null;
}

export interface StoredKeyMeta {
  provider: Provider;
  last4: string;
  /** The person's own name for this key, or null when unnamed. Safe to
      render: it is display text the person supplied, not a credential. */
  label: string | null;
  createdAt: Date;
  /** null until the first replace: a key that has only ever been written
      once has never been rotated, and putKey() only sets this column on an
      ON CONFLICT path, never on the original insert. */
  rotatedAt: Date | null;
}

/** Pure: a row in, the shape the rest of the app reads out. Never touches
    ciphertext, iv, auth_tag, or key_fingerprint, because KeyMetaRow itself
    has no such fields: the SELECT in keyMeta() below does not ask Postgres
    for them, so there is nothing here that could leak them even by a
    careless spread. */
export function rowToStoredKeyMeta(row: KeyMetaRow): StoredKeyMeta {
  return {
    provider: row.provider,
    last4: row.key_last4,
    label: row.label,
    createdAt: toDate(row.created_at),
    rotatedAt: row.rotated_at === null ? null : toDate(row.rotated_at)
  };
}

/* -------------------------------------------------------------------------
   Writes.
   ------------------------------------------------------------------------- */

/**
 * Stores one provider key for one user: validates its shape, encrypts it,
 * and upserts the row. A second call for the same (userId, provider) is a
 * rotation, not a duplicate: db/007's primary key is (user_id, provider),
 * so the ON CONFLICT path replaces every column that came from the new
 * plaintext (ciphertext, iv, auth_tag, key_last4, key_fingerprint) and sets
 * rotated_at to the moment of the replace, while leaving created_at exactly
 * as it was on the row's original insert. That split (touch rotated_at,
 * never touch created_at, on the conflict path) is what lets keyMeta()
 * report both "when was this first added" and "when did it last change"
 * from the same row, no history table required.
 *
 * created_at and rotated_at are set here with SQL `now()` and a literal
 * `NULL`, not passed in as parameters, on purpose: the INSERT branch of an
 * upsert supplies the row's starting values, and this file, not the
 * database's own column defaults (which db/007 may or may not declare), is
 * what this function's own contract depends on. Explicit here means the
 * behaviour described in this comment holds even if that migration never
 * adds a DEFAULT now() to created_at.
 */
export async function putKey(
  userId: string,
  provider: Provider,
  plaintext: string,
  label: string | null = null
): Promise<StoredKeyMeta> {
  const shape = validateKeyShape(provider, plaintext);
  if (!shape.ok) {
    throw new InvalidKeyShapeError(shape.reason);
  }

  const parts: EncryptedKeyParts = encryptKey(userId, plaintext);
  const keyLast4 = last4(plaintext);
  const keyFingerprint = fingerprint(plaintext);

  // label travels as a placeholder like every other value; it is display text
  // the caller already trimmed and capped (see settings/keys/save.ts), not a
  // secret, so it is the one column here safe to return in RETURNING alongside
  // the last four. On a replace, EXCLUDED.label wins: re-saving a provider with
  // the name field left blank clears the old name, which matches a form that
  // shows the name field fresh on every submission.
  //
  // writing_model (db/024) IS DELIBERATELY ABSENT FROM THE DO UPDATE SET, and
  // that absence is load-bearing: rotating a key must not silently reset the
  // model the person chose for drafting. Adding it here would do exactly that.
  const { rows } = await db().query<KeyMetaRow>(
    `INSERT INTO user_provider_key
       (user_id, provider, ciphertext, iv, auth_tag, key_last4, key_fingerprint, label, created_at, rotated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), NULL)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       key_last4 = EXCLUDED.key_last4,
       key_fingerprint = EXCLUDED.key_fingerprint,
       label = EXCLUDED.label,
       rotated_at = now()
     RETURNING provider, key_last4, label, created_at, rotated_at`,
    [userId, provider, parts.ciphertext, parts.iv, parts.authTag, keyLast4, keyFingerprint, label]
  );

  return rowToStoredKeyMeta(rows[0]);
}

/** Removes one stored key. Returns whether a row was actually removed, the
    same "gone versus never there" distinction deleteEntry() in
    record-store.ts and unsaveJob() in desk-store.ts both return. */
export async function deleteKey(userId: string, provider: Provider): Promise<boolean> {
  const result = await db().query('DELETE FROM user_provider_key WHERE user_id = $1 AND provider = $2', [
    userId,
    provider
  ]);
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------
   Reads.
   ------------------------------------------------------------------------- */

/**
 * Opens one stored key. THE ONLY DECRYPT PATH IN THIS FILE, AND IN THIS
 * CODEBASE: nothing else calls keychain.ts's decryptKey(). Returns null,
 * never throws, when this user has no row for this provider, which is the
 * ordinary "never connected this provider" state, not an error. A row that
 * exists but fails to decrypt (a tampered row, or one somehow sealed under
 * a different user's subkey) still throws keychain.ts's own
 * KeychainTamperError; that is not caught here, because a caller receiving
 * `string | null` needs to be able to tell "no key" apart from "a key that
 * exists but cannot be trusted", and collapsing the second case into null
 * would hide exactly the failure this function's whole design exists to
 * surface.
 */
export async function getDecryptedKey(userId: string, provider: Provider): Promise<string | null> {
  const { rows } = await db().query<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(
    'SELECT ciphertext, iv, auth_tag FROM user_provider_key WHERE user_id = $1 AND provider = $2',
    [userId, provider]
  );
  const row = rows[0];
  if (!row) return null;

  return decryptKey(userId, { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag });
}

/**
 * Every provider this person has a stored key for, without ever selecting
 * ciphertext, iv, auth_tag, or key_fingerprint: the SELECT list is the
 * enforcement, not a convention layered on top of a wider row. A caller
 * that wants to render "connected providers" in a settings page gets
 * exactly the columns that are safe to render (provider, last4, two
 * timestamps) and has no way to reach the sealed columns through this
 * function even by mistake.
 */
export async function keyMeta(userId: string): Promise<StoredKeyMeta[]> {
  const { rows } = await db().query<KeyMetaRow>(
    'SELECT provider, key_last4, label, created_at, rotated_at FROM user_provider_key WHERE user_id = $1 ORDER BY provider',
    [userId]
  );
  return rows.map(rowToStoredKeyMeta);
}

/** Whether this person has a stored key for this provider, with no row
    data returned at all, for callers (an entitlement check, a UI toggle)
    that only need a boolean and should not receive anything more. */
export async function hasKey(userId: string, provider: Provider): Promise<boolean> {
  const { rows } = await db().query(
    'SELECT 1 FROM user_provider_key WHERE user_id = $1 AND provider = $2',
    [userId, provider]
  );
  return rows.length > 0;
}

/* -------------------------------------------------------------------------
   The writing model choice (db/024). Display data on the same row as the key
   it applies to, never a secret, and never selected alongside ciphertext.
   ------------------------------------------------------------------------- */

/**
 * The model this person chose for drafting with this provider, or null when
 * they have not chosen, have no key, or chose something this registry no
 * longer offers.
 *
 * VALIDATED ON THE WAY OUT, not only on the way in. A model id stored months
 * ago can be retired by its provider, and the registry it was chosen from is
 * the only thing that knows. Returning null for an id that is no longer
 * offered is what lets a retirement in generation-providers.ts quietly return
 * everyone who picked it to that provider's default, instead of sending an
 * id the API will reject.
 */
export async function getWritingModel(userId: string, provider: Provider): Promise<string | null> {
  const { rows } = await db().query<{ writing_model: string | null }>(
    'SELECT writing_model FROM user_provider_key WHERE user_id = $1 AND provider = $2',
    [userId, provider]
  );
  const stored = rows[0]?.writing_model ?? null;
  if (stored === null) return null;
  return isKnownWritingModel(provider, stored) ? stored : null;
}

/**
 * Records the model this person chose for drafting with this provider.
 * Refuses an id the registry does not offer rather than storing it: the
 * endpoint checks the same thing first, and this is the floor under that, the
 * same way db/024's length CHECK is the floor under both.
 *
 * Returns whether a row was actually updated, the same "gone versus never
 * there" shape setPersonName() and setGenerationPreference() return, so the
 * caller can tell "no key for that provider" apart from a silent no-op.
 */
export async function setWritingModel(userId: string, provider: Provider, modelId: string): Promise<boolean> {
  if (!isKnownWritingModel(provider, modelId)) {
    return false;
  }
  const result = await db().query(
    'UPDATE user_provider_key SET writing_model = $3 WHERE user_id = $1 AND provider = $2',
    [userId, provider, modelId]
  );
  return (result.rowCount ?? 0) > 0;
}
