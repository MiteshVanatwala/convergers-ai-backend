import type { FastifyInstance } from "fastify";
import { requireAdminPreHandler } from "../../infrastructure/http/middleware/require-admin";
import { requirePermissionPreHandler } from "../../infrastructure/http/middleware/require-permission";
import {
  requireAdminLoginRateLimit,
  requireAdminOperatorsMutationRateLimit,
  requireAdminOperatorsReadRateLimit,
} from "../../infrastructure/http/middleware/admin-rate-limit";
import { AdminPermission } from "./admin-permissions";
import * as setupController from "./admin-setup.controller";
import * as invoicingController from "./admin-invoicing.controller";
import * as adminController from "./admin.controller";
import * as adminAuthController from "./admin-auth.controller";
import * as operatorsController from "./admin-operators.controller";
import * as providersController from "./admin-providers.controller";
import * as plansController from "./admin-plans.controller";
import * as featureCatalogController from "./admin-feature-catalog.controller";
import * as impersonationController from "./admin-impersonation.controller";

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

    const requireViewProviderHealth = requirePermissionPreHandler(AdminPermission.PROVIDER_VIEW_HEALTH);
    const requireManageProviderKeys = requirePermissionPreHandler(AdminPermission.PROVIDER_MANAGE_KEYS);
    const requireManageProviderRouting = requirePermissionPreHandler(AdminPermission.PROVIDER_MANAGE_ROUTING);
    const requireManagePlans = requirePermissionPreHandler(AdminPermission.BILLING_MANAGE_PLANS);

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

    adminApp.get<{ Params: { id: string } }>("/admin/users/:id/features", (request, reply) =>
      adminController.getUserFeatures(request, reply)
    );

    const requireManageAccountFeatures = requirePermissionPreHandler(AdminPermission.ACCOUNT_MANAGE_FEATURES);

    adminApp.patch<{ Params: { id: string; key: string }; Body: { granted?: boolean } }>(
      "/admin/users/:id/features/:key",
      { preHandler: requireManageAccountFeatures },
      (request, reply) => adminController.setUserFeature(request, reply)
    );

    adminApp.delete<{ Params: { id: string; key: string } }>(
      "/admin/users/:id/features/:key",
      { preHandler: requireManageAccountFeatures },
      (request, reply) => adminController.clearUserFeature(request, reply)
    );

    adminApp.post<{ Params: { id: string }; Body: { reason?: string } }>(
      "/admin/users/:id/impersonate",
      { preHandler: requirePermissionPreHandler(AdminPermission.ACCOUNT_IMPERSONATE) },
      (request, reply) => impersonationController.impersonate(request, reply)
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

    adminApp.get("/admin/setup", { preHandler: requireViewProviderHealth }, (request, reply) =>
      setupController.getSetup(request, reply)
    );

    adminApp.get("/admin/settings/invoicing", { preHandler: requireManagePlans }, (request, reply) =>
      invoicingController.getInvoicing(request, reply)
    );
    adminApp.put<{
      Body: {
        legalName?: string | null;
        gstin?: string | null;
        address?: string | null;
        sacCode?: string | null;
        invoicePrefix?: string | null;
      };
    }>("/admin/settings/invoicing", { preHandler: requireManagePlans }, (request, reply) =>
      invoicingController.saveInvoicing(request, reply)
    );

    adminApp.get(
      "/admin/providers/credentials",
      { preHandler: requireViewProviderHealth },
      (request, reply) => providersController.listCredentials(request, reply)
    );

    adminApp.post<{ Params: { id: string }; Body: { apiKey?: string } }>(
      "/admin/providers/credentials/:id/key",
      { preHandler: requireManageProviderKeys },
      (request, reply) => providersController.setCredentialKey(request, reply)
    );

    adminApp.get(
      "/admin/providers/registry",
      { preHandler: requireViewProviderHealth },
      (request, reply) => providersController.listRegistry(request, reply)
    );

    adminApp.patch<{ Params: { id: string }; Body: { visible?: boolean } }>(
      "/admin/providers/registry/:id",
      { preHandler: requireManageProviderRouting },
      (request, reply) => providersController.setVisibility(request, reply)
    );

    adminApp.patch<{ Params: { id: string }; Body: { capabilities?: string[] } }>(
      "/admin/providers/registry/:id/capabilities",
      { preHandler: requireManageProviderRouting },
      (request, reply) => providersController.setCapabilities(request, reply)
    );

    adminApp.get(
      "/admin/providers/routing",
      { preHandler: requireViewProviderHealth },
      (request, reply) => providersController.listRoutingRules(request, reply)
    );

    adminApp.patch<{
      Params: { taskType: string };
      Body: { entries?: Array<{ providerId?: string; enabled?: boolean }> };
    }>(
      "/admin/providers/routing/:taskType",
      { preHandler: requireManageProviderRouting },
      (request, reply) => providersController.updateRoutingRules(request, reply)
    );

    adminApp.get(
      "/admin/providers/tier-access",
      { preHandler: requireViewProviderHealth },
      (request, reply) => providersController.listTierAccess(request, reply)
    );

    adminApp.patch<{ Params: { id: string }; Body: { planKeys?: string[] } }>(
      "/admin/providers/tier-access/:id",
      { preHandler: requireManageProviderRouting },
      (request, reply) => providersController.updateTierAccess(request, reply)
    );

    adminApp.get("/admin/plans", (request, reply) => plansController.listPlans(request, reply));

    adminApp.patch<{
      Params: { key: string };
      Body: {
        displayName?: string;
        priceUsdCents?: number | null;
        includedCredits?: number | null;
        rateLimitRpm?: number | null;
        tagline?: string | null;
        highlights?: string[];
        selfServe?: boolean;
      };
    }>("/admin/plans/:key", { preHandler: requireManagePlans }, (request, reply) =>
      plansController.updatePlan(request, reply)
    );

    adminApp.get("/admin/features", (request, reply) =>
      featureCatalogController.listFeatures(request, reply)
    );

    adminApp.post<{ Body: { label?: string; description?: string | null } }>(
      "/admin/features",
      { preHandler: requireManagePlans },
      (request, reply) => featureCatalogController.createFeature(request, reply)
    );

    adminApp.patch<{ Params: { key: string }; Body: { label?: string; description?: string | null } }>(
      "/admin/features/:key",
      { preHandler: requireManagePlans },
      (request, reply) => featureCatalogController.updateFeature(request, reply)
    );

    adminApp.delete<{ Params: { key: string } }>(
      "/admin/features/:key",
      { preHandler: requireManagePlans },
      (request, reply) => featureCatalogController.deleteFeature(request, reply)
    );

    adminApp.get("/admin/plan-features", (request, reply) =>
      featureCatalogController.listPlanFeatureAccess(request, reply)
    );

    adminApp.patch<{ Params: { key: string }; Body: { planKeys?: string[] } }>(
      "/admin/plan-features/:key",
      { preHandler: requireManagePlans },
      (request, reply) => featureCatalogController.updatePlanFeatureAccess(request, reply)
    );
  });
}
