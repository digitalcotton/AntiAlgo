-- 206: which provider key drafts for this account.
--
-- WHY THIS COLUMN EXISTS. Until now the draft pipeline picked the first key
-- it found in a fixed order written into the code (anthropic, openai, kimi,
-- deepseek), inherited from a page that no longer exists. Nobody chose that
-- order, the reader could not see it, and it meant connecting a second key
-- silently moved a person's drafting, and their bill, to a different vendor.
-- The account now names the one provider it drafts with.
--
-- NULL IS A REAL STATE, not a missing value: it means the account has never
-- designated one. The pipeline reads it as "use the only key on file, if
-- there is exactly one", and never as "pick one for them".
--
-- No CHECK against the provider list here on purpose. user_provider_key
-- already constrains its own provider column, and this value is validated in
-- TypeScript before it is written; a second list to keep in step would be a
-- second thing to forget.
ALTER TABLE app_user_profile
  ADD COLUMN IF NOT EXISTS drafting_provider text;

COMMENT ON COLUMN app_user_profile.drafting_provider IS
  'The provider key this account drafts with. NULL means none designated; the pipeline then uses the only key on file, or none.';
