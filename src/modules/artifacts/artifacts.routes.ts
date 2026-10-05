import type { FastifyInstance } from "fastify";
import * as artifactsController from "./artifacts.controller";

export function registerArtifactRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string; offset?: string } }>("/v1/artifacts", (request, reply) =>
    artifactsController.listMine(request, reply)
  );
  // Public gallery — no sign-in. Registered before "/:id" so it isn't read as an id.
  app.get<{ Querystring: { limit?: string; offset?: string } }>("/v1/artifacts/public", (request, reply) =>
    artifactsController.listPublic(request, reply)
  );
  app.get<{ Params: { id: string } }>("/v1/artifacts/:id", (request, reply) =>
    artifactsController.getOne(request, reply)
  );
  app.get<{ Params: { id: string }; Querystring: { version?: string } }>(
    "/v1/artifacts/:id/content",
    (request, reply) => artifactsController.getContent(request, reply)
  );
  app.patch<{ Params: { id: string }; Body: { title?: unknown; visibility?: unknown } }>(
    "/v1/artifacts/:id",
    (request, reply) => artifactsController.update(request, reply)
  );
  app.delete<{ Params: { id: string } }>("/v1/artifacts/:id", (request, reply) =>
    artifactsController.remove(request, reply)
  );

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/v1/images", (request, reply) =>
    artifactsController.listMyImages(request, reply)
  );
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/v1/files/:id", (request, reply) =>
    artifactsController.getFileContent(request, reply)
  );
}
