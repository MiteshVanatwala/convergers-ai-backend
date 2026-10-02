-- =========================================================================
-- email_login_v1.sql
--
-- Email one-time-code sign-in, alongside Google. POST /auth/email/start
-- emails a 6-digit code; POST /auth/email/verify checks it and signs in —
-- creating the account on first use (auth_provider = 'email'). An email
-- that already has an account (e.g. from Google) signs into that account.
--
-- Only a salted SHA-256 of each code is stored. A code is valid for 10
-- minutes, single-use, and locks after 5 wrong attempts. Sending a new code
-- retires older unused ones for that email.
--
-- Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/email_login_v1.sql
-- =========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS email_login_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        citext NOT NULL,
  code_salt    text NOT NULL,
  code_hash    text NOT NULL,
  attempts     smallint NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,                 -- used, or retired by a newer code
  ip_address   inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Latest open code per email, and per-email send-rate counting.
CREATE INDEX IF NOT EXISTS idx_email_login_codes_email_created
  ON email_login_codes (email, created_at DESC);

COMMIT;
