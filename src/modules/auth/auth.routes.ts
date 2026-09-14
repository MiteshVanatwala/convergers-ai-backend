import type { FastifyInstance } from "fastify";
import * as authController from "./auth.controller";

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get("/auth/google/start", (request, reply) => authController.startGoogle(request, reply));

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/google/callback",
    (request, reply) => authController.googleCallback(request, reply)
  );

  app.get("/auth/me", (request, reply) => authController.me(request, reply));

  app.patch<{ Body: { name?: string | null } }>("/auth/me", (request, reply) =>
    authController.updateMe(request, reply)
  );

  app.post("/auth/logout", (request, reply) => authController.logout(request, reply));
}
