// Internal tooling backend for the admin panel — role-gated per the
// technical deep-dive deck (Support / Ops-Business / Engineering-Admin).
// Every read of user-identifiable data through here must write an
// admin_audit_log entry. Not implemented yet.

import type { FastifyInstance } from "fastify";

export async function registerAdminApi(app: FastifyInstance) {
  app.get("/admin/health", async () => ({ ok: true }));
}
