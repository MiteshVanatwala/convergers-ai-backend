# backend

Gateway, Brain, ledger, and admin-api — one deployable service (a modular
monolith, per the technical plan §07/§08), split into internal modules:

```
src/
  gateway/     → auth, rate limiting, HTTP entrypoint
  brain/       → classifier, router, adapters, normalizer
  ledger/      → billing, credits
  admin-api/   → internal tooling backend
```

Only `brain/` imports provider SDKs. Everything else calls it through the
single function in `brain/index.ts` — see the technical plan §01 for the
full interface contract (`request + policy flags → provider_used, usage,
native_cost`).

## Local development

```bash
npm install
npm run dev
```

Requires `@convergers-ai/shared-types` to be built and linked (or published)
first — see that repo's README.
