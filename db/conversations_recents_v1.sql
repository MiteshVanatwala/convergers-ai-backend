-- =========================================================================
-- conversations_recents_v1.sql
--
-- Keyset index for paginated Recents feed
-- (unpinned, unassigned, not archived).
-- Apply AFTER conversations_messages_v1.sql / schema conversations.
-- =========================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_conversations_account_recents
  ON conversations (account_id, last_message_at DESC, id DESC)
  WHERE archived = false AND pinned = false AND project_id IS NULL;

COMMIT;
