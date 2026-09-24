-- Convergers AI — sensitive-data filtering setting
--
-- Apply AFTER schema.sql (personalization_settings must exist).
-- Idempotent.
--
-- Per-account, default off. When on, brain/index.ts redacts sensitive spans
-- before sending the request to any provider and restores them in the
-- response — see backend/src/modules/brain/privacy/sensitiveFilter.service.ts.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/sensitive_data_filter_v1.sql

ALTER TABLE personalization_settings
  ADD COLUMN IF NOT EXISTS filter_sensitive_data boolean NOT NULL DEFAULT false;
