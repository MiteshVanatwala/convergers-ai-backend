-- plan_features_v2.sql
--
-- Pricing-card bullets out of step with the plans:
--   * Pro listed "15,000 credits included each month" — Pro includes 5,000
--     since pricing_v3. The amount is already printed under the price, so the
--     bullet no longer names a number.
--   * Team had no bullets at all.
--
-- Apply AFTER plan_features_v1.sql and organizations_v1.sql. Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/plan_features_v2.sql
-- =========================================================================

BEGIN;

INSERT INTO feature_catalog (key, label, sort_order) VALUES
  ('monthly_credits_included',            'Monthly credits included',               200),
  ('shared_credit_pool',                  'Shared credit pool for the whole team',  610),
  ('admin_controls_member_limits',        'Admin controls and per-member limits',   620),
  ('org_wide_sensitive_data_filter',      'Sensitive-data filter for everyone',     630),
  ('choose_allowed_models',               'Choose which models the team can use',   640),
  ('one_gst_invoice',                     'One GST invoice for the team',           650)
ON CONFLICT (key) DO NOTHING;

-- Pro: swap the outdated numbered bullet for the generic one.
INSERT INTO plan_features (plan_key, feature_key) VALUES ('pro', 'monthly_credits_included')
ON CONFLICT DO NOTHING;
DELETE FROM feature_catalog WHERE key = '15000_credits_included_each_month';

-- Team bullets.
INSERT INTO plan_features (plan_key, feature_key)
SELECT 'team', k FROM unnest(ARRAY[
  'chat_with_routed_models',
  'shared_credit_pool',
  'admin_controls_member_limits',
  'org_wide_sensitive_data_filter',
  'choose_allowed_models',
  'one_gst_invoice'
]) AS k
WHERE EXISTS (SELECT 1 FROM plans WHERE key = 'team')
ON CONFLICT DO NOTHING;

COMMIT;
