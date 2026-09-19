import type { FastifyInstance } from "fastify";
import * as usageController from "./usage.controller";

type UsageQuery = {
  from?: string;
  to?: string;
  provider?: string;
  task_type?: string;
  outcome?: string;
  limit?: string;
  cursor?: string;
};

export function registerUsageRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: UsageQuery }>("/v1/usage/events", (request, reply) =>
    usageController.listEvents(request, reply)
  );

  app.get<{ Querystring: UsageQuery }>("/v1/usage/summary", (request, reply) =>
    usageController.summary(request, reply)
  );

  app.get<{ Querystring: UsageQuery }>("/v1/usage/export", (request, reply) =>
    usageController.exportCsv(request, reply)
  );
}
