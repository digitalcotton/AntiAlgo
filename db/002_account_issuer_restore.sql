-- 003_account_issuer_restore.sql
--
-- Better Auth 1.7.1, the version this site and the index both pin, writes
-- account.issuer on every insert (verified against the running server: the
-- kysely adapter emits INSERT INTO account (issuer, ...)). The column is
-- therefore required, exactly as the index's own schema has it. An earlier
-- draft of this migration set dropped it after a stale 1.7.4 process reported
-- it as unwritten; this restores it, NOT NULL, and restores the composite
-- unique index the index uses. The table holds no rows yet, so the NOT NULL
-- add is safe. Guarded, so it is a no-op on a database built from 001 directly.

ALTER TABLE account ADD COLUMN IF NOT EXISTS issuer text;
UPDATE account SET issuer = "providerId" WHERE issuer IS NULL;
ALTER TABLE account ALTER COLUMN issuer SET NOT NULL;
DROP INDEX IF EXISTS "account_providerId_accountId_uidx";
CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_accountId_uidx" ON account (issuer, "accountId");
