-- 007_user_provider_key.sql
--
-- Bring-your-own API key for the tailor engine (MASTER-SPEC decision D7).
-- One row per person per provider: the ciphertext of a key they entered
-- themselves, plus enough metadata to show it back to them without ever
-- decrypting it again.
--
-- CLASS SECRET, MASTER-SPEC SECTION 7'S COLUMN CLASSIFICATION. Every other
-- table this run has written is public, unlisted, or private: a fact about
-- a person, shaped for a person to read back. This table is the one
-- exception, and D7's rules are what make it safe to hold at all. Keys are
-- per-user, never pooled across accounts and never shared with a second
-- person's renders. Never logged: no statement anywhere in this codebase
-- may print ciphertext, a decrypted key, or a full key alongside a
-- request, a stack trace, or a metrics line. Never exported: PERSON_TABLES
-- (src/lib/account.ts) marks this table includedInExport: false, because a
-- live credential is not a record of what a person did, the same
-- reasoning that already withholds account.password and account
-- .accessToken/.refreshToken/.idToken from that same export. Decrypted
-- only at the moment of generation: the tailor engine reads the row,
-- decrypts in memory for exactly the one call that needs the plaintext key,
-- and the plaintext never touches a column, a log line, or a response
-- body. The endpoints a decrypted key is used against are hardcoded
-- constants in the provider adapter, never a user-supplied base URL: D7
-- names the alternative explicitly (a custom "compatible endpoint" is a
-- resume-harvesting proxy and an SSRF vector) and this schema gives that
-- endpoint nowhere to live, because there is no column here for one.
--
-- THE CRYPTO CONTRACT THIS TABLE'S COLUMNS PROMISE, OWNED BY A LATER TASK.
-- This migration does not encrypt anything; a keychain module (a separate
-- task) does, and these three columns are the shape it must produce:
-- ciphertext, a 12-byte iv (the AES-256-GCM standard nonce length), and a
-- 16-byte auth_tag (GCM's full authentication tag, not truncated). The
-- ciphertext is bound to its owner through per-user subkey derivation, not
-- through this table's PRIMARY KEY alone: PRIMARY KEY (user_id, provider)
-- stops one person's ciphertext from ever landing under another person's
-- id by a write-path bug, but it does nothing to stop the ciphertext
-- itself from decrypting successfully under the wrong key if a row were
-- ever copied between users by hand (a restore from an old backup, a
-- migration mistake). A per-user subkey derived from user_id makes a copied
-- row fail to decrypt under any key but its own owner's, which is a
-- property this table's shape cannot provide by itself and must not be
-- mistaken for providing.
--
-- Run with:  npm run db:migrate
-- Safe to run repeatedly. Every statement is guarded.

CREATE TABLE IF NOT EXISTS user_provider_key (
  -- Matches Better Auth's user.id (text, not uuid), the same convention
  -- every other person-owned table in this repo follows. ON DELETE CASCADE
  -- for the reason db/001 gives for app_user_profile, restated here with
  -- the sharper edge a secret adds: a key outliving its owner is not just a
  -- fact attached to nobody, it is a live credential attached to nobody,
  -- and the next account to reuse this id must never be able to reach it.
  user_id         text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

  -- CHECK rather than a Postgres enum, for the reason db/001 gives for
  -- tier: the next provider is an ALTER of this constraint, not a heavier
  -- enum-type change. The four named here are the four D7 and
  -- src/lib/provider.ts's adapter seam were built against; a fifth
  -- provider being added is a one-line change to this list plus one case
  -- in the provider adapter, not a new table.
  provider        text NOT NULL CHECK (provider IN ('anthropic', 'openai', 'kimi', 'deepseek')),

  PRIMARY KEY (user_id, provider),

  -- AES-256-GCM's three parts, kept as three columns rather than one blob a
  -- caller would have to slice apart correctly every time it reads a row.
  -- See this file's header for the length and binding contract each one
  -- promises to the keychain module that actually produces them.
  ciphertext      bytea NOT NULL,
  iv              bytea NOT NULL,
  auth_tag        bytea NOT NULL,

  -- DISPLAY ONLY. The last few characters of the key, in the clear, so the
  -- account settings page can render "sk-ant-...a91c" without decrypting
  -- anything. 8 is generous past any real provider's key-suffix convention;
  -- the ceiling exists to stop this column from ever becoming a second,
  -- looser copy of the key itself.
  key_last4       text NOT NULL CHECK (length(key_last4) <= 8),

  -- The sha256 hex digest of the plaintext key, computed once at write
  -- time. This is what lets the settings page answer "did you paste the
  -- same key again" or "is this key still what we have on file" by
  -- comparing digests, never by decrypting the stored ciphertext to check.
  -- A fingerprint is a one-way function of the secret, not the secret
  -- itself, and is not covered by this table's SECRET classification the
  -- way ciphertext, iv and auth_tag are: it may be compared and displayed
  -- in short form, but it is still never the plaintext key and this
  -- migration takes no position on exporting it (PERSON_TABLES governs
  -- that, not this comment).
  key_fingerprint text NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  -- The last time this key was replaced with a new one for the same
  -- (user_id, provider) pair. NULL means the key on file today is the one
  -- first entered; a person who pastes a fresh key for a provider they
  -- already have on file updates this alongside ciphertext/iv/auth_tag,
  -- rather than the row being deleted and reinserted, so created_at keeps
  -- meaning "when this person first connected this provider."
  rotated_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- updated_at maintained by the database, the same trigger pattern db/001
-- uses, for the reason it gives: a timestamp only some code paths update is
-- worse than none, because it looks authoritative.
CREATE OR REPLACE FUNCTION user_provider_key_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_provider_key_touch_trigger ON user_provider_key;
CREATE TRIGGER user_provider_key_touch_trigger
  BEFORE UPDATE ON user_provider_key
  FOR EACH ROW EXECUTE FUNCTION user_provider_key_touch();
