-- Convergers AI — Razorpay credit purchases (Phase 1 of the payment gateway plan)
--
-- Apply AFTER schema.sql. Idempotent — column renames are guarded so this
-- can be rerun safely.
--
-- The schema already had Stripe-shaped columns on these three billing
-- tables (payment_methods, subscriptions, credit_purchases) from the
-- original design, but zero integration code ever referenced them —
-- confirmed via a full grep of backend/src. Renaming is free. Only
-- credit_purchases is actually wired up to code in this phase;
-- payment_methods/subscriptions are renamed now for schema consistency but
-- stay unused until the subscriptions follow-up phase.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/razorpay_credit_purchases_v1.sql
-- =========================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'credit_purchases' AND column_name = 'stripe_payment_intent_id'
  ) THEN
    ALTER TABLE credit_purchases RENAME COLUMN stripe_payment_intent_id TO razorpay_order_id;
  END IF;
END $$;

ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS razorpay_payment_id text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_methods' AND column_name = 'stripe_payment_method_id'
  ) THEN
    ALTER TABLE payment_methods RENAME COLUMN stripe_payment_method_id TO razorpay_token_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscriptions' AND column_name = 'stripe_subscription_id'
  ) THEN
    ALTER TABLE subscriptions RENAME COLUMN stripe_subscription_id TO razorpay_subscription_id;
  END IF;
END $$;

COMMIT;
