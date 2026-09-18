import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as plansService from "./plans.service";

export async function listPlans(request: FastifyRequest, reply: FastifyReply) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const rows = await plansService.listCatalogPlans();
    return ok(reply, AppStatus.PLANS_LIST_RETRIEVED, {
      plans: rows.map(plansService.mapCatalogPlan),
    });
  } catch (error: unknown) {
    logCaught("plans.controller.listPlans", error);
    request.log.error({ err: error }, "[plans.controller.listPlans] failed");
    return fail(reply, AppStatus.PLANS_FETCH_FAILED, "Failed to load plans", 500);
  }
}
