-- =========================================================================
-- openrouter_models_v1.sql
--
-- Open-weight models via OpenRouter, October 2026. Model slugs and prices
-- checked against OpenRouter's GET /api/v1/models/{slug}/endpoints on
-- 2026-10-22 (rates in adapters/pricing.ts; adapters in adapters/openrouter.ts).
--
-- Moves (the direct DeepSeek/GLM accounts kept failing, so those models were
-- hidden; the OpenRouter copy takes the old model's place in every Auto
-- chain, its plan access, any user's default-model pick and any org's
-- allowed-model list; the old row is kept but marked deprecated and hidden):
--   deepseek:deepseek-flash   -> openrouter:deepseek-v4.1-flash  ($0.30/$1.20)
--   deepseek:deepseek-v4-pro  -> openrouter:deepseek-v4-pro      ($1.32/$3.96)
--   glm:glm-5.3               -> openrouter:glm-5.3              ($1.40/$4.40)
--
-- Llama 3.3 70B leaves Auto routing: MiMo-V2.6-Pro takes each of its places
-- (same rank). Llama stays visible, so it can still be picked by hand.
--
-- New models (added at the END of the relevant Auto chains):
--   openrouter:mimo-v2.6-pro     MiMo-V2.6-Pro       ($0.435/$0.87)  Llama's places
--   openrouter:mimo-v2.6-flash   MiMo-V2.6 Flash     ($0.14/$0.28)   text, plan, translation
--   openrouter:gemma-4-31b       Gemma 4 31B         ($0.20/$0.40)   text, translation, writing
--   openrouter:qwen3.8-2.4t      Qwen3.8 2.4T        ($2.00/$6.00)   picked by hand only
--
-- Requires the matching backend code (adapters + pricing.ts) from the same change.
-- Safe to re-run. Run after models_2026_10.sql and routing_domains_v1.sql.
--
-- Usage:
--   pnpm run db:migrate
-- =========================================================================

BEGIN;

-- 1) Registry rows. Moved models keep the old row's capabilities.
INSERT INTO provider_registry (id, label, status, key_provider_id, capabilities, context_window, visible_to_users)
SELECT n.id, n.label, 'active', 'openrouter', old.capabilities, 1048576, true
FROM (VALUES
  ('openrouter:deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'deepseek:deepseek-flash'),
  ('openrouter:deepseek-v4-pro',     'DeepSeek V4 Pro',     'deepseek:deepseek-v4-pro'),
  ('openrouter:glm-5.3',             'GLM-5.3',             'glm:glm-5.3')
) AS n(id, label, old_id)
JOIN provider_registry old ON old.id = n.old_id
ON CONFLICT (id) DO NOTHING;

INSERT INTO provider_registry (id, label, status, key_provider_id, capabilities, context_window, visible_to_users) VALUES
  ('openrouter:mimo-v2.6-pro',   'MiMo-V2.6-Pro',   'active', 'openrouter', '["text","code","research","plan","reasoning","translation","writing"]', 1048576, true),
  ('openrouter:mimo-v2.6-flash', 'MiMo-V2.6 Flash', 'active', 'openrouter', '["text","plan","translation"]',                                         1048576, true),
  ('openrouter:gemma-4-31b',     'Gemma 4 31B',     'active', 'openrouter', '["text","translation","writing"]',                                      262144,  true),
  ('openrouter:qwen3.8-2.4t',    'Qwen3.8 2.4T',    'active', 'openrouter', '["text","code","research","plan","math","reasoning","writing"]',       1000000, true)
ON CONFLICT (id) DO NOTHING;

-- 2) Moves: every reference from the old id to the new one.
DROP TABLE IF EXISTS model_upgrades;
CREATE TEMP TABLE model_upgrades (old_id text PRIMARY KEY, new_id text NOT NULL) ON COMMIT DROP;
INSERT INTO model_upgrades VALUES
  ('deepseek:deepseek-flash',  'openrouter:deepseek-v4.1-flash'),
  ('deepseek:deepseek-v4-pro', 'openrouter:deepseek-v4-pro'),
  ('glm:glm-5.3',              'openrouter:glm-5.3');

INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
SELECT rr.task_type, u.new_id, rr.rank, rr.enabled
FROM provider_routing_rules rr
JOIN model_upgrades u ON u.old_id = rr.provider_id
ON CONFLICT (task_type, provider_id) DO NOTHING;

UPDATE provider_routing_rules SET enabled = false
WHERE provider_id IN (SELECT old_id FROM model_upgrades);

INSERT INTO provider_tier_access (provider_id, plan_key)
SELECT u.new_id, t.plan_key
FROM provider_tier_access t
JOIN model_upgrades u ON u.old_id = t.provider_id
ON CONFLICT (provider_id, plan_key) DO NOTHING;

UPDATE personalization_settings ps
SET default_provider_override = u.new_id
FROM model_upgrades u
WHERE ps.default_provider_override = u.old_id;

UPDATE organizations o
SET allowed_model_ids = (
  SELECT array_agg(DISTINCT COALESCE(u.new_id, m.id))
  FROM unnest(o.allowed_model_ids) AS m(id)
  LEFT JOIN model_upgrades u ON u.old_id = m.id
)
WHERE o.allowed_model_ids && (SELECT array_agg(old_id) FROM model_upgrades);

UPDATE provider_registry
SET status = 'deprecated', visible_to_users = false
WHERE id IN (SELECT old_id FROM model_upgrades);

-- 3) MiMo-V2.6-Pro takes Llama's places in Auto; Llama itself leaves Auto
--    but stays visible (and keeps its plan access) for hand picks.
INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
SELECT rr.task_type, 'openrouter:mimo-v2.6-pro', rr.rank, rr.enabled
FROM provider_routing_rules rr
WHERE rr.provider_id = 'openrouter:llama-3.3-70b-instruct'
ON CONFLICT (task_type, provider_id) DO NOTHING;

UPDATE provider_routing_rules SET enabled = false
WHERE provider_id = 'openrouter:llama-3.3-70b-instruct';

-- 4) New models: every plan can use them, same as the rest of the catalog.
INSERT INTO provider_tier_access (provider_id, plan_key)
SELECT pr.id, p.key
FROM provider_registry pr
CROSS JOIN plans p
WHERE pr.id IN ('openrouter:mimo-v2.6-pro', 'openrouter:mimo-v2.6-flash', 'openrouter:gemma-4-31b', 'openrouter:qwen3.8-2.4t')
ON CONFLICT (provider_id, plan_key) DO NOTHING;

-- Appended after each chain's current last rank, so Auto's order is unchanged.
INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
SELECT n.task_type, n.provider_id, base.max_rank + n.rank_offset, true
FROM (VALUES
  ('text',        'openrouter:mimo-v2.6-flash', 1),
  ('text',        'openrouter:gemma-4-31b',     2),
  ('plan',        'openrouter:mimo-v2.6-flash', 1),
  ('translation', 'openrouter:gemma-4-31b',     1),
  ('translation', 'openrouter:mimo-v2.6-flash', 2),
  ('writing',     'openrouter:gemma-4-31b',     1)
) AS n(task_type, provider_id, rank_offset)
JOIN LATERAL (
  SELECT COALESCE(MAX(rank), 0) AS max_rank
  FROM provider_routing_rules rr
  WHERE rr.task_type = n.task_type
) AS base ON true
ON CONFLICT (task_type, provider_id) DO NOTHING;

COMMIT;
