-- Convergers AI — dynamic provider configuration, v3
--
-- Apply AFTER provider_dynamic_config.sql + provider_dynamic_config_v2.sql.
-- Idempotent throughout.
--
-- Adds:
--   provider_registry.visible_to_users — admin-controlled, independent of
--     provider_routing_rules.enabled (a model can be in the automatic
--     fallback chain without being offered in the user-facing picker, or
--     vice versa).
--   personalization_settings.default_provider_override gets a real FK to
--     provider_registry(id) — the column already existed in schema.sql but
--     was completely unwired.
--   A second model for 6 providers, plus a fix: deepseek-chat was retired
--     by DeepSeek on 2026-07-24 — replaced here with deepseek-flash (its
--     direct successor) and a new deepseek-v4-pro tier.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/provider_dynamic_config_v3.sql
-- =========================================================================

BEGIN;

-- =========================================================================
-- Visibility flag
-- =========================================================================

ALTER TABLE provider_registry
  ADD COLUMN IF NOT EXISTS visible_to_users boolean NOT NULL DEFAULT true;

-- =========================================================================
-- default_provider_override — wire up the FK schema.sql left unwired
-- =========================================================================

ALTER TABLE personalization_settings DROP CONSTRAINT IF EXISTS personalization_settings_default_provider_override_fkey;
ALTER TABLE personalization_settings
  ADD CONSTRAINT personalization_settings_default_provider_override_fkey
  FOREIGN KEY (default_provider_override) REFERENCES provider_registry(id);

-- =========================================================================
-- Fix deprecated deepseek-chat → deepseek-flash, add deepseek-v4-pro
-- Order matters: insert new row(s) first so re-pointing references doesn't
-- violate the provider_routing_rules FK, then delete the old row.
-- =========================================================================

INSERT INTO provider_registry (id, label, status, key_provider_id) VALUES
  ('deepseek:deepseek-flash',   'DeepSeek Flash', 'active', 'deepseek'),
  ('deepseek:deepseek-v4-pro',  'DeepSeek V4 Pro', 'active', 'deepseek')
ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label;

UPDATE provider_routing_rules
SET provider_id = 'deepseek:deepseek-flash'
WHERE provider_id = 'deepseek:deepseek-chat';

DELETE FROM provider_registry WHERE id = 'deepseek:deepseek-chat';

-- =========================================================================
-- Second model for 5 more providers
-- =========================================================================

INSERT INTO provider_registry (id, label, status, key_provider_id) VALUES
  ('anthropic:claude-opus-5',          'Claude Opus 5',   'active', 'anthropic'),
  ('gemini:gemini-3.1-pro-preview',    'Gemini 3.1 Pro',  'active', 'gemini'),
  ('mistral:mistral-small-latest',     'Mistral Small',   'active', 'mistral'),
  ('glm:glm-4.5-air',                  'GLM-4.5 Air',     'active', 'glm'),
  ('xai:grok-4.3',                     'Grok 4.3',        'active', 'xai')
ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label;

-- Append every new model (including deepseek-v4-pro) after each task type's
-- current max rank, same pattern as provider_dynamic_config_v2.sql. Not
-- added to automatic routing for 'image' (text-only models).
INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
SELECT t.task_type, p.provider_id, base.max_rank + p.rank_offset, true
FROM (VALUES ('text'), ('code'), ('research'), ('plan')) AS t(task_type)
CROSS JOIN (VALUES
  ('deepseek:deepseek-v4-pro', 1),
  ('anthropic:claude-opus-5', 2),
  ('gemini:gemini-3.1-pro-preview', 3),
  ('mistral:mistral-small-latest', 4),
  ('glm:glm-4.5-air', 5),
  ('xai:grok-4.3', 6)
) AS p(provider_id, rank_offset)
JOIN LATERAL (
  SELECT COALESCE(MAX(rank), 0) AS max_rank
  FROM provider_routing_rules rr
  WHERE rr.task_type = t.task_type
) AS base ON true
ON CONFLICT (task_type, provider_id) DO NOTHING;

COMMIT;
