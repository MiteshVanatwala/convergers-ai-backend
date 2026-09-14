import type { FastifyInstance } from "fastify";
import * as adminController from "./admin.controller";

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get("/admin/health", () => adminController.health());

  app.get<{
    Querystring: {
      q?: string;
      status?: string;
      limit?: string;
      offset?: string;
      sort?: string;
      order?: string;
    };
  }>("/admin/users", (request, reply) => adminController.listUsers(request, reply));

  app.get<{ Params: { id: string } }>("/admin/users/:id", (request, reply) =>
    adminController.getUser(request, reply)
  );

  app.patch<{ Params: { id: string }; Body: { name?: string | null; status?: string } }>(
    "/admin/users/:id",
    (request, reply) => adminController.updateUser(request, reply)
  );

  app.post<{ Params: { id: string } }>("/admin/users/:id/soft-delete", (request, reply) =>
    adminController.softDeleteUser(request, reply)
  );

  app.get<{
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

  app.get("/admin/clients", (request, reply) => adminController.listClients(request, reply));

  app.post<{ Body: { name?: string; email?: string; plan?: string } }>(
    "/admin/clients",
    (request, reply) => adminController.createClient(request, reply)
  );

  app.get("/admin/stats", (request, reply) => adminController.stats(request, reply));

  app.get("/admin/providers", (request, reply) => adminController.listProviders(request, reply));

  app.post<{ Params: { id: string }; Body: { apiKey?: string } }>(
    "/admin/providers/:id/key",
    (request, reply) => adminController.setProviderKey(request, reply)
  );
}
