# Backend conventions

See full Delplus adoption plan: [`Docs/backend-plan/18-delplus-rules-adoption.md`](../Docs/backend-plan/18-delplus-rules-adoption.md).

## Layering

- `*.routes.ts` — path wiring only
- `*.controller.ts` — HTTP + orchestration; one `try/catch` per handler
- `*.service.ts` — **DB / data access only**; one `try/catch` per function; log with `logCaught` then rethrow

## SQL

- Use `getPool()` / `withPoolTransaction()` only
- Parameterized queries (`$1`, `$2`, …) — never interpolate values into SQL strings

## Logging

- Controllers: `request.log.error({ err }, "[module.layer.fn] …")`
- Services: `logCaught("module.layer.fn", error)` from `shared/utils/log.ts`
- Do not use `console.error` in catch blocks

## Response envelope (JSON APIs)

Use `ok` / `fail` from `shared/http/api-response.ts` with codes from `config/app-status-codes.ts`:

```json
{ "success": true, "status_code": 2100, "data": {} }
{ "success": false, "status_code": 2101, "error": "…" }
```

**Do not** wrap: OAuth redirects, SSE stream frames, or thin health probes (`/health`, `/admin/health`).
