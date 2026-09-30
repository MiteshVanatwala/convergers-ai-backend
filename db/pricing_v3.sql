-- pricing_v3.sql
--
-- Prices are GST-inclusive (decided 2026-09-30): ₹799 Pro = ₹677.12 + ₹121.88
-- GST. At 1,000 credits per $1 of provider cost, Pro's 8,000 credits cost more
-- than the ₹677 net revenue — 5,000 keeps a margin in line with the credit packs.
--
-- Also records the per-unit price on each subscription, so invoices use what
-- the subscriber actually pays even after a plan's list price changes.
--
-- Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/pricing_v3.sql
-- =========================================================================

BEGIN;

UPDATE plans SET included_credits = 5000 WHERE key = 'pro';

-- Price per unit (per seat for Team) at the time the subscription was created, in INR paise.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS unit_amount_paise integer;
UPDATE subscriptions s
SET unit_amount_paise = COALESCE(p.razorpay_plan_amount_paise, p.price_inr_paise)
FROM plans p
WHERE p.id = s.plan_id AND s.unit_amount_paise IS NULL;

COMMIT;
