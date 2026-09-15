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
    brain/             domain (classifier, router, adapters)
    admin/
  shared/              utils, errors
```

SQL migrations live in package-root `db/` (`schema.sql`, `rls.sql`, `google_auth.sql`).

Signup credits: set `SIGNUP_GRANT_CREDITS` (default 100). Uses existing `credit_wallets` + `credit_ledger` from `schema.sql`. See [`Docs/backend-plan/19-signup-credit-grants.md`](../Docs/backend-plan/19-signup-credit-grants.md).

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

`/admin/*` (except `/admin/health`) requires a valid session cookie **and** an active row in `admin_users` matching the account email. Seed one before using the admin panel:

```sql
INSERT INTO admin_users (email, role, status)
VALUES ('you@example.com', 'engineering_admin', 'active');
```
