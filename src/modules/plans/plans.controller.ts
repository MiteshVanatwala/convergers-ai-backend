import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as plansService from "./plans.service";
import { PlanSwitchError } from "./plans.service";
import { sendPlanChangeEmail } from "../notifications/account-emails";

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

export async function switchPlan(
  request: FastifyRequest<{ Body: { planKey?: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const planKey = typeof request.body?.planKey === "string" ? request.body.planKey : "";
    if (!planKey) {
      return fail(reply, AppStatus.PLAN_SWITCH_VALIDATION_FAILED, "planKey is required", 400);
    }
    const previous = await plansService.getActivePlan(account.id);
    const membership = await plansService.switchToSelfServePlan(account.id, planKey);
    sendPlanChangeEmail({ accountId: account.id, fromKey: previous?.key ?? null, toKey: membership.key });
    return ok(reply, AppStatus.PLAN_SWITCH_OK, plansService.mapAuthPlan(membership));
  } catch (error: unknown) {
    if (error instanceof PlanSwitchError) {
      return fail(reply, AppStatus.PLAN_SWITCH_VALIDATION_FAILED, error.message, 400);
    }
    logCaught("plans.controller.switchPlan", error);
    return fail(reply, AppStatus.PLAN_SWITCH_FAILED, "Failed to switch plan", 500);
  }
}
