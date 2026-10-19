-- =========================================================================
-- email_domain_rules_v1.sql
--
-- Sign-up abuse controls (see src/modules/auth/email-policy.ts):
--
-- 1. email_domain_rules — admin-managed overrides on top of the bundled
--    disposable-domain list: 'block' a throwaway domain the list misses,
--    'allow' one it wrongly blocks. A rule covers the domain and its
--    subdomains. Managed on Admin → Email domains (risk_queue.review).
--
-- 2. accounts.normalized_email — the address with Gmail dots and any
--    "+tag" removed (a.b+1@gmail.com → ab@gmail.com). A new account whose
--    normalized email already belongs to another account gets no signup
--    credits. Not unique: alias accounts can still sign up and buy credits.
--    normalize_signup_email() is the single definition, used by the backfill
--    below and by the sign-up inserts in auth.service.ts.
--
-- Apply AFTER schema.sql. Safe to re-run.
--
-- Usage (psql):
--   psql -U postgres -d convergers_ai -f db/email_domain_rules_v1.sql
-- =========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS email_domain_rules (
  domain      citext PRIMARY KEY CHECK (domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  action      text NOT NULL CHECK (action IN ('block', 'allow')),
  note        text,
  created_by  uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION normalize_signup_email(email text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
           WHEN d IN ('gmail.com', 'googlemail.com') THEN replace(split_part(l, '+', 1), '.', '') || '@gmail.com'
           ELSE split_part(l, '+', 1) || '@' || d
         END
  FROM (SELECT regexp_replace(lower(email), '@[^@]*$', '') AS l,
               substring(lower(email) FROM '@([^@]*)$') AS d) parts
$$;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS normalized_email citext;
UPDATE accounts SET normalized_email = normalize_signup_email(email::text) WHERE normalized_email IS NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_normalized_email ON accounts (normalized_email);

-- Which earlier account an alias sign-up copies. Set at sign-up (auth.service.ts);
-- such accounts get no signup grant and no recurring (Free plan daily) grants.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS alias_of_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
-- Backfill: every later account sharing a normalized email points at the earliest one.
UPDATE accounts a
SET alias_of_account_id = first.id
FROM (
  SELECT DISTINCT ON (normalized_email) normalized_email, id
  FROM accounts
  ORDER BY normalized_email, created_at, id
) first
WHERE a.normalized_email = first.normalized_email
  AND a.id <> first.id
  AND a.alias_of_account_id IS NULL;

DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON email_domain_rules TO app_admin;
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'app_admin role not present — grant skipped (dev owner role is fine)';
END $$;

COMMIT;
