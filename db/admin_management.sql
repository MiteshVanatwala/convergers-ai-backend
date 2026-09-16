-- =========================================================================
-- admin_management.sql
--
-- Admin operators management (admin_users roster + audit enrichment).
-- Apply AFTER schema.sql and admin_auth.sql (admin_users + admin_sessions
-- must already exist).
--
-- Safe-ish to re-run: IF NOT EXISTS / guarded UPDATE.
--
-- Adds:
--   admin_users.display_name  — optional human label in the Admins UI
--   admin_users.is_bootstrap  — protects the seeded system operator
--   admin_audit_log.meta      — structured diffs (role from/to, etc.)
--
-- Does NOT add must_change_password / forced first-login change — deferred.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/admin_management.sql
--
-- Plan: Docs/admin-panel/20-admin-operators-management-plan.md
-- =========================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =========================================================================
-- admin_users — operator profile / bootstrap flag
-- =========================================================================

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS is_bootstrap boolean NOT NULL DEFAULT false;

-- Seeded system operator from admin_auth.sql — break-glass bootstrap.
-- App code must refuse deactivate / demote / username rename when true.
UPDATE admin_users
SET is_bootstrap = true
WHERE username = 'system'
  AND is_bootstrap IS DISTINCT FROM true;


-- =========================================================================
-- admin_audit_log — structured metadata (never passwords / hashes)
-- =========================================================================

ALTER TABLE admin_audit_log
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}';

COMMENT ON COLUMN admin_audit_log.meta IS
  'Structured audit detail, e.g. {"from":"support","to":"ops_business"}. Never store passwords or password hashes.';

COMMIT;
