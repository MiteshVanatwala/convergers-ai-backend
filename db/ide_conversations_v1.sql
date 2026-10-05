-- =========================================================================
-- ide_conversations_v1.sql
--
-- Adds client_type to conversations so IDE-originated conversations are
-- distinguishable from web/mobile ones.
--
-- Apply AFTER conversations_messages_v1.sql.
-- Safe to run on a live database — ALTER TABLE ADD COLUMN with a DEFAULT
-- is a metadata-only operation in Postgres 11+.
-- =========================================================================

BEGIN;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS client_type text NOT NULL DEFAULT 'web'
    CHECK (client_type IN ('web', 'ide', 'mobile', 'api'));

COMMENT ON COLUMN conversations.client_type IS
  'Surface that originated this conversation: web | ide | mobile | api';

-- Index for admin queries filtering by client type
CREATE INDEX IF NOT EXISTS idx_conversations_client_type
  ON conversations (account_id, client_type, last_message_at DESC)
  WHERE archived = false;

COMMIT;
