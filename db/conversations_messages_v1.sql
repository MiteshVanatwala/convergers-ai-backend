-- =========================================================================
-- conversations_messages_v1.sql
--
-- Chat persistence: UUID conversation IDs (ChatGPT/Claude-style URLs),
-- title_status, message status, and FK updates for related tables.
--
-- Apply AFTER base schema.sql.
-- Do NOT edit schema.sql as part of this task — this file is the delta.
--
-- POC note: recreates conversations/messages (and dependent join tables).
-- Assumes no production chat rows that must be preserved.
-- =========================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Drop dependents that reference conversations(id) as bigint
DROP TABLE IF EXISTS conversation_labels CASCADE;
DROP TABLE IF EXISTS orchestration_state CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;

-- -------------------------------------------------------------------------
-- conversations (UUID primary key)
-- -------------------------------------------------------------------------

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id       bigint REFERENCES projects(id) ON DELETE SET NULL,
  title            text,
  title_status     text NOT NULL DEFAULT 'pending'
                     CHECK (title_status IN ('pending', 'generated', 'manual')),
  pinned           boolean NOT NULL DEFAULT false,
  archived         boolean NOT NULL DEFAULT false,
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_account_recent
  ON conversations (account_id, pinned DESC, last_message_at DESC)
  WHERE archived = false;

CREATE INDEX idx_conversations_project ON conversations (project_id);

-- -------------------------------------------------------------------------
-- messages (partitioned; conversation_id is uuid)
-- -------------------------------------------------------------------------

CREATE TABLE messages (
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  conversation_id    uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES accounts(id),
  role               text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content            text NOT NULL,
  content_search     tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  provider           text,
  task_type          text,
  tokens_input       integer,
  tokens_output      integer,
  credits_charged    numeric(12,2),
  status             text NOT NULL DEFAULT 'complete'
                       CHECK (status IN ('complete', 'error', 'cancelled')),
  client_message_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);
CREATE INDEX idx_messages_account ON messages (account_id, created_at DESC);
CREATE INDEX idx_messages_search ON messages USING GIN (content_search);
CREATE INDEX idx_messages_client_message
  ON messages (account_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
-- Note: Postgres unique indexes on partitioned tables must include the
-- partition key (created_at), so client_message_id uniqueness is enforced
-- in application code if needed — not via UNIQUE INDEX here.

-- Monthly partitions covering late 2026 / early 2027 (extend as needed)
CREATE TABLE messages_2026_09 PARTITION OF messages
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE messages_2026_10 PARTITION OF messages
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE messages_2026_11 PARTITION OF messages
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE messages_2026_12 PARTITION OF messages
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE messages_2027_01 PARTITION OF messages
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE messages_2027_02 PARTITION OF messages
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE messages_2027_03 PARTITION OF messages
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');

-- -------------------------------------------------------------------------
-- labels join + orchestration (uuid conversation_id)
-- -------------------------------------------------------------------------

CREATE TABLE conversation_labels (
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  label_id         bigint NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, label_id)
);

CREATE TABLE orchestration_state (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id),
  conversation_id  uuid NOT NULL REFERENCES conversations(id),
  plan             jsonb NOT NULL,
  completed_steps  integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'in_progress',
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------
-- usage_events.conversation_id → uuid (column was bigint, no FK)
-- -------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'usage_events'
      AND column_name = 'conversation_id'
      AND data_type = 'bigint'
  ) THEN
    ALTER TABLE usage_events
      ALTER COLUMN conversation_id TYPE uuid USING NULL;
  END IF;
END $$;

COMMIT;
