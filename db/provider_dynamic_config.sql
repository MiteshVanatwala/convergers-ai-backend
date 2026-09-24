-- Convergers AI — dynamic provider configuration
--
-- Apply AFTER schema.sql + admin_auth.sql + admin_management.sql + rls.sql
-- (provider_registry / provider_api_keys / provider_routing_rules /
-- admin_users / role_permissions must already exist).
-- Idempotent: IF NOT EXISTS / ON CONFLICT DO NOTHING throughout.
--
-- Makes the LLM provider system admin-configurable instead of hardcoded in
-- TypeScript. Two concepts, previously conflated in provider_registry alone:
--   provider_credentials — one row per API key (anthropic, openai, deepseek,
--     glm, kimi, groq) — replaces backend/src/.../keyStore.ts's PROVIDERS array.
--   provider_registry     — one row per MODEL/adapter (e.g.
--     'groq:qwen3.8-27b'), each pointing at the credential it authenticates
--     through via the new key_provider_id column. Two models (Qwen, GPT-OSS)
--     share one Groq credential — this is why the split exists.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/provider_dynamic_config.sql
-- =========================================================================

BEGIN;

-- =========================================================================
-- provider_credentials — one row per API key
-- =========================================================================

CREATE TABLE IF NOT EXISTS provider_credentials (
  id         text PRIMARY KEY,
  label      text NOT NULL,
  env_var    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO provider_credentials (id, label, env_var) VALUES
  ('anthropic', 'Anthropic', 'ANTHROPIC_API_KEY'),
  ('openai',    'OpenAI',    'OPENAI_API_KEY'),
  ('deepseek',  'DeepSeek',  'DEEPSEEK_API_KEY'),
  ('glm',       'GLM (Zhipu)',       'GLM_API_KEY'),
  ('kimi',      'Kimi (Moonshot)',   'KIMI_API_KEY'),
  ('groq',      'Groq (Qwen, GPT-OSS)', 'GROQ_API_KEY')
ON CONFLICT (id) DO NOTHING;


-- =========================================================================
-- provider_registry — repurposed as the model/adapter catalog
-- =========================================================================

ALTER TABLE provider_registry
  ADD COLUMN IF NOT EXISTS key_provider_id text REFERENCES provider_credentials(id);

INSERT INTO provider_registry (id, label, status, key_provider_id) VALUES
  ('anthropic:claude-haiku-4-5', 'Claude Haiku 4.5',  'active', 'anthropic'),
  ('anthropic:claude-sonnet-5',  'Claude Sonnet 5',   'active', 'anthropic'),
  ('openai:gpt-image-1',         'OpenAI gpt-image-1','active', 'openai'),
  ('deepseek:deepseek-chat',     'DeepSeek V3',       'active', 'deepseek'),
  ('glm:glm-4.6',                'GLM-4.6',           'active', 'glm'),
  ('kimi:kimi-k2',               'Kimi K2',           'active', 'kimi'),
  ('groq:qwen3.8-27b',           'Qwen3.8 27B',       'active', 'groq'),
  ('groq:gpt-oss-120b',          'GPT-OSS 120B',      'active', 'groq')
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label,
  key_provider_id = EXCLUDED.key_provider_id;


-- =========================================================================
-- provider_api_keys — re-point FK from provider_registry to
-- provider_credentials (empty table today, zero data-loss risk)
-- =========================================================================

ALTER TABLE provider_api_keys DROP CONSTRAINT IF EXISTS provider_api_keys_provider_id_fkey;
ALTER TABLE provider_api_keys
  ADD CONSTRAINT provider_api_keys_provider_id_fkey
  FOREIGN KEY (provider_id) REFERENCES provider_credentials(id);


-- =========================================================================
-- provider_routing_rules — seed today's live ordering exactly, so behavior
-- is unchanged the moment this ships. rank 1 = tried first.
-- =========================================================================

INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled) VALUES
  ('text', 'deepseek:deepseek-chat',     1, true),
  ('text', 'glm:glm-4.6',                2, true),
  ('text', 'kimi:kimi-k2',               3, true),
  ('text', 'groq:qwen3.8-27b',           4, true),
  ('text', 'groq:gpt-oss-120b',          5, true),
  ('text', 'anthropic:claude-haiku-4-5', 6, true),
  ('text', 'anthropic:claude-sonnet-5',  7, true),

  ('code', 'deepseek:deepseek-chat',     1, true),
  ('code', 'glm:glm-4.6',                2, true),
  ('code', 'kimi:kimi-k2',               3, true),
  ('code', 'groq:qwen3.8-27b',           4, true),
  ('code', 'groq:gpt-oss-120b',          5, true),
  ('code', 'anthropic:claude-sonnet-5',  6, true),

  ('research', 'deepseek:deepseek-chat',     1, true),
  ('research', 'glm:glm-4.6',                2, true),
  ('research', 'kimi:kimi-k2',               3, true),
  ('research', 'groq:qwen3.8-27b',           4, true),
  ('research', 'groq:gpt-oss-120b',          5, true),
  ('research', 'anthropic:claude-sonnet-5',  6, true),

  ('plan', 'deepseek:deepseek-chat',     1, true),
  ('plan', 'glm:glm-4.6',                2, true),
  ('plan', 'kimi:kimi-k2',               3, true),
  ('plan', 'groq:qwen3.8-27b',           4, true),
  ('plan', 'groq:gpt-oss-120b',          5, true),
  ('plan', 'anthropic:claude-sonnet-5',  6, true),

  ('image', 'openai:gpt-image-1', 1, true)
ON CONFLICT (task_type, provider_id) DO NOTHING;


-- =========================================================================
-- RLS for the new table — same admin-only / provider.manage_keys pattern as
-- provider_api_keys (see rls.sql). No-op under the current superuser
-- DATABASE_URL (see rls.sql's own note) — real enforcement is the
-- requirePermissionPreHandler check in the admin route layer.
-- =========================================================================

ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'provider_credentials' AND policyname = 'admin_read'
  ) THEN
    CREATE POLICY admin_read ON provider_credentials FOR SELECT USING (is_admin_context());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'provider_credentials' AND policyname = 'admin_write'
  ) THEN
    CREATE POLICY admin_write ON provider_credentials FOR INSERT
      WITH CHECK (admin_has_permission(current_admin_id(), 'provider.manage_keys'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'provider_credentials' AND policyname = 'admin_update'
  ) THEN
    CREATE POLICY admin_update ON provider_credentials FOR UPDATE
      USING (is_admin_context()) WITH CHECK (admin_has_permission(current_admin_id(), 'provider.manage_keys'));
  END IF;
EXCEPTION
  WHEN undefined_function THEN
    RAISE NOTICE 'RLS helper functions missing — skip provider_credentials policies (run rls.sql first)';
END $$;

DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE ON provider_credentials TO app_admin;
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'app_admin role not present — grant skipped (dev owner role is fine)';
END $$;

COMMIT;
