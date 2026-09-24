-- Convergers AI — bring-your-own-key + plan tier gating
--
-- Apply AFTER provider_dynamic_config.sql + provider_dynamic_config_v2.sql +
-- provider_dynamic_config_v3.sql + rls.sql + commercial_plans_v1.sql.
-- Idempotent throughout.
--
-- provider_api_keys.account_id — NULL (unchanged, today's rows) means
--   "master key, set by an admin"; a real account id means "that account's
--   own key for this credential." Same table, same encryption, same
--   deactivate-then-insert upsert pattern as the admin-set master keys —
--   this *is* "one table for all keys."
--
-- provider_tier_access — which plans can use a given model via the MASTER
--   key. Seeded fully open (every model × every plan) so nothing changes for
--   existing usage the moment this ships; an account's own key always
--   bypasses this check entirely (it's their own resource).
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/provider_byok_tier_access_v1.sql
-- =========================================================================

BEGIN;

-- =========================================================================
-- provider_api_keys — add account ownership
-- =========================================================================

ALTER TABLE provider_api_keys
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_provider_api_keys_account
  ON provider_api_keys (account_id, provider_id)
  WHERE account_id IS NOT NULL;

-- Self-service RLS: an account manages only its own rows. Admin policies
-- (admin_read/admin_write/admin_update/admin_delete, rls.sql) are unchanged
-- and still see/manage every row, master or user-owned.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'provider_api_keys' AND policyname = 'user_read'
  ) THEN
    CREATE POLICY user_read ON provider_api_keys FOR SELECT
      USING (account_id IS NOT NULL AND account_id = current_account_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'provider_api_keys' AND policyname = 'user_write'
  ) THEN
    CREATE POLICY user_write ON provider_api_keys FOR INSERT
      WITH CHECK (account_id IS NOT NULL AND account_id = current_account_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'provider_api_keys' AND policyname = 'user_update'
  ) THEN
    CREATE POLICY user_update ON provider_api_keys FOR UPDATE
      USING (account_id IS NOT NULL AND account_id = current_account_id())
      WITH CHECK (account_id IS NOT NULL AND account_id = current_account_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'provider_api_keys' AND policyname = 'user_delete'
  ) THEN
    CREATE POLICY user_delete ON provider_api_keys FOR DELETE
      USING (account_id IS NOT NULL AND account_id = current_account_id());
  END IF;
EXCEPTION
  WHEN undefined_function THEN
    RAISE NOTICE 'RLS helper functions missing — skip provider_api_keys self-service policies (run rls.sql first)';
END $$;

DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON provider_api_keys TO app_user;
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'app_user role not present — grant skipped (dev owner role is fine)';
END $$;


-- =========================================================================
-- provider_tier_access — which plans unlock a model via the master key
-- =========================================================================

CREATE TABLE IF NOT EXISTS provider_tier_access (
  provider_id  text NOT NULL REFERENCES provider_registry(id) ON DELETE CASCADE,
  plan_key     text NOT NULL REFERENCES plans(key),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, plan_key)
);

-- Fully open by default: every existing model, every existing plan.
INSERT INTO provider_tier_access (provider_id, plan_key)
SELECT pr.id, p.key
FROM provider_registry pr
CROSS JOIN plans p
ON CONFLICT (provider_id, plan_key) DO NOTHING;

ALTER TABLE provider_tier_access ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'provider_tier_access' AND policyname = 'admin_read'
  ) THEN
    CREATE POLICY admin_read ON provider_tier_access FOR SELECT USING (is_admin_context());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'provider_tier_access' AND policyname = 'admin_write'
  ) THEN
    CREATE POLICY admin_write ON provider_tier_access FOR INSERT
      WITH CHECK (admin_has_permission(current_admin_id(), 'provider.manage_routing'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'provider_tier_access' AND policyname = 'admin_delete'
  ) THEN
    CREATE POLICY admin_delete ON provider_tier_access FOR DELETE
      USING (admin_has_permission(current_admin_id(), 'provider.manage_routing'));
  END IF;
EXCEPTION
  WHEN undefined_function THEN
    RAISE NOTICE 'RLS helper functions missing — skip provider_tier_access policies (run rls.sql first)';
END $$;

DO $$
BEGIN
  GRANT SELECT, INSERT, DELETE ON provider_tier_access TO app_admin;
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'app_admin role not present — grant skipped (dev owner role is fine)';
END $$;

COMMIT;
