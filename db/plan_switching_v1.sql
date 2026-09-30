-- Convergers AI — self-service plan switching + Pro subscriptions (Phase 2)
--
-- Apply AFTER razorpay_credit_purchases_v1.sql. Idempotent.
--
-- account_plans.source has a real CHECK constraint (unlike the other
-- Stripe-shaped columns renamed in Phase 1, which had none) with a leftover
-- 'stripe' value from the original design — confirmed zero existing rows
-- use it, so renaming to 'razorpay' is safe.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/plan_switching_v1.sql
-- =========================================================================

BEGIN;

ALTER TABLE account_plans DROP CONSTRAINT IF EXISTS account_plans_source_check;
ALTER TABLE account_plans ADD CONSTRAINT account_plans_source_check
  CHECK (source IN ('signup', 'self_serve', 'admin', 'razorpay', 'migration'));

-- Memoizes the Razorpay Plan object id so it's only ever created once per
-- plan row (a Razorpay Plan is a separate, reusable entity from a
-- Subscription — created lazily on first use, see subscription.service.ts).
ALTER TABLE plans ADD COLUMN IF NOT EXISTS razorpay_plan_id text;

COMMIT;
