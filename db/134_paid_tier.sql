-- The paid tier slot (2026-09-10). Unenforced: no ROUTE_POLICY entry names it
-- yet and nothing charges anyone. It exists so a tier can be set by hand on an
-- account today and so the entitlement ranks (public 0, member 10, paid 15,
-- internal 20) are the same in the database and in src/lib/entitlement.ts.
DO $$
DECLARE
  con text;
BEGIN
  SELECT conname INTO con
    FROM pg_constraint
   WHERE conrelid = 'app_user_profile'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%tier%';
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE app_user_profile DROP CONSTRAINT %I', con);
  END IF;
END $$;
ALTER TABLE app_user_profile
  ADD CONSTRAINT app_user_profile_tier_check CHECK (tier IN ('public', 'member', 'paid', 'internal'));
