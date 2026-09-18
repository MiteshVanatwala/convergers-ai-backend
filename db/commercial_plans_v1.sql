-- =========================================================================
-- commercial_plans_v1.sql
--
-- Seed Option E commercial catalog into `plans`.
-- Apply AFTER schema.sql (`plans` table must exist).
--
-- Catalog (locked product direction):
--   free            — trial; signup credits from SIGNUP_GRANT_CREDITS env
--   pro             — $20/mo subscription; 15_000 included credits (~$15 usage)
--   pay_as_you_go   — no subscription; prepaid packs later; RPM still capped
--   enterprise      — custom; price / credits / RPM set per contract later
--
-- Money math (ledger.service.ts): 1000 credits = $1.00 native provider cost.
--
-- Idempotent: ON CONFLICT (key) DO UPDATE refreshes display fields / limits.
-- Does NOT create subscriptions, attach accounts, or change signup env grants.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/commercial_plans_v1.sql
--   psql -U postgres -d convergers_ai -f db/account_plans_v1.sql   -- membership backfill
--
-- Plan: Docs/commercial-plans/01-greenfield-plan-structure.md (§11 approved)
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- free — $0; tight RPM; included_credits NULL (signup pack = env, not this row)
-- -------------------------------------------------------------------------
INSERT INTO plans (
  key,
  display_name,
  price_usd_cents,
  included_credits,
  rate_limit_rpm,
  features
) VALUES (
  'free',
  'Free',
  0,
  NULL,
  10,
  jsonb_build_object(
    'billing', 'none',
    'self_serve', true,
    'signup_grant', 'env',
    'tagline', 'Try Convergers with a light trial pack',
    'highlights', jsonb_build_array(
      'Chat with routed models',
      'Trial credits on signup',
      'Up to 10 requests per minute',
      'Projects & conversation history'
    )
  )
)
ON CONFLICT (key) DO UPDATE SET
  display_name     = EXCLUDED.display_name,
  price_usd_cents  = EXCLUDED.price_usd_cents,
  included_credits = EXCLUDED.included_credits,
  rate_limit_rpm   = EXCLUDED.rate_limit_rpm,
  features         = EXCLUDED.features;

-- -------------------------------------------------------------------------
-- pro — $20.00 / month; 15_000 included credits ($15 at 1000 credits/$1)
-- -------------------------------------------------------------------------
INSERT INTO plans (
  key,
  display_name,
  price_usd_cents,
  included_credits,
  rate_limit_rpm,
  features
) VALUES (
  'pro',
  'Pro',
  2000,
  15000,
  60,
  jsonb_build_object(
    'billing', 'subscription',
    'self_serve', true,
    'period', 'month',
    'top_ups_allowed', true,
    'tagline', 'For regular use with a monthly credit bucket',
    'highlights', jsonb_build_array(
      'Everything in Free',
      '15,000 credits included each month',
      'Up to 60 requests per minute',
      'Optional credit top-ups',
      'Best for predictable monthly spend'
    )
  )
)
ON CONFLICT (key) DO UPDATE SET
  display_name     = EXCLUDED.display_name,
  price_usd_cents  = EXCLUDED.price_usd_cents,
  included_credits = EXCLUDED.included_credits,
  rate_limit_rpm   = EXCLUDED.rate_limit_rpm,
  features         = EXCLUDED.features;

-- -------------------------------------------------------------------------
-- pay_as_you_go — $0 subscription; 0 period grant; packs later; RPM capped
-- -------------------------------------------------------------------------
INSERT INTO plans (
  key,
  display_name,
  price_usd_cents,
  included_credits,
  rate_limit_rpm,
  features
) VALUES (
  'pay_as_you_go',
  'Pay as you go',
  0,
  0,
  60,
  jsonb_build_object(
    'billing', 'prepaid',
    'self_serve', true,
    'suggested_pack_usd_cents', 1000,
    'suggested_pack_credits', 10000,
    'tagline', 'No subscription — prepaid credits only',
    'highlights', jsonb_build_array(
      'No monthly commitment',
      'Buy credit packs when you need them',
      'Up to 60 requests per minute',
      'Balance lasts until you use it',
      'Ideal for occasional or spiky usage'
    )
  )
)
ON CONFLICT (key) DO UPDATE SET
  display_name     = EXCLUDED.display_name,
  price_usd_cents  = EXCLUDED.price_usd_cents,
  included_credits = EXCLUDED.included_credits,
  rate_limit_rpm   = EXCLUDED.rate_limit_rpm,
  features         = EXCLUDED.features;

-- -------------------------------------------------------------------------
-- enterprise — template only; commercial terms are per-customer overrides
-- -------------------------------------------------------------------------
INSERT INTO plans (
  key,
  display_name,
  price_usd_cents,
  included_credits,
  rate_limit_rpm,
  features
) VALUES (
  'enterprise',
  'Enterprise',
  NULL,
  NULL,
  NULL,
  jsonb_build_object(
    'billing', 'custom',
    'self_serve', false,
    'contact_sales', true,
    'tagline', 'Custom limits, contract, and support',
    'highlights', jsonb_build_array(
      'Negotiated credits and rate limits',
      'Contract / invoice billing',
      'Priority support',
      'Security and compliance options',
      'Org-ready when you need it'
    )
  )
)
ON CONFLICT (key) DO UPDATE SET
  display_name     = EXCLUDED.display_name,
  price_usd_cents  = EXCLUDED.price_usd_cents,
  included_credits = EXCLUDED.included_credits,
  rate_limit_rpm   = EXCLUDED.rate_limit_rpm,
  features         = EXCLUDED.features;

COMMENT ON TABLE plans IS
  'Commercial plan catalog (Option E): free, pro, pay_as_you_go, enterprise. '
  'Free signup credits come from SIGNUP_GRANT_CREDITS env, not plans.included_credits.';

COMMIT;
