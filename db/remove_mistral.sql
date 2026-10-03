-- =========================================================================
-- remove_mistral.sql
--
-- Removes Mistral (Mistral Large, Mistral Small) as a provider. It was never
-- configured with an API key, so it served no requests, and nothing refers
-- to it (no user defaults, org allow-lists, own keys or usage history were
-- found on 2026-10-03). Deleted outright rather than deprecated.
--
-- Requires the matching backend change (mistral adapter removed).
-- Safe to re-run.
-- =========================================================================

BEGIN;

-- Anything that would still point at a Mistral model, in case it appeared since.
UPDATE personalization_settings
SET default_provider_override = NULL
WHERE default_provider_override LIKE 'mistral:%';

UPDATE organizations
SET allowed_model_ids = array(
  SELECT m FROM unnest(allowed_model_ids) AS m WHERE m NOT LIKE 'mistral:%'
)
WHERE EXISTS (SELECT 1 FROM unnest(allowed_model_ids) AS m WHERE m LIKE 'mistral:%');

DELETE FROM provider_routing_rules WHERE provider_id LIKE 'mistral:%';
DELETE FROM provider_tier_access WHERE provider_id LIKE 'mistral:%';
DELETE FROM provider_registry WHERE id LIKE 'mistral:%';

-- The provider itself (and any stored keys for it).
DELETE FROM provider_api_keys WHERE provider_id = 'mistral';
DELETE FROM provider_credentials WHERE id = 'mistral';

COMMIT;
