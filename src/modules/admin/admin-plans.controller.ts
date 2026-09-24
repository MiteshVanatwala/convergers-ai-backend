import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import * as plansService from "./admin-plans.service";
import { BillingPlanError } from "./admin-plans.service";

function failFromBillingPlanError(reply: FastifyReply, error: BillingPlanError) {
  switch (error.kind) {
    case "validation":
      return fail(reply, AppStatus.ADMIN_PLAN_VALIDATION_FAILED, error.message, 400);
    case "not_found":
      return fail(reply, AppStatus.ADMIN_PLAN_NOT_FOUND, error.message, 404);
  }
}

export async function listPlans(request: FastifyRequest, reply: FastifyReply) {
  try {
    const plans = await plansService.listPlansAdmin();
    return ok(reply, AppStatus.ADMIN_PLANS_RETRIEVED, plans);
  } catch (error: unknown) {
    logCaught("admin.admin-plans.controller.listPlans", error);
    return fail(reply, AppStatus.ADMIN_PLANS_FETCH_FAILED, "Failed to list plans", 500);
  }
}

type UpdatePlanBody = {
  displayName?: string;
  priceUsdCents?: number | null;
  includedCredits?: number | null;
  rateLimitRpm?: number | null;
  tagline?: string | null;
  selfServe?: boolean;
};

export async function updatePlan(
  request: FastifyRequest<{ Params: { key: string }; Body: UpdatePlanBody }>,
  reply: FastifyReply
) {
  try {
    const body = request.body ?? {};
    if (typeof body.displayName !== "string") {
      return fail(reply, AppStatus.ADMIN_PLAN_VALIDATION_FAILED, "displayName is required", 400);
    }
    if (typeof body.selfServe !== "boolean") {
      return fail(reply, AppStatus.ADMIN_PLAN_VALIDATION_FAILED, "selfServe must be a boolean", 400);
    }

    const result = await plansService.updatePlan({
      actorId: request.admin!.id,
      key: request.params.key,
      displayName: body.displayName,
      priceUsdCents: body.priceUsdCents ?? null,
      includedCredits: body.includedCredits ?? null,
      rateLimitRpm: body.rateLimitRpm ?? null,
      tagline: body.tagline ?? null,
      selfServe: body.selfServe,
    });
    return ok(reply, AppStatus.ADMIN_PLAN_UPDATED, result);
  } catch (error: unknown) {
    if (error instanceof BillingPlanError) return failFromBillingPlanError(reply, error);
    logCaught("admin.admin-plans.controller.updatePlan", error);
    return fail(reply, AppStatus.ADMIN_PLAN_UPDATE_FAILED, "Failed to update plan", 500);
  }
}
