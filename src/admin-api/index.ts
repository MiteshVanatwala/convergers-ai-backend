// Internal tooling backend for the admin panel — role-gated per the
// technical deep-dive deck (Support / Ops-Business / Engineering-Admin) in
// the real system. POC note: no auth/role-gating yet, and the audit-log
// requirement ("every read of user-identifiable data writes an
// admin_audit_log entry") isn't implemented — there's no user-identifiable
// data here yet (client records are just name/email/plan, no PII beyond
// that), but wire up real auth before this goes past POC.

import type { FastifyInstance } from "fastify";
import * as clients from "./clients";
import type { Client } from "./clients";
import * as usageLog from "../brain/usageLog";
import { getBalance } from "../ledger";
import { PROVIDERS, getKey, setKey, isConfigured, maskKey, keySource } from "../brain/adapters/keyStore";

function serializeClient(client: Client) {
  return { ...client, creditBalance: getBalance(client.id) };
}

export async function registerAdminApi(app: FastifyInstance) {
  app.get("/admin/health", async () => ({ ok: true }));

  app.get("/admin/clients", async () => clients.list().map(serializeClient));

  app.post<{ Body: { name?: string; email?: string; plan?: string } }>("/admin/clients", async (request, reply) => {
    const name = request.body?.name?.trim();
    const email = request.body?.email?.trim();
    if (!name || !email) {
      return reply.status(400).send({ error: "invalid_request", message: "name and email are required" });
    }
    const requestedPlan = request.body?.plan;
    const plan: Client["plan"] = (clients.PLANS as readonly string[]).includes(requestedPlan ?? "")
      ? (requestedPlan as Client["plan"])
      : "pay_as_you_go";
    const client = clients.create({ name, email, plan });
    reply.status(201);
    return serializeClient(client);
  });

  app.get("/admin/stats", async () => ({
    ...usageLog.summary(),
    recent: usageLog.recent(10),
  }));

  app.get("/admin/providers", async () =>
    PROVIDERS.map((p) => {
      const key = getKey(p.id);
      return {
        id: p.id,
        label: p.label,
        envVar: p.envVar,
        configured: isConfigured(p.id),
        source: keySource(p.id),
        maskedKey: key ? maskKey(key) : null,
      };
    })
  );

  app.post<{ Params: { id: string }; Body: { apiKey?: string } }>("/admin/providers/:id/key", async (request, reply) => {
    const { id } = request.params;
    if (!PROVIDERS.some((p) => p.id === id)) {
      return reply.status(404).send({ error: "unknown_provider" });
    }
    const apiKey = request.body?.apiKey?.trim();
    if (!apiKey) {
      return reply.status(400).send({ error: "invalid_request", message: "apiKey is required" });
    }
    setKey(id, apiKey);
    return { id, configured: true, source: "override" as const, maskedKey: maskKey(apiKey) };
  });
}
