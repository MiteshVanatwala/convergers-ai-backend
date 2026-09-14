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
