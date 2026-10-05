-- =========================================================================
-- test_mode_v1.sql
--
-- Per-account test mode: Auto routing sends the account's requests to the
-- cheapest available model for each task instead of the best one, to keep
-- testing costs down. An explicit model pick is still honored. Set by an
-- admin on Admin → Users.
-- =========================================================================

BEGIN;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT false;

COMMIT;
