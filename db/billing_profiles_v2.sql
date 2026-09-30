-- billing_profiles_v2.sql
--
-- City and PIN code as their own fields (the checkout's billing step asks for
-- street, city, PIN and state separately; invoices print them on the address).
--
-- Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/billing_profiles_v2.sql
-- =========================================================================

BEGIN;

ALTER TABLE billing_profiles ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE billing_profiles ADD COLUMN IF NOT EXISTS postal_code text;

COMMIT;
