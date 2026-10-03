-- seller_settings_v1.sql
--
-- Seller (supplier) details for GST invoices, editable from the admin panel's
-- Invoicing page instead of only via backend/.env. One row. Any field left
-- NULL falls back to the SELLER_* / INVOICE_* env vars.
--
-- Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/seller_settings_v1.sql
-- =========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS seller_settings (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),  -- single row
  legal_name      text,
  gstin           text,
  address         text,
  sac_code        text,
  invoice_prefix  text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES admin_users(id)
);

COMMIT;
