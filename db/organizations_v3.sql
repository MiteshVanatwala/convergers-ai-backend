-- organizations_v3.sql
--
-- Team tier, stages 3 & 4.
--
-- Stage 3 — org usage + masking report:
--   usage_events.org_id          — set when the request was charged to an org
--                                   pool, so org reports never count members'
--                                   personal usage from before they joined.
--   usage_events.redacted_count  — how many distinct sensitive values the
--                                   filter masked in the request.
--   usage_events.redacted_types  — which kinds (email, aadhaar, …). Only
--                                   counts and kinds are stored, never values.
--
-- Stage 4 — seat billing:
--   'team' plan: ₹499/seat/month, 3,000 credits per seat added to the org pool
--   on every successful charge (plans.included_credits is per seat).
--   subscriptions.quantity — seats on a Razorpay subscription.
--
-- Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/organizations_v3.sql
-- =========================================================================

BEGIN;

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS org_id uuid;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS redacted_count integer NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS redacted_types text[];
CREATE INDEX IF NOT EXISTS idx_usage_events_org ON usage_events (org_id, created_at DESC);

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;

INSERT INTO plans (key, display_name, price_usd_cents, price_inr_paise, included_credits, rate_limit_rpm, features)
VALUES (
  'team',
  'Team',
  NULL,
  49900,
  3000,
  60,
  '{"billing":"subscription","period":"month","per_seat":true,"tagline":"For teams: shared credits, admin controls and one bill"}'
)
ON CONFLICT (key) DO UPDATE
SET price_inr_paise = EXCLUDED.price_inr_paise,
    included_credits = EXCLUDED.included_credits,
    features = EXCLUDED.features;

COMMIT;
