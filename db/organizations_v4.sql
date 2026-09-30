-- organizations_v4.sql
--
-- Team plan seat changes. Increases apply immediately (on Razorpay and here);
-- decreases are scheduled for the end of the billing cycle on Razorpay and
-- recorded in pending_quantity until the next subscription.charged webhook
-- brings the new quantity.
--
-- Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/organizations_v4.sql
-- =========================================================================

BEGIN;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_quantity integer;

COMMIT;
