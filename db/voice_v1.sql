-- =========================================================================
-- voice_v1.sql
--
-- Voice in chat: speak a prompt (speech → text) and listen to answers
-- (text → speech). Served by /v1/voice/* (modules/voice), not the chat
-- router, so these models have no routing rules and are hidden from the
-- model picker. The registry rows exist so the plan check and own-key
-- (BYOK) lookup work the same way as for chat models.
--
--   groq:whisper-large-v3-turbo   speech → text, first choice ($0.04 / audio hour)
--   groq:whisper-large-v3         speech → text, fallback     ($0.111 / audio hour)
--   gemini:gemini-3.8-flash-tts   text → speech, first choice, many languages
--   groq:orpheus-v1-english       text → speech, English fallback ($22 / 1M chars)
--
-- Read-aloud audio is cached in object storage (stored_files, kind 'audio').
-- =========================================================================

BEGIN;

INSERT INTO provider_registry (id, label, capabilities, status, key_provider_id, visible_to_users)
VALUES
  ('groq:whisper-large-v3-turbo', 'Whisper Large v3 Turbo',  '["voice"]'::jsonb, 'active', 'groq',   false),
  ('groq:whisper-large-v3',       'Whisper Large v3',        '["voice"]'::jsonb, 'active', 'groq',   false),
  ('gemini:gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS',    '["voice"]'::jsonb, 'active', 'gemini', false),
  ('groq:orpheus-v1-english',     'Orpheus English (Groq)',  '["voice"]'::jsonb, 'active', 'groq',   false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO provider_tier_access (provider_id, plan_key)
SELECT v.provider_id, p.key
FROM (VALUES
  ('groq:whisper-large-v3-turbo'),
  ('groq:whisper-large-v3'),
  ('gemini:gemini-3.8-flash-tts'),
  ('groq:orpheus-v1-english')
) AS v(provider_id)
CROSS JOIN plans p
ON CONFLICT DO NOTHING;

COMMIT;
