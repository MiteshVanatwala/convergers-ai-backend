-- Convergers AI — Admin password auth
--
-- Apply AFTER schema.sql (admin_users must exist).
-- Safe-ish to re-run: IF NOT EXISTS / ON CONFLICT for seed.
--
-- Adds:
--   admin_users.username / password_hash / password_changed_at / last_login_at
--   admin_sessions — HttpOnly cookie sessions for the admin panel
--   Default system admin (username: system / password: ChangeMe!Admin)
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/admin_auth.sql
--
-- CHANGE THE DEFAULT PASSWORD before any shared/staging/production use.
-- Default for seed below: admin123

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =========================================================================
-- admin_users — login credentials
-- =========================================================================

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS username citext,
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_username
  ON admin_users (username)
  WHERE username IS NOT NULL;


-- =========================================================================
-- admin_sessions — admin panel sessions (token HASH only)
-- =========================================================================

CREATE TABLE IF NOT EXISTS admin_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  ip_address      inet,
  user_agent      text
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions (admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_active ON admin_sessions (token_hash)
  WHERE revoked_at IS NULL;


-- =========================================================================
-- Seed: system admin (full access)
-- Default password: admin123  (scrypt hash — see shared/utils/password.ts)
-- Only inserts when username `system` is absent.
-- =========================================================================

INSERT INTO admin_users (email, username, password_hash, role, status, password_changed_at)
SELECT
  'system@convergers.local',
  'system',
  'scrypt$xCRv8g4yKyb4EVBI06FNRw$2T0h901PzqZqcRrfOyA1GA6_nDNJtBTVdUt7V818qK0oG27mm0Bk_J2TYBfdmHJ9Ubw0KqGEo7cJ16m2U59CsQ',
  'engineering_admin',
  'active',
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM admin_users WHERE username = 'system'
);
