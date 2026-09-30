-- auto_topup_v1.sql
--
-- Pay-as-you-go auto top-up: the first pack purchase saves the card as a
-- Razorpay recurring token (card-on-file, "as_presented"); afterwards, when a
-- personal balance drops below the threshold, that pack is charged to the card.
--
-- Apply AFTER billing_profiles_v2.sql. Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/auto_topup_v1.sql
-- =========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS auto_topup_settings (
  account_id            uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- pending: card not saved yet | active | paused: turned off by the user | failed: last charge failed
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'paused', 'failed')),
  package_id            text NOT NULL,
  threshold_credits     integer NOT NULL CHECK (threshold_credits > 0),
  contact               text NOT NULL,
  razorpay_customer_id  text NOT NULL,
  razorpay_token_id     text,
  card_network          text,
  card_last4            text,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- manual: bought in Checkout | auto_topup_setup: first purchase that saves the card | auto_topup: charged to the saved card
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE credit_purchases ADD COLUMN IF NOT EXISTS failure_reason text;

CREATE INDEX IF NOT EXISTS idx_credit_purchases_auto_topup
  ON credit_purchases (account_id, created_at DESC) WHERE source = 'auto_topup';

COMMIT;
