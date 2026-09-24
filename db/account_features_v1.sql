-- Convergers AI — per-account feature overrides
--
-- Apply AFTER plan_features_v1.sql (feature_catalog/plan_features must
-- already exist) + admin_management.sql. Idempotent throughout.
--
-- A second, higher-priority source of truth on top of plan_features: by
-- default an account gets whatever features its plan includes (unchanged),
-- but an admin can grant a feature beyond the plan or revoke one the plan
-- would otherwise include, for exactly one account. No row for a (account,
-- feature) pair means "inherit from plan" — the only behavior that existed
-- before this migration.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/account_features_v1.sql
-- =========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS account_features (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES feature_catalog(key) ON DELETE CASCADE,
  granted     boolean NOT NULL,
  created_by  uuid REFERENCES admin_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, feature_key)
);

INSERT INTO permissions (key, description) VALUES
  ('account.manage_features', 'Grant or revoke an individual feature for one account, overriding its plan')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role, permission_key) VALUES
  ('engineering_admin', 'account.manage_features')
ON CONFLICT (role, permission_key) DO NOTHING;

ALTER TABLE account_features ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'account_features' AND policyname = 'admin_read') THEN
    CREATE POLICY admin_read ON account_features FOR SELECT USING (is_admin_context());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'account_features' AND policyname = 'admin_write') THEN
    CREATE POLICY admin_write ON account_features FOR INSERT
      WITH CHECK (admin_has_permission(current_admin_id(), 'account.manage_features'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'account_features' AND policyname = 'admin_update') THEN
    CREATE POLICY admin_update ON account_features FOR UPDATE
      USING (is_admin_context()) WITH CHECK (admin_has_permission(current_admin_id(), 'account.manage_features'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'account_features' AND policyname = 'admin_delete') THEN
    CREATE POLICY admin_delete ON account_features FOR DELETE
      USING (admin_has_permission(current_admin_id(), 'account.manage_features'));
  END IF;
EXCEPTION
  WHEN undefined_function THEN
    RAISE NOTICE 'RLS helper functions missing — skip account_features policies (run rls.sql first)';
END $$;

DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON account_features TO app_admin;
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'app_admin role not present — grant skipped (dev owner role is fine)';
END $$;

COMMIT;
