import type { FastifyInstance } from "fastify";
import type { RouteRequest } from "@convergers-ai/shared-types";
import * as routingController from "./routing.controller";

export function registerRoutingRoutes(app: FastifyInstance): void {
  app.get("/v1/credits", (request, reply) => routingController.credits(request, reply));

  app.get("/v1/models", (request, reply) => routingController.models(request, reply));

  app.get("/v1/my-keys", (request, reply) => routingController.myKeys(request, reply));

  app.post<{ Params: { id: string }; Body: { apiKey?: string } }>(
    "/v1/my-keys/:id",
    (request, reply) => routingController.setMyKey(request, reply)
  );

  app.delete<{ Params: { id: string } }>("/v1/my-keys/:id", (request, reply) =>
    routingController.deleteMyKey(request, reply)
  );

  app.post<{ Body: RouteRequest }>("/v1/route", (request, reply) =>
    routingController.route(request, reply)
  );

  app.post<{ Body: RouteRequest }>("/v1/route/stream", (request, reply) =>
    routingController.routeStream(request, reply)
  );
}
