-- Convergers AI — recurring free credit grants
--
-- Apply AFTER schema.sql + commercial_plans_v1.sql (plans seeded).
-- Idempotent throughout.
--
-- A lazily-evaluated rolling window, not a scheduled/cron reset: each
-- account carries its own last_recurring_grant_at, checked and topped up
-- right when its balance is actually read or spent (see
-- ledger.service.ts's applyDueRecurringGrant). recurring_grant_period_hours
-- IS NULL means "no recurring grant for this plan" — the default for every
-- plan except Free, which is seeded with a daily 20-credit grant as the
-- concrete answer to "how do ChatGPT/Claude's free daily credits work."
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/recurring_credit_grants_v1.sql
-- =========================================================================

BEGIN;

ALTER TABLE plans ADD COLUMN IF NOT EXISTS recurring_grant_credits integer NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS recurring_grant_period_hours integer;

ALTER TABLE credit_wallets ADD COLUMN IF NOT EXISTS last_recurring_grant_at timestamptz;

UPDATE plans
SET recurring_grant_credits = 20, recurring_grant_period_hours = 24
WHERE key = 'free';

COMMIT;
