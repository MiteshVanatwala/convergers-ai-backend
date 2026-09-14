import type { FastifyInstance } from "fastify";
import type { RouteRequest } from "@convergers-ai/shared-types";
import * as routingController from "./routing.controller";

export function registerRoutingRoutes(app: FastifyInstance): void {
  app.get("/v1/credits", (request, reply) => routingController.credits(request, reply));

  app.post<{ Body: RouteRequest }>("/v1/route", (request, reply) =>
    routingController.route(request, reply)
  );

  app.post<{ Body: RouteRequest }>("/v1/route/stream", (request, reply) =>
    routingController.routeStream(request, reply)
  );
}
