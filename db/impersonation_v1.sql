-- Convergers AI — admin impersonation
--
-- Apply AFTER google_auth.sql (sessions table must exist) + admin_management.sql.
-- Idempotent throughout.
--
-- Extends the existing `sessions` table rather than adding a parallel one —
-- an impersonation session IS a real web session, just admin-initiated and
-- short-lived. impersonated_by IS NULL for every session created before this
-- migration and for every normal login going forward; a non-null value
-- marks exactly who started it and why (impersonation_reason).
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/impersonation_v1.sql
-- =========================================================================

BEGIN;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS impersonated_by uuid REFERENCES admin_users(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS impersonation_reason text;

INSERT INTO permissions (key, description) VALUES
  ('account.impersonate', 'Start a session as another account (impersonation) — full account access, always audit-logged')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role, permission_key) VALUES
  ('engineering_admin', 'account.impersonate')
ON CONFLICT (role, permission_key) DO NOTHING;

COMMIT;
