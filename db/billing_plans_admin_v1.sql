-- Convergers AI — admin-editable plan catalog
--
-- Apply AFTER schema.sql + admin_management.sql (permissions/role_permissions
-- must already exist) + commercial_plans_v1.sql (plans must already be seeded).
-- Idempotent throughout.
--
-- Adds one permission, `billing.manage_plans`, gating the new
-- PATCH /admin/plans/:key endpoint (display name, price, included credits,
-- rate limit, and the features jsonb's tagline/highlights/self_serve).
-- Read access (GET /admin/plans) needs no special permission — the same
-- catalog is already fully public to any logged-in end user via /v1/plans,
-- so gating admin *viewing* would be stricter than the data warrants; this
-- follows the same convention as /admin/stats and /admin/clients.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/billing_plans_admin_v1.sql
-- =========================================================================

BEGIN;

INSERT INTO permissions (key, description) VALUES
  ('billing.manage_plans', 'Edit plan pricing, credits, rate limits, and marketing copy')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role, permission_key) VALUES
  ('engineering_admin', 'billing.manage_plans')
ON CONFLICT (role, permission_key) DO NOTHING;

COMMIT;
