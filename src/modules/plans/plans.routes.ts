import type { FastifyInstance } from "fastify";
import * as plansController from "./plans.controller";

export function registerPlanRoutes(app: FastifyInstance): void {
  app.get("/v1/plans", (request, reply) => plansController.listPlans(request, reply));
}
