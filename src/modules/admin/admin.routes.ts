import type { FastifyInstance } from "fastify";
import { requireAdminPreHandler } from "../../infrastructure/http/middleware/require-admin";
import { requirePermissionPreHandler } from "../../infrastructure/http/middleware/require-permission";
import {
  requireAdminLoginRateLimit,
  requireAdminOperatorsMutationRateLimit,
  requireAdminOperatorsReadRateLimit,
} from "../../infrastructure/http/middleware/admin-rate-limit";
import { AdminPermission } from "./admin-permissions";
import * as adminController from "./admin.controller";
import * as adminAuthController from "./admin-auth.controller";
import * as operatorsController from "./admin-operators.controller";

export function registerAdminRoutes(app: FastifyInstance): void {
  // Public probe — not enveloped, not auth-gated (AGENTS.md).
  app.get("/admin/health", () => adminController.health());

  // Password login — public; sets admin session cookie. Rate-limited by IP.
  app.post<{ Body: { username?: string; password?: string } }>(
    "/admin/auth/login",
    { preHandler: requireAdminLoginRateLimit },
    (request, reply) => adminAuthController.login(request, reply)
  );
  app.post("/admin/auth/logout", (request, reply) =>
    adminAuthController.logout(request, reply)
  );
  app.get("/admin/auth/me", (request, reply) => adminAuthController.me(request, reply));

  app.register(async (adminApp) => {
    adminApp.addHook("preHandler", requireAdminPreHandler);

    const requireManage = requirePermissionPreHandler(AdminPermission.ADMIN_USERS_MANAGE);
    const readLimit = requireAdminOperatorsReadRateLimit;
    const mutateLimit = requireAdminOperatorsMutationRateLimit;

    // Operators roster — any active admin may list; mutations need admin_users.manage.
    adminApp.get<{
      Querystring: {
        q?: string;
        status?: string;
        role?: string;
        limit?: string;
        offset?: string;
        sort?: string;
        order?: string;
      };
    }>("/admin/admins", { preHandler: readLimit }, (request, reply) =>
      operatorsController.listOperators(request, reply)
    );

    adminApp.get("/admin/admins/roles", { preHandler: readLimit }, (request, reply) =>
      operatorsController.listRoles(request, reply)
    );

    adminApp.post<{
      Body: {
        username?: string;
        email?: string;
        displayName?: string | null;
        role?: string;
        temporaryPassword?: string;
      };
    }>(
      "/admin/admins",
      { preHandler: [mutateLimit, requireManage] },
      (request, reply) => operatorsController.createOperator(request, reply)
    );

    adminApp.patch<{
      Params: { id: string };
      Body: {
        role?: string;
        displayName?: string | null;
        email?: string;
        reason?: string;
      };
    }>(
      "/admin/admins/:id",
      { preHandler: [mutateLimit, requireManage] },
      (request, reply) => operatorsController.patchOperator(request, reply)
    );

    adminApp.post<{ Params: { id: string }; Body: { reason?: string } }>(
      "/admin/admins/:id/deactivate",
      { preHandler: [mutateLimit, requireManage] },
      (request, reply) => operatorsController.deactivateOperator(request, reply)
    );

    adminApp.post<{ Params: { id: string }; Body: { reason?: string } }>(
      "/admin/admins/:id/reactivate",
      { preHandler: [mutateLimit, requireManage] },
      (request, reply) => operatorsController.reactivateOperator(request, reply)
    );

    adminApp.post<{
      Params: { id: string };
      Body: { reason?: string; temporaryPassword?: string };
    }>(
      "/admin/admins/:id/reset-password",
      { preHandler: [mutateLimit, requireManage] },
      (request, reply) => operatorsController.resetOperatorPassword(request, reply)
    );

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
