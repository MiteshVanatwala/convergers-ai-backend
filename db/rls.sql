-- Row-level security — apply after schema.sql.
--
-- Design: two Postgres roles, not one per admin sub-role. The Support /
-- Ops-Business / Engineering-Admin distinction from the admin panel spec
-- is enforced by the admin-api application layer (checking admin_users.role
-- and writing admin_audit_log), not by Postgres — RLS's job here is a
-- single, blunt guarantee: an app_user connection can only ever see its
-- own account's rows, full stop, even if a bug in application code forgets
-- a WHERE clause.
--
-- app_user  — used by the gateway/brain/ledger for customer-scoped requests
-- app_admin — used by admin-api; sees across every account
--
-- Neither role owns any table, so RLS applies to both without needing
-- FORCE ROW LEVEL SECURITY. Whoever runs schema.sql (a migration owner
-- role, or a superuser in dev) stays exempt, same as any other DDL role.

CREATE ROLE app_user LOGIN;
CREATE ROLE app_admin LOGIN;
-- Set real passwords via `ALTER ROLE ... WITH PASSWORD` from a secrets
-- manager, per environment — never commit one to this file.


-- =========================================================================
-- Helper functions — every policy below reads as plain English because of
-- these three. All STABLE, not VOLATILE: Postgres can cache the result
-- once per statement instead of re-evaluating per row.
-- =========================================================================

CREATE OR REPLACE FUNCTION current_account_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.account_id', true), '')::uuid
$$;
-- The `true` (missing_ok) argument makes an unset session variable return
-- NULL instead of raising — and a NULL comparison is falsy, so forgetting
-- to set this before a query means "see nothing," never "see everything."
-- That's the safe direction to fail in.

CREATE OR REPLACE FUNCTION is_admin_context() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.is_admin', true), 'false') = 'true'
$$;

-- is_org_member() and admin_has_permission() are SECURITY DEFINER: each
-- queries a table that itself has an RLS policy calling back into that
-- same function (organization_members' policy calls is_org_member();
-- admin_users'/role_permissions' policies call admin_has_permission()).
-- Without SECURITY DEFINER, the function's internal SELECT is evaluated
-- under the CALLER's RLS, re-invoking the function — infinite recursion,
-- caught only by testing against a real database, not by reading the SQL.
-- SECURITY DEFINER runs the internal query as the function's owner
-- instead, which — same as any table owner — is exempt from RLS, so the
-- lookup completes without re-triggering the policy that called it.
-- `SET search_path = public` closes the standard SECURITY DEFINER
-- schema-hijacking hole (a caller-controlled search_path could otherwise
-- point "organization_members" at an object they created themselves).
-- Own these as the migration/schema role, never as app_user or app_admin.

CREATE OR REPLACE FUNCTION is_org_member(p_org_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE org_id = p_org_id AND account_id = current_account_id()
  )
$$;

CREATE OR REPLACE FUNCTION current_admin_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.admin_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION admin_has_permission(p_admin_id uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM admin_users au
    JOIN role_permissions rp ON rp.role = au.role
    WHERE au.id = p_admin_id
      AND au.status = 'active'
      AND rp.permission_key = p_permission
  )
$$;
-- Checks the *current* role_permissions mapping, not a snapshot taken at
-- login — revoke a permission from a role and every admin holding it loses
-- it on their very next query, with no session to expire.

-- The backend sets these once per request, inside the same transaction as
-- the queries that follow — never as a bare SET, which would leak into
-- whatever the next pooled connection does next:
--
--   BEGIN;
--   SET LOCAL app.account_id = '<uuid from the authenticated session>';
--   SET LOCAL app.is_admin = 'false';
--   -- ... run the request's actual queries ...
--   COMMIT;
--
-- admin-api additionally sets app.admin_id to the specific admin_users.id
-- making the request — is_admin_context() alone says "some admin," but
-- admin_has_permission() needs to know exactly which one:
--
--   BEGIN;
--   SET LOCAL app.is_admin = 'true';
--   SET LOCAL app.admin_id = '<admin_users.id from the admin session>';
--   -- ... run the request's actual queries ...
--   COMMIT;
--
-- SET LOCAL is transaction-scoped, so this is safe under PgBouncer in
-- transaction-pooling mode — a session-level SET would not be.


-- =========================================================================
-- Account-scoped tables — the common case: own rows only, or admin.
-- =========================================================================

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounts FOR ALL
  USING (id = current_account_id() OR is_admin_context())
  WITH CHECK (id = current_account_id() OR is_admin_context());

ALTER TABLE login_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON login_events FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

ALTER TABLE credit_wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_wallets FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_ledger FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

ALTER TABLE credit_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_purchases FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messages FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());
-- Applies automatically to every partition (messages_2026_09, ...) — RLS
-- defined on a partitioned parent propagates to its children.

ALTER TABLE message_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_feedback FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

ALTER TABLE orchestration_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orchestration_state FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_events FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());
-- §01.6's token-activity page is just this table filtered by RLS instead
-- of a WHERE account_id = ? the application has to remember to add.

ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON labels FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_tickets FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_preferences FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

ALTER TABLE personalization_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON personalization_settings FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());

ALTER TABLE data_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_requests FOR ALL
  USING (account_id = current_account_id() OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR is_admin_context());


-- =========================================================================
-- Join / association tables — no account_id of their own; scoped through
-- the conversation or label they point at.
-- =========================================================================

ALTER TABLE conversation_labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversation_labels FOR ALL
  USING (
    is_admin_context()
    OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id AND c.account_id = current_account_id())
  )
  WITH CHECK (
    is_admin_context()
    OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id AND c.account_id = current_account_id())
  );


-- =========================================================================
-- Org-scoped tables — visible to the owner, any member, or admin.
-- =========================================================================

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations FOR ALL
  USING (owner_id = current_account_id() OR is_org_member(id) OR is_admin_context())
  WITH CHECK (owner_id = current_account_id() OR is_admin_context());

ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_members FOR ALL
  USING (account_id = current_account_id() OR is_org_member(org_id) OR is_admin_context())
  WITH CHECK (is_org_member(org_id) OR is_admin_context());

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON projects FOR ALL
  USING (account_id = current_account_id() OR (org_id IS NOT NULL AND is_org_member(org_id)) OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR (org_id IS NOT NULL AND is_org_member(org_id)) OR is_admin_context());

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_methods FOR ALL
  USING (account_id = current_account_id() OR (org_id IS NOT NULL AND is_org_member(org_id)) OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR (org_id IS NOT NULL AND is_org_member(org_id)) OR is_admin_context());

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriptions FOR ALL
  USING (account_id = current_account_id() OR (org_id IS NOT NULL AND is_org_member(org_id)) OR is_admin_context())
  WITH CHECK (account_id = current_account_id() OR (org_id IS NOT NULL AND is_org_member(org_id)) OR is_admin_context());

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys FOR ALL
  USING (is_org_member(org_id) OR is_admin_context())
  WITH CHECK (is_org_member(org_id) OR is_admin_context());


-- =========================================================================
-- Admin-only tables — no customer-facing row ever, regardless of whose
-- account_id it is. app_user gets no GRANT on these at all (below); the
-- deny-by-default policy is a second layer in case a future GRANT is added
-- carelessly.
-- =========================================================================

ALTER TABLE risk_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_only ON risk_signals FOR ALL USING (is_admin_context()) WITH CHECK (is_admin_context());

ALTER TABLE provider_registry ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_only ON provider_registry FOR ALL USING (is_admin_context()) WITH CHECK (is_admin_context());

ALTER TABLE provider_health_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_only ON provider_health_snapshots FOR ALL USING (is_admin_context()) WITH CHECK (is_admin_context());

-- provider_api_keys and provider_routing_rules: read is open to any admin
-- context (Ops-Business needs to see what's configured), but the spec is
-- explicit that only Engineering/Admin can actually change either — so
-- unlike the blanket admin_only tables above, writes are permission-gated,
-- not just role-gated by convention.
ALTER TABLE provider_api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON provider_api_keys FOR SELECT USING (is_admin_context());
CREATE POLICY admin_write ON provider_api_keys FOR INSERT WITH CHECK (admin_has_permission(current_admin_id(), 'provider.manage_keys'));
CREATE POLICY admin_update ON provider_api_keys FOR UPDATE
  USING (is_admin_context()) WITH CHECK (admin_has_permission(current_admin_id(), 'provider.manage_keys'));
CREATE POLICY admin_delete ON provider_api_keys FOR DELETE USING (admin_has_permission(current_admin_id(), 'provider.manage_keys'));

ALTER TABLE provider_routing_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON provider_routing_rules FOR SELECT USING (is_admin_context());
CREATE POLICY admin_write ON provider_routing_rules FOR INSERT WITH CHECK (admin_has_permission(current_admin_id(), 'provider.manage_routing'));
CREATE POLICY admin_update ON provider_routing_rules FOR UPDATE
  USING (is_admin_context()) WITH CHECK (admin_has_permission(current_admin_id(), 'provider.manage_routing'));
CREATE POLICY admin_delete ON provider_routing_rules FOR DELETE USING (admin_has_permission(current_admin_id(), 'provider.manage_routing'));

ALTER TABLE moderation_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_only ON moderation_queue FOR ALL USING (is_admin_context()) WITH CHECK (is_admin_context());

-- Any admin can see the roster (who else has access, and at what role),
-- but changing it — inviting, promoting, deactivating — requires the
-- admin_users.manage permission specifically. By the seed data in
-- schema.sql, only engineering_admin holds it: a support or ops-business
-- admin cannot promote themselves, or anyone else, no matter what
-- admin-api's own code does or forgets to check.
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON admin_users FOR SELECT USING (is_admin_context());
CREATE POLICY admin_write ON admin_users FOR INSERT WITH CHECK (admin_has_permission(current_admin_id(), 'admin_users.manage'));
CREATE POLICY admin_update ON admin_users FOR UPDATE
  USING (is_admin_context()) WITH CHECK (admin_has_permission(current_admin_id(), 'admin_users.manage'));
CREATE POLICY admin_delete ON admin_users FOR DELETE USING (admin_has_permission(current_admin_id(), 'admin_users.manage'));

ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON permissions FOR SELECT USING (is_admin_context());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON role_permissions FOR SELECT USING (is_admin_context());
CREATE POLICY admin_write ON role_permissions FOR ALL
  USING (admin_has_permission(current_admin_id(), 'admin_users.manage'))
  WITH CHECK (admin_has_permission(current_admin_id(), 'admin_users.manage'));
-- Editing which permissions a role grants is the same trust boundary as
-- managing admin_users itself — gated by the identical permission.

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_only ON admin_audit_log FOR ALL USING (is_admin_context()) WITH CHECK (is_admin_context());
-- Note what RLS does *not* give you here: it can restrict who reads this
-- table, but it can't force every admin data-reveal to actually write a
-- row here first — that "access is logged" contract is still enforced by
-- admin-api's code, not the database. A trigger-based approach exists but
-- adds real complexity; revisit only if code review proves insufficient.

-- plans and feature_flags: no RLS. plans is public reference data every
-- signed-in context should read; feature_flags is read by backend service
-- code directly, not per-row by an end user — a row-level policy has
-- nothing to scope by on either table.


-- =========================================================================
-- Lock down the SECURITY DEFINER functions. Postgres grants EXECUTE to
-- PUBLIC by default on a new function — for a function that bypasses RLS
-- internally, that default is worth overriding explicitly rather than
-- leaving to chance, even though both return only a boolean, never rows.
-- =========================================================================

REVOKE EXECUTE ON FUNCTION is_org_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_org_member(uuid) TO app_user, app_admin;

REVOKE EXECUTE ON FUNCTION admin_has_permission(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_has_permission(uuid, text) TO app_admin;


-- =========================================================================
-- Grants — RLS filters rows, but a role still needs table-level privilege
-- to touch the table at all. Tables not listed for app_user below (the
-- provider_*/admin_* tables) are simply never granted to it — belt and
-- suspenders alongside the admin_only policies above.
-- =========================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON
  accounts, login_events, credit_wallets, credit_purchases,
  conversations, messages, message_feedback, orchestration_state,
  labels, conversation_labels, support_tickets,
  notification_preferences, personalization_settings, data_requests,
  organizations, organization_members, projects,
  payment_methods, subscriptions, api_keys
  TO app_user;

GRANT SELECT, INSERT ON credit_ledger TO app_user; -- append-only: no UPDATE/DELETE, even within RLS
GRANT SELECT ON usage_events, plans, feature_flags TO app_user; -- usage_events is written by the request path via a privileged internal path, not general app_user traffic

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- app_admin gets everything app_user does, plus the admin-only tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  accounts, login_events, credit_wallets, credit_purchases, credit_ledger,
  conversations, messages, message_feedback, orchestration_state,
  labels, conversation_labels, support_tickets, usage_events,
  notification_preferences, personalization_settings, data_requests,
  organizations, organization_members, projects,
  payment_methods, subscriptions, api_keys,
  risk_signals, provider_registry, provider_health_snapshots,
  provider_api_keys, provider_routing_rules, moderation_queue,
  admin_users, admin_audit_log, plans, feature_flags,
  permissions, role_permissions
  TO app_admin;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_admin;
