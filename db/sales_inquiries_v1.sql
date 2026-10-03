-- =========================================================================
-- sales_inquiries_v1.sql
--
-- "Contact sales" form on the pricing page (custom limits, contracts,
-- invoicing terms). Each submission is stored here — the admin panel's
-- Sales inquiries inbox reads it — and, when an email provider is
-- configured, also emailed to the sales inbox (email_sent_at records that).
--
-- Viewing / handling inquiries needs the existing `ticket.manage`
-- permission (support + engineering_admin roles).
--
-- Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/sales_inquiries_v1.sql
-- =========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS sales_inquiries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid REFERENCES accounts(id) ON DELETE SET NULL,  -- who submitted (signed in)
  name           text NOT NULL,
  email          text NOT NULL,
  company        text NOT NULL,
  phone          text,
  team_size      text,                                             -- bucket label, e.g. "11–50"
  message        text NOT NULL,
  status         text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'handled')),
  handled_by     uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  handled_at     timestamptz,
  email_sent_at  timestamptz,                                      -- null = not emailed (provider off or send failed)
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_inquiries_status_created
  ON sales_inquiries (status, created_at DESC);

DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE ON sales_inquiries TO app_admin;
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'app_admin role not present — grant skipped (dev owner role is fine)';
END $$;

COMMIT;
