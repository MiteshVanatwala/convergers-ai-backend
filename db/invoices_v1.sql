-- invoices_v1.sql
--
-- GST tax invoices for every payment (credit purchases, Pro/Team subscription
-- charges). Prices are GST-inclusive at 18%: taxable value = total / 1.18.
-- Intra-state supply (buyer state = seller state) → CGST 9% + SGST 9%;
-- inter-state → IGST 18%. Seller details come from backend/.env (SELLER_*).
--
-- - billing_profiles: the buyer details printed on invoices — one per account
--   (personal purchases) or per organization (pool top-ups, Team plan).
-- - invoice_sequences: consecutive invoice numbers per Indian financial year
--   (Apr–Mar), locked row-by-row so two payments never share a number.
-- - invoices: one row per payment (unique on source), with seller/buyer
--   snapshots so later profile edits never change an issued invoice.
--
-- Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/invoices_v1.sql
-- =========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS billing_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  org_id      uuid UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  legal_name  text NOT NULL,
  gstin       text,
  address     text,
  -- GST state code ('27' = Maharashtra). Derived from the GSTIN when one is set.
  state_code  char(2),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_profiles_one_owner CHECK ((account_id IS NOT NULL) <> (org_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS invoice_sequences (
  financial_year  text PRIMARY KEY,  -- e.g. '2627' for Apr 2026 – Mar 2027
  last_number     integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number    text NOT NULL UNIQUE,
  account_id        uuid NOT NULL REFERENCES accounts(id),  -- who paid
  org_id            uuid REFERENCES organizations(id),       -- set for org purchases
  source_type       text NOT NULL CHECK (source_type IN ('credit_purchase', 'subscription_payment')),
  source_id         text NOT NULL,                           -- credit_purchases.id / Razorpay payment id
  issued_at         timestamptz NOT NULL DEFAULT now(),
  description       text NOT NULL,
  quantity          integer NOT NULL DEFAULT 1,
  unit_amount_paise integer NOT NULL,
  total_paise       integer NOT NULL,                        -- what was charged (GST-inclusive)
  taxable_paise     integer NOT NULL,
  cgst_paise        integer NOT NULL DEFAULT 0,
  sgst_paise        integer NOT NULL DEFAULT 0,
  igst_paise        integer NOT NULL DEFAULT 0,
  gst_rate_bp       integer NOT NULL DEFAULT 1800,           -- 18.00%
  sac_code          text,
  place_of_supply   char(2) NOT NULL,
  seller            jsonb NOT NULL,
  buyer             jsonb NOT NULL,
  UNIQUE (source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices (account_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices (org_id, issued_at DESC);

COMMIT;
