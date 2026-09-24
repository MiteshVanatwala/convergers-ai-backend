-- Convergers AI — plan feature catalog
--
-- Apply AFTER schema.sql + billing_plans_admin_v1.sql (billing.manage_plans
-- permission must already exist) + commercial_plans_v1.sql (plans seeded).
-- Idempotent throughout.
--
-- Replaces the freeform `plans.features.highlights` text array with a real,
-- admin-managed catalog: `feature_catalog` (what a feature IS) x
-- `plan_features` (which plans have it) — same shape as
-- provider_byok_tier_access_v1.sql's provider_tier_access, one row per
-- (plan, entity) toggle. A plan's pricing-card highlight bullets are now
-- COMPUTED from this join (see plan-features.service.ts), not stored.
--
-- Seed reproduces every plan's current on-screen highlights exactly — the
-- `sort_order` values below use generous per-plan gaps specifically so that,
-- once merged into one global ordering, each plan's own subset still sorts
-- back into its original bullet order (only "Up to 60 requests per minute"
-- is shared, by Pro and Pay-as-you-go, and both happen to want it 3rd of 5
-- — verified by hand, not an accident of the numbering).
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/plan_features_v1.sql
-- =========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS feature_catalog (
  key         text PRIMARY KEY,
  label       text NOT NULL,
  description text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_features (
  plan_key    text NOT NULL REFERENCES plans(key),
  feature_key text NOT NULL REFERENCES feature_catalog(key) ON DELETE CASCADE,
  PRIMARY KEY (plan_key, feature_key)
);

INSERT INTO feature_catalog (key, label, sort_order) VALUES
  ('chat_with_routed_models',              'Chat with routed models',                 10),
  ('trial_credits_on_signup',              'Trial credits on signup',                 20),
  ('up_to_10_requests_per_minute',         'Up to 10 requests per minute',            30),
  ('projects_conversation_history',        'Projects & conversation history',         40),
  ('everything_in_free',                   'Everything in Free',                     100),
  ('15000_credits_included_each_month',    '15,000 credits included each month',     200),
  ('no_monthly_commitment',                'No monthly commitment',                  250),
  ('buy_credit_packs_when_you_need_them',  'Buy credit packs when you need them',    275),
  ('up_to_60_requests_per_minute',         'Up to 60 requests per minute',           300),
  ('balance_lasts_until_you_use_it',       'Balance lasts until you use it',         325),
  ('ideal_for_occasional_or_spiky_usage',  'Ideal for occasional or spiky usage',    350),
  ('optional_credit_top_ups',              'Optional credit top-ups',                400),
  ('best_for_predictable_monthly_spend',   'Best for predictable monthly spend',     500),
  ('negotiated_credits_and_rate_limits',   'Negotiated credits and rate limits',     600),
  ('contract_invoice_billing',             'Contract / invoice billing',             700),
  ('priority_support',                     'Priority support',                       800),
  ('security_and_compliance_options',      'Security and compliance options',        900),
  ('org_ready_when_you_need_it',           'Org-ready when you need it',            1000)
ON CONFLICT (key) DO NOTHING;

INSERT INTO plan_features (plan_key, feature_key) VALUES
  ('free', 'chat_with_routed_models'),
  ('free', 'trial_credits_on_signup'),
  ('free', 'up_to_10_requests_per_minute'),
  ('free', 'projects_conversation_history'),

  ('pro', 'everything_in_free'),
  ('pro', '15000_credits_included_each_month'),
  ('pro', 'up_to_60_requests_per_minute'),
  ('pro', 'optional_credit_top_ups'),
  ('pro', 'best_for_predictable_monthly_spend'),

  ('pay_as_you_go', 'no_monthly_commitment'),
  ('pay_as_you_go', 'buy_credit_packs_when_you_need_them'),
  ('pay_as_you_go', 'up_to_60_requests_per_minute'),
  ('pay_as_you_go', 'balance_lasts_until_you_use_it'),
  ('pay_as_you_go', 'ideal_for_occasional_or_spiky_usage'),

  ('enterprise', 'negotiated_credits_and_rate_limits'),
  ('enterprise', 'contract_invoice_billing'),
  ('enterprise', 'priority_support'),
  ('enterprise', 'security_and_compliance_options'),
  ('enterprise', 'org_ready_when_you_need_it')
ON CONFLICT (plan_key, feature_key) DO NOTHING;

-- The old stored array is now dead weight — highlights are computed from
-- the join above (see plan-features.service.ts's getHighlightsByPlan()).
UPDATE plans SET features = features - 'highlights';

ALTER TABLE feature_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_features ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'feature_catalog' AND policyname = 'admin_read') THEN
    CREATE POLICY admin_read ON feature_catalog FOR SELECT USING (is_admin_context());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'feature_catalog' AND policyname = 'admin_write') THEN
    CREATE POLICY admin_write ON feature_catalog FOR INSERT
      WITH CHECK (admin_has_permission(current_admin_id(), 'billing.manage_plans'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'feature_catalog' AND policyname = 'admin_update') THEN
    CREATE POLICY admin_update ON feature_catalog FOR UPDATE
      USING (is_admin_context()) WITH CHECK (admin_has_permission(current_admin_id(), 'billing.manage_plans'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'feature_catalog' AND policyname = 'admin_delete') THEN
    CREATE POLICY admin_delete ON feature_catalog FOR DELETE
      USING (admin_has_permission(current_admin_id(), 'billing.manage_plans'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'plan_features' AND policyname = 'admin_read') THEN
    CREATE POLICY admin_read ON plan_features FOR SELECT USING (is_admin_context());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'plan_features' AND policyname = 'admin_write') THEN
    CREATE POLICY admin_write ON plan_features FOR INSERT
      WITH CHECK (admin_has_permission(current_admin_id(), 'billing.manage_plans'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'plan_features' AND policyname = 'admin_delete') THEN
    CREATE POLICY admin_delete ON plan_features FOR DELETE
      USING (admin_has_permission(current_admin_id(), 'billing.manage_plans'));
  END IF;
EXCEPTION
  WHEN undefined_function THEN
    RAISE NOTICE 'RLS helper functions missing — skip feature_catalog/plan_features policies (run rls.sql first)';
END $$;

DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON feature_catalog, plan_features TO app_admin;
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'app_admin role not present — grant skipped (dev owner role is fine)';
END $$;

COMMIT;
