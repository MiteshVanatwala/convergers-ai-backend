-- =========================================================================
-- artifacts_v1.sql
--
-- Artifacts (web pages, apps, SVG graphics, diagrams, documents) and the
-- files behind them, plus an "artifact" task type so Auto sends artifact
-- requests to Claude first.
--
-- Bytes live in object storage (backend/storage/ locally, an S3 bucket in
-- production — STORAGE_DRIVER); these tables hold who owns what and who may
-- see it.
--
-- Visibility (artifacts.visibility):
--   private       only the owner (default)
--   organization  signed-in members of the owner's organization
--   link          anyone who has the link — no sign-in, not listed
--   public        anyone, and listed in the public gallery / search engines
--
-- Each update to an artifact is a new version (artifact_versions); chat
-- messages reference a specific version, so old answers keep showing what
-- was made at the time.
--
-- Safe to re-run.
-- =========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS stored_files (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('image', 'artifact', 'audio')),
  storage_key      text NOT NULL UNIQUE,
  content_type     text NOT NULL,
  byte_size        bigint NOT NULL,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stored_files_account ON stored_files (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  -- The model's own name for it within the conversation; reusing it updates the artifact.
  identifier       text,
  title            text NOT NULL,
  type             text NOT NULL CHECK (type IN ('html', 'react', 'svg', 'markdown', 'mermaid', 'code')),
  language         text,                       -- for type = 'code'
  current_version  integer NOT NULL DEFAULT 1,
  visibility       text NOT NULL DEFAULT 'private'
                     CHECK (visibility IN ('private', 'organization', 'link', 'public')),
  published_at     timestamptz,                -- first made public (gallery order)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_artifacts_account ON artifacts (account_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_public ON artifacts (published_at DESC)
  WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_conversation_identifier
  ON artifacts (conversation_id, identifier)
  WHERE identifier IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id  uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  file_id      uuid NOT NULL REFERENCES stored_files(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, version)
);

-- "artifact" task type: Claude first, strong coders as fallback.
UPDATE provider_registry
SET capabilities = capabilities || '["artifact"]'::jsonb
WHERE id IN ('anthropic:claude-sonnet-5-5', 'anthropic:claude-opus-5-5', 'kimi:kimi-k2.7-code',
             'deepseek:deepseek-v4-pro', 'glm:glm-5.3', 'gemini:gemini-3.1-pro-preview', 'deepseek:deepseek-flash')
  AND NOT capabilities ? 'artifact';

INSERT INTO provider_routing_rules (task_type, provider_id, rank, enabled)
SELECT 'artifact', v.provider_id, v.rank, true
FROM (VALUES
  ('anthropic:claude-sonnet-5-5',   1),
  ('anthropic:claude-opus-5-5',     2),
  ('kimi:kimi-k2.7-code',           3),
  ('deepseek:deepseek-v4-pro',      4),
  ('glm:glm-5.3',                   5),
  ('gemini:gemini-3.1-pro-preview', 6),
  ('deepseek:deepseek-flash',       7)
) AS v(provider_id, rank)
JOIN provider_registry pr ON pr.id = v.provider_id
ON CONFLICT (task_type, provider_id) DO NOTHING;

COMMIT;
