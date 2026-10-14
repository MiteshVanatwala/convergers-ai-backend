-- =========================================================================
-- multi_model_v1.sql
--
-- Multi-model answers, October 2026. Apply AFTER routing_domains_v1.sql.
--
-- 1) messages.metadata — what a plain answer row can't hold, as JSON:
--      sources     web search citations ([{n, title, url}])
--      mode        "council" | "debate" | "compare" | "deep_research"
--      members     council / debate member answers ([{provider, content, …}])
--      agreement   council consensus ("high" | "medium" | "low")
--      candidates  compare answers; `chosen` = the index the user voted for
--      crosscheck  a second model's verdict on this answer
--    Nullable; plain answers leave it empty. messages is partitioned, so
--    the column is added on the parent and every partition inherits it.
--
-- 2) answer_votes — one row per compare vote (the latest pick per answer
--    wins), so routing can learn which models users actually prefer.
--
-- Safe to re-run.
-- =========================================================================

BEGIN;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata jsonb;

CREATE TABLE IF NOT EXISTS answer_votes (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id        bigint NOT NULL,                -- assistant message (no FK: messages is partitioned)
  task_type         text,
  winner_provider   text NOT NULL,                  -- provider_registry id (no FK: history outlives registry rows)
  loser_providers   text[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_answer_votes_winner_created
  ON answer_votes (winner_provider, created_at DESC);

ALTER TABLE answer_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON answer_votes;
CREATE POLICY tenant_isolation ON answer_votes
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

COMMIT;
