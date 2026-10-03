-- =========================================================================
-- routing_costs_2026_10.sql
--
-- Cost cuts, October 2026. Apply AFTER models_2026_10.sql.
--
-- 1) Auto routing order: cheap, capable models first; Claude as the safety
--    net instead of an early fallback. Per-request cost at ~1.5K tokens in /
--    700 out: GLM-5.3 Flash ≈ $0.0006, DeepSeek Flash ≈ $0.0013,
--    Gemini 3.8 Flash ≈ $0.0038, Claude Sonnet 5.5 ≈ $0.0100.
--    Models listed below take ranks 1..n in this order; every other model
--    already in a chain keeps its relative order after them (still a
--    fallback, just later). Admins can reorder any time in
--    Admin → Providers → Routing.
--
-- 2) Free plan: Claude Sonnet 5.5 and Opus 5.5 need a paid plan (Pro, Team
--    via Pro/PAYG members, Pay as you go, Enterprise). Free users still get
--    every other model, and can use Claude with their own Anthropic key.
--
-- 3) model_call_failures: why a model's API call failed (status + message),
--    so expensive fallbacks have a visible cause. Shown on the admin
--    dashboard's model board. Rows older than 30 days can be deleted freely.
--
-- Safe to re-run.
-- =========================================================================

BEGIN;

-- 1) Routing order --------------------------------------------------------

DROP TABLE IF EXISTS desired_routing;
CREATE TEMP TABLE desired_routing (task_type text, provider_id text, pos int) ON COMMIT DROP;
INSERT INTO desired_routing VALUES
  ('text',     'deepseek:deepseek-flash',       1),
  ('text',     'glm:glm-5.3-flash',             2),
  ('text',     'gemini:gemini-3.8-flash',       3),
  ('text',     'groq:gpt-oss-120b',             4),
  ('text',     'kimi:kimi-k2.6',                5),
  ('text',     'anthropic:claude-haiku-4-5',    6),
  ('text',     'anthropic:claude-sonnet-5-5',   7),

  ('code',     'deepseek:deepseek-v4-pro',      1),
  ('code',     'kimi:kimi-k2.7-code',           2),
  ('code',     'deepseek:deepseek-flash',       3),
  ('code',     'glm:glm-5.3',                   4),
  ('code',     'anthropic:claude-sonnet-5-5',   5),
  ('code',     'anthropic:claude-opus-5-5',     6),

  ('research', 'gemini:gemini-3.8-flash',       1),
  ('research', 'deepseek:deepseek-v4-pro',      2),
  ('research', 'glm:glm-5.3',                   3),
  ('research', 'kimi:kimi-k2.6',                4),
  ('research', 'gemini:gemini-3.1-pro-preview', 5),
  ('research', 'anthropic:claude-sonnet-5-5',   6),

  ('plan',     'deepseek:deepseek-flash',       1),
  ('plan',     'glm:glm-5.3-flash',             2),
  ('plan',     'gemini:gemini-3.8-flash',       3),
  ('plan',     'deepseek:deepseek-v4-pro',      4),
  ('plan',     'anthropic:claude-sonnet-5-5',   5);

-- Desired models: ranks 1..n, enabled (inserted if a chain lacked them).
INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
SELECT d.task_type, d.provider_id, d.pos, true
FROM desired_routing d
JOIN provider_registry pr ON pr.id = d.provider_id
ON CONFLICT (task_type, provider_id) DO UPDATE SET rank = EXCLUDED.rank, enabled = true;

-- Everything else in those chains moves after them, keeping its order.
UPDATE provider_routing_rules rr
SET rank = 1000 + rr.rank
WHERE rr.task_type IN (SELECT DISTINCT task_type FROM desired_routing)
  AND NOT EXISTS (
    SELECT 1 FROM desired_routing d WHERE d.task_type = rr.task_type AND d.provider_id = rr.provider_id
  )
  AND rr.rank < 1000;

-- Renumber 1..N per chain so ranks stay readable in the admin panel.
UPDATE provider_routing_rules rr
SET rank = ordered.new_rank
FROM (
  SELECT id, row_number() OVER (PARTITION BY task_type ORDER BY rank, provider_id) AS new_rank
  FROM provider_routing_rules
  WHERE task_type IN (SELECT DISTINCT task_type FROM desired_routing)
) ordered
WHERE rr.id = ordered.id AND rr.rank <> ordered.new_rank;

-- 2) Free plan: no Claude Sonnet / Opus on the master key -------------------

DELETE FROM provider_tier_access
WHERE plan_key = 'free'
  AND provider_id IN ('anthropic:claude-sonnet-5-5', 'anthropic:claude-opus-5-5');

-- 3) Failure log -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_call_failures (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id  text NOT NULL,                 -- provider_registry id (no FK: history outlives registry rows)
  task_type    text,
  account_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('rate_limited', 'auth', 'error')),
  http_status  integer,
  message      text,                          -- provider's error message, trimmed
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_call_failures_provider_created
  ON model_call_failures (provider_id, created_at DESC);

COMMIT;
