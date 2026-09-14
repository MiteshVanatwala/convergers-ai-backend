-- Convergers AI — Google auth tables
--
-- Apply AFTER schema.sql (+ rls.sql if you use app_user / app_admin).
-- Safe to re-run: uses IF NOT EXISTS / guarded policy creates where possible.
--
-- Adds:
--   oauth_states  — short-lived CSRF tickets for the Google OAuth redirect
--   sessions      — durable HttpOnly-cookie sessions (stores token HASH only)
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/google_auth.sql
--
-- GUI clients: connect to convergers_ai, then run this file as-is (no \c).

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() if not already


-- =========================================================================
-- oauth_states — OAuth CSRF `state` (TTL ~10 minutes, one-time use)
-- =========================================================================

CREATE TABLE IF NOT EXISTS oauth_states (
  state         text PRIMARY KEY,
  audience      text NOT NULL DEFAULT 'web',  -- web | admin (admin later)
  redirect_to   text,                         -- allowlisted path only; null = /
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states (expires_at);


-- =========================================================================
-- sessions — server-side sessions for web (and later admin)
-- Cookie holds the raw random token; this table stores sha256(token) only.
-- =========================================================================

CREATE TABLE IF NOT EXISTS sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  audience      text NOT NULL DEFAULT 'web',  -- web | admin
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip_address    inet,
  user_agent    text
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions (token_hash)
  WHERE revoked_at IS NULL;


-- =========================================================================
-- Row-level security (no-ops harmlessly if roles were never created)
-- Auth login path typically uses a privileged DB role; app_user can list /
-- revoke own sessions once SET LOCAL app.account_id is set.
-- oauth_states is not granted to app_user (auth-service only).
-- =========================================================================

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'sessions' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON sessions FOR ALL
      USING (account_id = current_account_id() OR is_admin_context())
      WITH CHECK (account_id = current_account_id() OR is_admin_context());
  END IF;
EXCEPTION
  WHEN undefined_function THEN
    RAISE NOTICE 'RLS helpers missing — skip sessions policy (run rls.sql first for app_user isolation)';
  WHEN undefined_object THEN
    RAISE NOTICE 'Skipping sessions RLS policy';
END $$;

DO $$
BEGIN
  GRANT SELECT, UPDATE ON sessions TO app_user;
  GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO app_admin;
  -- oauth_states: auth path only — no grant to app_user
  GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_states TO app_admin;
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'app_user / app_admin roles not present — grants skipped (dev owner role is fine)';
END $$;


-- Optional cleanup helpers (run manually or via cron later):
--   DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day';
--   DELETE FROM sessions WHERE revoked_at IS NOT NULL OR expires_at < now() - interval '30 days';
