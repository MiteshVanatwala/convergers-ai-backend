-- organizations_v2.sql
--
-- Team tier, stage 2: pool top-ups. A credit purchase with org_id set tops
-- up that organization's shared pool instead of the buyer's own wallet
-- (account_id stays the admin who paid).
--
-- Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/organizations_v2.sql
-- =========================================================================

BEGIN;

ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);

COMMIT;
