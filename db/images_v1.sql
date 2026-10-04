-- =========================================================================
-- images_v1.sql
--
-- Gemini image models ("Nano Banana") for image generation, ahead of
-- OpenAI gpt-image-1, which stays in the chain as the last fallback.
--
--   gemini:gemini-3.1-flash-image       Auto default, every plan (~$0.08 per image)
--   gemini:gemini-3.1-flash-lite-image  fallback only, hidden from the picker (~$0.04)
--   gemini:gemini-3-pro-image           highest quality, pickable on paid plans (~$0.16)
--
-- Generated images are stored in object storage (stored_files, kind
-- 'image') — see artifacts_v1.sql.
-- =========================================================================

BEGIN;

INSERT INTO provider_registry (id, label, capabilities, status, key_provider_id, visible_to_users)
VALUES
  ('gemini:gemini-3.1-flash-image',      'Nano Banana 2 (Gemini 3.1 Flash Image)', '["image"]'::jsonb, 'active', 'gemini', true),
  ('gemini:gemini-3-pro-image',          'Nano Banana Pro (Gemini 3 Pro Image)',   '["image"]'::jsonb, 'active', 'gemini', true),
  ('gemini:gemini-3.1-flash-lite-image', 'Gemini 3.1 Flash-Lite Image',            '["image"]'::jsonb, 'active', 'gemini', false)
ON CONFLICT (id) DO NOTHING;

-- Gemini first; gpt-image-1 moves to the end of the chain.
UPDATE provider_routing_rules SET rank = 3
WHERE task_type = 'image' AND provider_id = 'openai:gpt-image-1';

INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
VALUES
  ('image', 'gemini:gemini-3.1-flash-image',      1, true),
  ('image', 'gemini:gemini-3.1-flash-lite-image', 2, true)
ON CONFLICT (task_type, provider_id) DO NOTHING;

INSERT INTO provider_tier_access (provider_id, plan_key)
SELECT v.provider_id, p.plan_key
FROM (VALUES
  ('gemini:gemini-3.1-flash-image'),
  ('gemini:gemini-3.1-flash-lite-image')
) AS v(provider_id)
CROSS JOIN (VALUES ('free'), ('pro'), ('pay_as_you_go'), ('team'), ('enterprise')) AS p(plan_key)
ON CONFLICT DO NOTHING;

INSERT INTO provider_tier_access (provider_id, plan_key)
SELECT 'gemini:gemini-3-pro-image', p.plan_key
FROM (VALUES ('pro'), ('pay_as_you_go'), ('team'), ('enterprise')) AS p(plan_key)
ON CONFLICT DO NOTHING;

COMMIT;
