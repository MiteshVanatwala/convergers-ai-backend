-- =========================================================================
-- images_v2.sql
--
-- Claude as an image model: it draws by writing and running Python
-- (Pillow / matplotlib) in Anthropic's code-execution sandbox. The only
-- option that makes animated GIFs; also strong at text, charts, diagrams
-- and flat/geometric art. No photos — the Gemini / OpenAI models do those.
--
-- Image chain after this migration:
--   1 Nano Banana 2           2 Gemini Flash-Lite Image
--   3 Claude (code-drawn)     4 OpenAI gpt-image-1
-- Requests for a GIF / animation skip the still-image models automatically.
-- =========================================================================

BEGIN;

INSERT INTO provider_registry (id, label, capabilities, status, key_provider_id, visible_to_users)
VALUES ('anthropic:claude-sonnet-5-5-image', 'Claude Sonnet 5.5 (images & GIFs via code)', '["image"]'::jsonb, 'active', 'anthropic', true)
ON CONFLICT (id) DO NOTHING;

UPDATE provider_routing_rules SET rank = 4
WHERE task_type = 'image' AND provider_id = 'openai:gpt-image-1' AND rank < 4;

INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
VALUES ('image', 'anthropic:claude-sonnet-5-5-image', 3, true)
ON CONFLICT (task_type, provider_id) DO NOTHING;

INSERT INTO provider_tier_access (provider_id, plan_key)
SELECT 'anthropic:claude-sonnet-5-5-image', p.key FROM plans p
ON CONFLICT DO NOTHING;

COMMIT;
