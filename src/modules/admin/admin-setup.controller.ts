import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as setupService from "./admin-setup.service";
import * as dashboardService from "./admin-dashboard.service";

/** GET /admin/setup — read-only setup checklist (config, schema, providers). */
export async function getSetup(request: FastifyRequest, reply: FastifyReply) {
  try {
    const checklist = await setupService.getSetupChecklist();
    return ok(reply, AppStatus.ADMIN_SETUP_RETRIEVED, checklist);
  } catch (error: unknown) {
    logCaught("admin.setup.controller.getSetup", error);
    request.log.error({ err: error }, "[admin.setup.controller.getSetup] failed");
    return fail(reply, AppStatus.ADMIN_SETUP_FETCH_FAILED, "Failed to load setup checklist", 500);
  }
}

/** GET /admin/dashboard?range=1h|24h|7d — live dashboard snapshot (polled by the admin app). */
export async function getDashboard(
  request: FastifyRequest<{ Querystring: { range?: string } }>,
  reply: FastifyReply
) {
  const range = dashboardService.isDashboardRange(request.query.range) ? request.query.range : "24h";
  try {
    const snapshot = await dashboardService.getDashboardSnapshot(range);
    return ok(reply, AppStatus.ADMIN_DASHBOARD_RETRIEVED, snapshot);
  } catch (error: unknown) {
    logCaught("admin.setup.controller.getDashboard", error);
    request.log.error({ err: error }, "[admin.setup.controller.getDashboard] failed");
    return fail(reply, AppStatus.ADMIN_DASHBOARD_FETCH_FAILED, "Failed to load dashboard", 500);
  }
}
