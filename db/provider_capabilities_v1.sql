-- Convergers AI — model capability tags
--
-- Apply AFTER provider_dynamic_config_v3.sql (all current models must exist).
-- Idempotent — safe to rerun.
--
-- provider_registry.capabilities (schema.sql) has existed since the original
-- schema but was never populated or read anywhere in the codebase; this
-- seeds sensible defaults using the same TaskType vocabulary
-- provider_routing_rules.task_type already uses (see
-- backend/src/modules/brain/classifier/index.ts). Every general chat model
-- gets the same four task types provider_routing_rules already assigns them
-- across (text/code/research/plan); the one dedicated image model gets
-- ["image"]. Admins adjust from here via the Providers → Models tab.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/provider_capabilities_v1.sql
-- =========================================================================

BEGIN;

UPDATE provider_registry
SET capabilities = '["text","code","research","plan"]'::jsonb
WHERE id <> 'openai:gpt-image-1'
  AND capabilities = '[]'::jsonb;

UPDATE provider_registry
SET capabilities = '["image"]'::jsonb
WHERE id = 'openai:gpt-image-1'
  AND capabilities = '[]'::jsonb;

COMMIT;
