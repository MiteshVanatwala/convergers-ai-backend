-- =========================================================================
-- projects_v1.sql
--
-- Projects polish for sidebar folders: updated_at on projects.
-- Apply AFTER schema.sql (and conversations_messages_v1.sql if used).
-- Keep schema.sql in sync in the same change set.
-- updated_at is maintained by the projects service on UPDATE.
-- =========================================================================

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMIT;
