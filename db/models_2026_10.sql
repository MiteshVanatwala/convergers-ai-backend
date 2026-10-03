-- =========================================================================
-- models_2026_10.sql
--
-- Model refresh, October 2026. Model ids and prices verified against each
-- provider's own /models endpoint and pricing page on 2026-10-03.
--
-- Upgrades (take over the old model's place in every Auto chain, its plan
-- access, any user's default-model pick and any org's allowed-model list;
-- the old row is kept but marked deprecated and hidden):
--   anthropic:claude-opus-5    -> anthropic:claude-opus-5-5     (newer AND cheaper: $4/$20 vs $5/$25)
--   anthropic:claude-sonnet-5  -> anthropic:claude-sonnet-5-5   (same price)
--   kimi:kimi-k2               -> kimi:kimi-k2.6                (kimi-k2-0711-preview is no longer served — every Kimi call was failing)
--   glm:glm-4.6                -> glm:glm-5.3-flash             (newer, $0.15/$0.50 vs $0.60/$2.20)
--   glm:glm-4.5-air            -> retired; glm-5.3-flash already covers its slot
--
-- New models (added at the END of the relevant Auto chains, so routing order
-- is unchanged until someone reorders it in Admin → Providers → Routing):
--   kimi:kimi-k2.7-code            Kimi K2.7 Code         ($0.95/$4.00)  code
--   glm:glm-5.3                    GLM-5.3                ($1.40/$4.40)  text, code, research, plan
--   groq:gpt-oss-20b               GPT-OSS 20B            ($0.075/$0.30) text, plan
--   gemini:gemini-3.5-flash-lite   Gemini 3.5 Flash-Lite  ($0.30/$2.50)  text, research, plan
--
-- Requires the matching backend code (adapters + pricing.ts) from the same change.
-- Safe to re-run.
--
-- Usage:
--   npm run db:migrate          (or psql -U postgres -d convergers_ai -f db/models_2026_10.sql)
-- =========================================================================

BEGIN;

-- 1) New registry rows.
INSERT INTO provider_registry (id, label, status, key_provider_id, capabilities, context_window, visible_to_users) VALUES
  ('anthropic:claude-opus-5-5',     'Claude Opus 5.5',       'active', 'anthropic', '["text","code","research","plan"]', 1000000, true),
  ('anthropic:claude-sonnet-5-5',   'Claude Sonnet 5.5',     'active', 'anthropic', '["text","code","research","plan"]', 1000000, true),
  ('kimi:kimi-k2.6',                'Kimi K2.6',             'active', 'kimi',      '["text","code","research","plan"]', 262144,  true),
  ('kimi:kimi-k2.7-code',           'Kimi K2.7 Code',        'active', 'kimi',      '["code"]',                          262144,  true),
  ('glm:glm-5.3',                   'GLM-5.3',               'active', 'glm',       '["text","code","research","plan"]', 1048576, true),
  ('glm:glm-5.3-flash',             'GLM-5.3 Flash',         'active', 'glm',       '["text","code","research","plan"]', 1048576, true),
  ('groq:gpt-oss-20b',              'GPT-OSS 20B',           'active', 'groq',      '["text","plan"]',                   131072,  true),
  ('gemini:gemini-3.5-flash-lite',  'Gemini 3.5 Flash-Lite', 'active', 'gemini',    '["text","research","plan"]',        1048576, true)
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label,
  key_provider_id = EXCLUDED.key_provider_id,
  capabilities = EXCLUDED.capabilities,
  context_window = EXCLUDED.context_window;

-- 2) Upgrades: move every reference from the old id to the new one.
DROP TABLE IF EXISTS model_upgrades;
CREATE TEMP TABLE model_upgrades (old_id text PRIMARY KEY, new_id text NOT NULL) ON COMMIT DROP;
INSERT INTO model_upgrades VALUES
  ('anthropic:claude-opus-5',   'anthropic:claude-opus-5-5'),
  ('anthropic:claude-sonnet-5', 'anthropic:claude-sonnet-5-5'),
  ('kimi:kimi-k2',              'kimi:kimi-k2.6'),
  ('glm:glm-4.6',               'glm:glm-5.3-flash'),
  ('glm:glm-4.5-air',           'glm:glm-5.3-flash');

-- Auto chains: the new model takes the old one's rank. When two old models
-- map to the same new one, the first (lowest rank) wins and the other is
-- disabled below.
INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
SELECT DISTINCT ON (rr.task_type, u.new_id) rr.task_type, u.new_id, rr.rank, rr.enabled
FROM provider_routing_rules rr
JOIN model_upgrades u ON u.old_id = rr.provider_id
ORDER BY rr.task_type, u.new_id, rr.rank
ON CONFLICT (task_type, provider_id) DO NOTHING;

UPDATE provider_routing_rules SET enabled = false
WHERE provider_id IN (SELECT old_id FROM model_upgrades);

-- Plan access: the new model is unlocked for the same plans as the old one.
INSERT INTO provider_tier_access (provider_id, plan_key)
SELECT u.new_id, t.plan_key
FROM provider_tier_access t
JOIN model_upgrades u ON u.old_id = t.provider_id
ON CONFLICT (provider_id, plan_key) DO NOTHING;

-- Users' default-model picks and orgs' allowed-model lists.
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

-- Old rows stay (usage history refers to them) but leave routing and the picker.
UPDATE provider_registry
SET status = 'deprecated', visible_to_users = false
WHERE id IN (SELECT old_id FROM model_upgrades);

-- 3) New models: every plan can use them, same as the rest of the catalog.
INSERT INTO provider_tier_access (provider_id, plan_key)
SELECT pr.id, p.key
FROM provider_registry pr
CROSS JOIN plans p
WHERE pr.id IN ('kimi:kimi-k2.7-code', 'glm:glm-5.3', 'groq:gpt-oss-20b', 'gemini:gemini-3.5-flash-lite')
ON CONFLICT (provider_id, plan_key) DO NOTHING;

-- Appended after each chain's current last rank, so Auto's order is unchanged.
INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
SELECT n.task_type, n.provider_id, base.max_rank + n.rank_offset, true
FROM (VALUES
  ('code',     'kimi:kimi-k2.7-code',          1),
  ('code',     'glm:glm-5.3',                  2),
  ('text',     'glm:glm-5.3',                  1),
  ('text',     'groq:gpt-oss-20b',             2),
  ('text',     'gemini:gemini-3.5-flash-lite', 3),
  ('research', 'glm:glm-5.3',                  1),
  ('research', 'gemini:gemini-3.5-flash-lite', 2),
  ('plan',     'glm:glm-5.3',                  1),
  ('plan',     'groq:gpt-oss-20b',             2),
  ('plan',     'gemini:gemini-3.5-flash-lite', 3)
) AS n(task_type, provider_id, rank_offset)
JOIN LATERAL (
  SELECT COALESCE(MAX(rank), 0) AS max_rank
  FROM provider_routing_rules rr
  WHERE rr.task_type = n.task_type
) AS base ON true
ON CONFLICT (task_type, provider_id) DO NOTHING;

COMMIT;
