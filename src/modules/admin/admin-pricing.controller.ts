import type { FastifyReply, FastifyRequest } from "fastify";
import { AppStatus } from "../../config/app-status-codes";
import { fail, ok } from "../../shared/http/api-response";
import * as pricingService from "./admin-pricing.service";

/** GET /admin/pricing — read-only: how tokens and other usage turn into credits. */
export async function getPricing(request: FastifyRequest, reply: FastifyReply) {
  try {
    const pricing = await pricingService.getPricing();
    return ok(reply, AppStatus.ADMIN_PRICING_RETRIEVED, pricing);
  } catch (error: unknown) {
    request.log.error({ err: error }, "[admin.pricing.controller.getPricing] failed");
    return fail(reply, AppStatus.ADMIN_PRICING_FETCH_FAILED, "Failed to load pricing", 500);
  }
}

/** GET /admin/pricing/profit?range=7d|30d|90d|all — revenue vs provider cost for a period. */
export async function getProfit(
  request: FastifyRequest<{ Querystring: { range?: string } }>,
  reply: FastifyReply
) {
  const range = pricingService.isProfitRange(request.query.range) ? request.query.range : "30d";
  try {
    const profit = await pricingService.getProfit(range);
    return ok(reply, AppStatus.ADMIN_PROFIT_RETRIEVED, profit);
  } catch (error: unknown) {
    request.log.error({ err: error }, "[admin.pricing.controller.getProfit] failed");
    return fail(reply, AppStatus.ADMIN_PROFIT_FETCH_FAILED, "Failed to load profit", 500);
  }
}
