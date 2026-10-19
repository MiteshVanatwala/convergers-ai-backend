-- currency_v1.sql
--
-- USD checkout for customers billed outside India. The billing country on a
-- billing profile decides the currency: IN → INR, anywhere else → USD.
-- Every payment row records the currency it was charged in; existing rows are
-- INR. Amount columns keep their names (*_paise, amount_usd_cents) and hold
-- the currency's minor unit: paise for INR, cents for USD.
--
-- USD sales are exports of services under a Letter of Undertaking (LUT): no
-- GST, and the invoice carries the LUT number (seller_settings.lut_number).
--
-- Run after seller_settings_v1.sql. Safe to re-run.
--
-- Usage:
--   pnpm run db:migrate
-- =========================================================================

BEGIN;

-- Buyer's country (ISO 3166-1 alpha-2).
ALTER TABLE billing_profiles ADD COLUMN IF NOT EXISTS country_code char(2) NOT NULL DEFAULT 'IN';

-- Currency each payment was charged in.
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_purchases_currency_check') THEN
    ALTER TABLE credit_purchases ADD CONSTRAINT credit_purchases_currency_check CHECK (currency IN ('INR', 'USD'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_currency_check') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_currency_check CHECK (currency IN ('INR', 'USD'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_currency_check') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_currency_check CHECK (currency IN ('INR', 'USD'));
  END IF;
END $$;

-- Export invoices: the LUT they were issued under (null on domestic invoices).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS lut_number text;
ALTER TABLE seller_settings ADD COLUMN IF NOT EXISTS lut_number text;

-- Razorpay Plans are single-currency: USD subscriptions get their own, memoized like the INR one.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS razorpay_plan_id_usd text;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS razorpay_plan_amount_usd_cents integer;

-- USD list prices (price_usd_cents already exists): Pro $20, Team $12 per seat.
UPDATE plans SET price_usd_cents = 2000 WHERE key = 'pro' AND price_usd_cents IS DISTINCT FROM 2000;
UPDATE plans SET price_usd_cents = 1200 WHERE key = 'team' AND price_usd_cents IS NULL;

COMMIT;
