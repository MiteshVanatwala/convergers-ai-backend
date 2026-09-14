import type { FastifyInstance } from "fastify";
import * as healthController from "./health.controller";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", (request, reply) => healthController.health(request, reply));
}
