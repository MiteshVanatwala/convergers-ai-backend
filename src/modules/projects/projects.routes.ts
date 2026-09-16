import type { FastifyInstance } from "fastify";
import * as projectsController from "./projects.controller";

export function registerProjectRoutes(app: FastifyInstance): void {
  app.get("/v1/projects", (request, reply) => projectsController.listProjects(request, reply));

  app.post<{ Body: { name?: string } }>("/v1/projects", (request, reply) =>
    projectsController.createProject(request, reply)
  );

  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    "/v1/projects/:id",
    (request, reply) => projectsController.patchProject(request, reply)
  );

  app.delete<{ Params: { id: string } }>("/v1/projects/:id", (request, reply) =>
    projectsController.archiveProject(request, reply)
  );
}
