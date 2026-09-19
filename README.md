# backend

Gateway, Brain, ledger, and admin-api — one deployable service (modular monolith).

## Layout

```
src/
  config/              env + constants
  infrastructure/      db pool, Fastify server, middleware
  modules/
    auth/              routes · controller · service (DB) · google.oauth
    health/
    routing/           /v1/*
    ledger/            ledger.service (data)
    usage/             usage_events persist + /v1/usage/* (list/summary/export)
    plans/             commercial catalog GET /v1/plans + account_plans membership
    brain/             domain (classifier, router, adapters)
    admin/
  shared/              utils, errors
```

SQL migrations live in package-root `db/` (`schema.sql`, `rls.sql`, `google_auth.sql`, `admin_auth.sql`, `admin_management.sql`, `usage_events_partitions_v1.sql`, `commercial_plans_v1.sql`, `account_plans_v1.sql`).

Signup credits: set `SIGNUP_GRANT_CREDITS` (default 100). Uses existing `credit_wallets` + `credit_ledger` from `schema.sql`. See [`Docs/backend-plan/19-signup-credit-grants.md`](../Docs/backend-plan/19-signup-credit-grants.md).

Commercial plans (Option E): seed catalog with `db/commercial_plans_v1.sql`, then membership table + Free backfill with `db/account_plans_v1.sql`. New signups get an active Free `account_plans` row. APIs: `GET /v1/plans`, `GET /auth/me` includes `plan`. See [`Docs/commercial-plans/02-pricing-modal-web.md`](../Docs/commercial-plans/02-pricing-modal-web.md).

Usage events: every brain success/error writes `usage_events`; successful charges set `credit_ledger.reference_id`. Consumer APIs: `GET /v1/usage/events`, `/v1/usage/summary`, `/v1/usage/export`. See [`Docs/backend-plan/22-usage-events-persistence.md`](../Docs/backend-plan/22-usage-events-persistence.md).

If your DB was created from an older `schema.sql` (only Sep/Oct 2026 partitions):

```bash
psql -U postgres -d convergers_ai -f db/usage_events_partitions_v1.sql
```

Conventions: [AGENTS.md](./AGENTS.md) · Delplus adoption: [`Docs/backend-plan/18-delplus-rules-adoption.md`](../Docs/backend-plan/18-delplus-rules-adoption.md).

## Local development

```bash
cp .env.example .env
pnpm install
pnpm run dev
```

Requires `@convergers-ai/shared-types` built/linked. Default port `:8787`.

Auth, sessions, and admin DB features need Postgres. Set `DATABASE_URL` in `.env`
(see `.env.example`); the first DB call fails with a clear error if it is missing.

Session cookie defaults: `SameSite=Lax`, `Secure` only when `COOKIE_SECURE=true`.
For cross-site deployments (web and API on different sites), set `COOKIE_SAMESITE=None`
(Secure is forced). Keep Lax for localhost / same-site Google OAuth.

### Admin panel auth

Admin uses **username/password** (separate cookie from web Google sessions). Apply after `schema.sql`:

```bash
psql -U postgres -d convergers_ai -f db/admin_auth.sql
psql -U postgres -d convergers_ai -f db/admin_management.sql
```

Default system user (change immediately outside local POC):

| Field | Value |
| --- | --- |
| username | `system` |
| password | `admin123` |
| role | `engineering_admin` (includes `admin_users.manage`) |

APIs:

- Auth: `POST /admin/auth/login`, `POST /admin/auth/logout`, `GET /admin/auth/me`
- Operators: `GET/POST /admin/admins`, `GET /admin/admins/roles`, `PATCH /admin/admins/:id`, `POST …/deactivate|reactivate|reset-password`

All other `/admin/*` (except `/admin/health`) require the admin session cookie.

Operator management plan: [`Docs/admin-panel/20-admin-operators-management-plan.md`](../Docs/admin-panel/20-admin-operators-management-plan.md).  
Login plan (Phase A): [`Docs/admin-panel/19-admin-password-login-plan.md`](../Docs/admin-panel/19-admin-password-login-plan.md).

#### Rate limits (in-process)

| Route class | Default | Env |
| --- | --- | --- |
| `POST /admin/auth/login` | 10 / IP / min | `ADMIN_LOGIN_RATE_LIMIT_PER_MIN` |
| `GET /admin/admins*` | 120 / admin / min | `ADMIN_OPERATORS_READ_RATE_LIMIT_PER_MIN` |
| Mutating `/admin/admins*` | 30 / admin / min | `ADMIN_OPERATORS_MUTATION_RATE_LIMIT_PER_MIN` |

Exceeded requests return HTTP **429** with `status_code` `4490`. Multi-replica deploys should move this store to Redis later.

#### Admin RLS context

Operator mutations run inside `withAdminTransaction(adminId, …)`, which sets transaction-local:

- `app.is_admin = true`
- `app.admin_id = <admin_users.id>`

This matches `db/rls.sql`. Full effect requires connecting as the `app_admin` role (table owners / superusers bypass RLS).

---

## Break-glass: recover bootstrap `system` admin

Use when all engineering admins are locked out (forgotten password, accidental demotion blocked, etc.).

1. **Generate a new scrypt hash** (same algorithm as login):

   ```bash
   cd convergers-ai-backend
   npx tsx scripts/hash-admin-password.ts 'YourNewStrongPassword1'
   ```

2. **Apply in Postgres** (as a DBA / migration owner):

   ```sql
   BEGIN;
   UPDATE admin_users
   SET password_hash = '<paste hash from step 1>',
       password_changed_at = now(),
       status = 'active',
       deactivated_at = NULL,
       is_bootstrap = true
   WHERE username = 'system';

   UPDATE admin_sessions
   SET revoked_at = now()
   WHERE admin_user_id = (SELECT id FROM admin_users WHERE username = 'system')
     AND revoked_at IS NULL;
   COMMIT;
   ```

3. **Sign in** at the admin panel with `system` / the new password.

4. **Record the incident** — insert an audit row if possible:

   ```sql
   INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, reason, meta)
   SELECT id, 'admin_operator.break_glass', 'admin_user', id::text,
          'Break-glass password reset via DBA runbook',
          '{"source":"runbook"}'::jsonb
   FROM admin_users WHERE username = 'system';
   ```

5. **Follow up** — create/restore a second `engineering_admin` human operator; rotate the break-glass password again if it was shared during recovery.

Never commit production passwords or hashes to git.
