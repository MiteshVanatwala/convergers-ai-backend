-- =========================================================================
-- routing_domains_v1.sql
--
-- Domain routing, October 2026. Apply AFTER routing_costs_2026_10.sql.
--
-- The classifier now also recognises four text domains — math, reasoning,
-- writing, translation (backend/src/modules/brain/classifier/index.ts) —
-- each with its own Auto chain, so it can lead with the models best at it.
-- A domain with no enabled rows falls back to the "text" chain, so this
-- file only decides the order; nothing breaks without it.
--
-- 1) Seed each domain's chain. Reasoning-strong models lead math and
--    reasoning (the router also asks them to think harder on "deep"
--    requests); Claude leads writing; fast multilingual models lead
--    translation. Groq models sit in every chain as a working fallback.
--    Only models present in provider_registry are inserted.
-- 2) Tag those models with the domain in provider_registry.capabilities
--    (shown on Admin → Providers → Models).
-- 3) Remove routing rows that point at retired models: they're disabled,
--    the router never reads them, and they cluttered the admin lists.
--    The registry rows stay (usage history refers to them).
--
-- Admins reorder or disable any of this in Admin → Providers → Routing.
-- Safe to re-run.
-- =========================================================================

BEGIN;

-- 1) Domain chains ----------------------------------------------------------

DROP TABLE IF EXISTS domain_routing;
CREATE TEMP TABLE domain_routing (task_type text, provider_id text, pos int) ON COMMIT DROP;
INSERT INTO domain_routing VALUES
  ('math',        'deepseek:deepseek-v4-pro',      1),
  ('math',        'groq:gpt-oss-120b',             2),
  ('math',        'gemini:gemini-3.1-pro-preview', 3),
  ('math',        'anthropic:claude-sonnet-5-5',   4),
  ('math',        'groq:qwen3.8-27b',              5),

  ('reasoning',   'gemini:gemini-3.1-pro-preview', 1),
  ('reasoning',   'deepseek:deepseek-v4-pro',      2),
  ('reasoning',   'groq:gpt-oss-120b',             3),
  ('reasoning',   'anthropic:claude-sonnet-5-5',   4),
  ('reasoning',   'groq:qwen3.8-27b',              5),

  ('writing',     'anthropic:claude-sonnet-5-5',   1),
  ('writing',     'kimi:kimi-k2.6',                2),
  ('writing',     'gemini:gemini-3.8-flash',       3),
  ('writing',     'groq:qwen3.8-27b',              4),

  ('translation', 'gemini:gemini-3.8-flash',       1),
  ('translation', 'groq:qwen3.8-27b',              2),
  ('translation', 'glm:glm-5.3-flash',             3),
  ('translation', 'deepseek:deepseek-flash',       4);

-- Inserted only for a domain with no rows yet, so a re-run never undoes an
-- admin's reordering.
INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
SELECT d.task_type, d.provider_id, d.pos, true
FROM domain_routing d
JOIN provider_registry pr ON pr.id = d.provider_id
WHERE NOT EXISTS (SELECT 1 FROM provider_routing_rules rr WHERE rr.task_type = d.task_type)
ON CONFLICT (task_type, provider_id) DO NOTHING;

-- 2) Capability tags ----------------------------------------------------------

UPDATE provider_registry pr
SET capabilities = pr.capabilities || tags.added
FROM (
  SELECT d.provider_id, jsonb_agg(DISTINCT d.task_type) AS added
  FROM domain_routing d
  JOIN provider_registry r ON r.id = d.provider_id
  WHERE NOT (r.capabilities ? d.task_type)
  GROUP BY d.provider_id
) tags
WHERE pr.id = tags.provider_id;

-- 3) Retired models' routing rows ---------------------------------------------

DELETE FROM provider_routing_rules rr
USING provider_registry pr
WHERE pr.id = rr.provider_id
  AND pr.status <> 'active'
  AND rr.enabled = false;

COMMIT;
