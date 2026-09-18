-- =========================================================================
-- account_plans_v1.sql
--
-- Mapping table: account ↔ commercial plan (Option E).
-- Apply AFTER schema.sql and commercial_plans_v1.sql (plans rows must exist).
--
-- Why a table (not accounts.plan_id):
--   - History of plan changes (cancel old row, insert new active)
--   - Room for source, period end, external refs (Stripe), meta jsonb
--   - One active membership per account via partial unique index
--
-- Safe-ish to re-run: IF NOT EXISTS + backfill only where missing.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/commercial_plans_v1.sql
--   psql -U postgres -d convergers_ai -f db/account_plans_v1.sql
--
-- Plan: Docs/commercial-plans/02-pricing-modal-web.md
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- account_plans — entitlement / membership (not the Stripe invoice object)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id         bigint NOT NULL REFERENCES plans(id),
  -- active = current entitlement; canceled/expired = history; pending = future use
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'canceled', 'expired', 'pending')),
  -- how this row was created — extend via app validation if new sources appear
  source          text NOT NULL DEFAULT 'signup'
                    CHECK (source IN ('signup', 'self_serve', 'admin', 'stripe', 'migration')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,              -- NULL = open-ended
  canceled_at     timestamptz,
  external_ref    text,                     -- e.g. Stripe subscription id later
  meta            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE account_plans IS
  'Account ↔ plan membership. Current plan = row with status = active. '
  'Do not put plan_id on accounts — this table holds history and billing metadata.';

COMMENT ON COLUMN account_plans.external_ref IS
  'Provider-side id (e.g. Stripe subscription). Nullable until billing is wired.';

COMMENT ON COLUMN account_plans.meta IS
  'Extensible bag for overrides, trial flags, etc. Never store secrets.';

-- At most one active plan per account
CREATE UNIQUE INDEX IF NOT EXISTS uniq_account_plans_one_active
  ON account_plans (account_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_account_plans_account_started
  ON account_plans (account_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_plans_plan
  ON account_plans (plan_id);

-- -------------------------------------------------------------------------
-- Backfill: every account without an active membership → Free
-- -------------------------------------------------------------------------

INSERT INTO account_plans (account_id, plan_id, status, source, meta)
SELECT
  a.id,
  p.id,
  'active',
  'migration',
  jsonb_build_object('backfill', true)
FROM accounts a
CROSS JOIN plans p
WHERE p.key = 'free'
  AND NOT EXISTS (
    SELECT 1
    FROM account_plans ap
    WHERE ap.account_id = a.id
      AND ap.status = 'active'
  );

COMMIT;
