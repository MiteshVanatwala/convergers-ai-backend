-- Convergers AI — dynamic provider configuration, v2
--
-- Apply AFTER provider_dynamic_config.sql.
-- Idempotent: ON CONFLICT DO NOTHING/UPDATE throughout.
--
-- Adds 4 more provider credentials/models: Google Gemini, Mistral AI, xAI
-- (Grok), and OpenRouter (Meta Llama 3.3 70B as its flagship pick). None of
-- these have keys configured yet — ranked after Anthropic in every task
-- type's chain (last resort, unconfigured additions), trivially reorderable
-- from the admin panel's Providers page once keys exist.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/provider_dynamic_config_v2.sql
-- =========================================================================

BEGIN;

INSERT INTO provider_credentials (id, label, env_var) VALUES
  ('gemini',     'Google Gemini', 'GEMINI_API_KEY'),
  ('mistral',    'Mistral AI',    'MISTRAL_API_KEY'),
  ('xai',        'xAI (Grok)',    'XAI_API_KEY'),
  ('openrouter', 'OpenRouter',    'OPENROUTER_API_KEY')
ON CONFLICT (id) DO NOTHING;

INSERT INTO provider_registry (id, label, status, key_provider_id) VALUES
  ('gemini:gemini-3.8-flash',              'Gemini 3.8 Flash',    'active', 'gemini'),
  ('mistral:mistral-large-latest',         'Mistral Large',       'active', 'mistral'),
  ('xai:grok-4.6',                         'Grok 4.6',            'active', 'xai'),
  ('openrouter:llama-3.3-70b-instruct',    'Llama 3.3 70B (OpenRouter)', 'active', 'openrouter')
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label,
  key_provider_id = EXCLUDED.key_provider_id;

-- Append after Anthropic (ranks 8-11 for text, 7-10 for code/research/plan —
-- both chains currently end at Anthropic per provider_dynamic_config.sql).
INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
SELECT t.task_type, p.provider_id, base.max_rank + p.rank_offset, true
FROM (VALUES ('text'), ('code'), ('research'), ('plan')) AS t(task_type)
CROSS JOIN (VALUES
  ('gemini:gemini-3.8-flash', 1),
  ('mistral:mistral-large-latest', 2),
  ('xai:grok-4.6', 3),
  ('openrouter:llama-3.3-70b-instruct', 4)
) AS p(provider_id, rank_offset)
JOIN LATERAL (
  SELECT COALESCE(MAX(rank), 0) AS max_rank
  FROM provider_routing_rules rr
  WHERE rr.task_type = t.task_type
) AS base ON true
ON CONFLICT (task_type, provider_id) DO NOTHING;

COMMIT;
