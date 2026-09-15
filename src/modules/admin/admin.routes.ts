import type { FastifyInstance } from "fastify";
import { requireAdminPreHandler } from "../../infrastructure/http/middleware/require-admin";
import * as adminController from "./admin.controller";

export function registerAdminRoutes(app: FastifyInstance): void {
  // Public probe — not enveloped, not auth-gated (AGENTS.md).
  app.get("/admin/health", () => adminController.health());

  app.register(async (adminApp) => {
    adminApp.addHook("preHandler", requireAdminPreHandler);

    adminApp.get<{
      Querystring: {
        q?: string;
        status?: string;
        limit?: string;
        offset?: string;
        sort?: string;
        order?: string;
      };
    }>("/admin/users", (request, reply) => adminController.listUsers(request, reply));

    adminApp.get<{ Params: { id: string } }>("/admin/users/:id", (request, reply) =>
      adminController.getUser(request, reply)
    );

    adminApp.patch<{ Params: { id: string }; Body: { name?: string | null; status?: string } }>(
      "/admin/users/:id",
      (request, reply) => adminController.updateUser(request, reply)
    );

    adminApp.post<{ Params: { id: string } }>("/admin/users/:id/soft-delete", (request, reply) =>
      adminController.softDeleteUser(request, reply)
    );

    adminApp.get<{
      Querystring: {
        accountId?: string;
        q?: string;
        reason?: string;
        from?: string;
        to?: string;
        limit?: string;
        offset?: string;
        order?: string;
      };
    }>("/admin/credits/ledger", (request, reply) => adminController.listLedger(request, reply));

    adminApp.get("/admin/clients", (request, reply) => adminController.listClients(request, reply));

    adminApp.post<{ Body: { name?: string; email?: string; plan?: string } }>(
      "/admin/clients",
      (request, reply) => adminController.createClient(request, reply)
    );

    adminApp.get("/admin/stats", (request, reply) => adminController.stats(request, reply));

    adminApp.get("/admin/providers", (request, reply) => adminController.listProviders(request, reply));

    adminApp.post<{ Params: { id: string }; Body: { apiKey?: string } }>(
      "/admin/providers/:id/key",
      (request, reply) => adminController.setProviderKey(request, reply)
    );
  });
}
