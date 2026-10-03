-- organizations_v1.sql
--
-- Team tier, stage 1: organizations become usable. Builds on the
-- organizations / organization_members tables already in schema.sql.
--
-- - One organization per account (for now) — a member's requests will bill
--   the organization's shared pool (stage 2), so membership must be unambiguous.
-- - Roles: owner (one per org) | admin | member. 'billing' stays allowed for
--   compatibility with schema.sql's comment but isn't used by the app yet.
-- - Invites are by email; the invitee sees them after signing in with that
--   address (no email service yet). Pending invites expire after 14 days.
-- - Columns for later stages are added now so the schema lands in one piece:
--   org_credit_wallets + credit_ledger.org_id (shared pool, stage 2),
--   enforce_sensitive_filter / allowed_model_ids (org policy, stage 2),
--   organization_members.monthly_credit_limit (per-member limit, stage 2),
--   organizations.seats (seat billing, stage 4).
--   organization_members.seat_budget (schema.sql) is superseded by
--   monthly_credit_limit and left unused.
--
-- Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/organizations_v1.sql
-- =========================================================================

BEGIN;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enforce_sensitive_filter boolean NOT NULL DEFAULT false;
-- NULL = every model the plan allows; otherwise provider_registry ids.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS allowed_model_ids text[];
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS seats integer NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Credits one member may spend from the shared pool per calendar month; NULL = no limit.
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS monthly_credit_limit integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_role_check'
  ) THEN
    ALTER TABLE organization_members
      ADD CONSTRAINT organization_members_role_check
      CHECK (role IN ('owner', 'admin', 'member', 'billing'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_members_one_org_per_account
  ON organization_members (account_id);

CREATE TABLE IF NOT EXISTS org_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email        citext NOT NULL,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  invited_by   uuid NOT NULL REFERENCES accounts(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '14 days',
  accepted_at  timestamptz,
  revoked_at   timestamptz
);
-- At most one open invite per address per org.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_invites_open
  ON org_invites (org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_org_invites_email ON org_invites (email);

CREATE TABLE IF NOT EXISTS org_credit_wallets (
  org_id      uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  balance     numeric(14,2) NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Set on ledger rows that move the org pool (account_id = the member who spent).
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);

COMMIT;
