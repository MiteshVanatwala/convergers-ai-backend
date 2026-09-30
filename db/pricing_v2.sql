-- pricing_v2.sql
--
-- INR pricing + monthly subscription credits.
--
-- 1. plans.price_inr_paise — the price actually charged (Razorpay is INR).
--    price_usd_cents stays for reference but the app now displays/charges INR.
-- 2. plans.razorpay_plan_amount_paise — the amount the memoized Razorpay Plan
--    (plans.razorpay_plan_id) was created with. When the price changes, the
--    backend creates a new Razorpay Plan instead of reusing the stale one.
--    Existing subscriptions keep billing at their original plan's amount.
-- 3. Pro → ₹799/month with 8,000 credits/month (was ₹1,499 charged / "$20"
--    shown, with 15,000 credits that were never actually granted).
-- 4. subscription_credit_grants — one row per Razorpay subscription payment,
--    so each charge grants the plan's included credits exactly once even
--    though both the client verify call and the subscription.charged webhook
--    report it.
--
-- Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/pricing_v2.sql
-- =========================================================================

BEGIN;

ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_inr_paise integer;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS razorpay_plan_amount_paise integer;

UPDATE plans SET price_inr_paise = 0 WHERE key IN ('free', 'pay_as_you_go');
UPDATE plans SET price_inr_paise = 79900, included_credits = 8000 WHERE key = 'pro';
-- Enterprise stays NULL (custom pricing).

-- The Pro Razorpay Plan created before this migration was ₹1,499.
UPDATE plans
SET razorpay_plan_amount_paise = 149900
WHERE key = 'pro' AND razorpay_plan_id IS NOT NULL AND razorpay_plan_amount_paise IS NULL;

CREATE TABLE IF NOT EXISTS subscription_credit_grants (
  razorpay_payment_id       text PRIMARY KEY,
  razorpay_subscription_id  text NOT NULL,
  account_id                uuid NOT NULL REFERENCES accounts(id),
  credits                   numeric(14,2) NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_credit_grants_account
  ON subscription_credit_grants (account_id, created_at DESC);

COMMIT;
