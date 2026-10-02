import type { FastifyInstance } from "fastify";
import * as authController from "./auth.controller";
import * as emailLoginController from "./email-login.controller";

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get("/auth/google/start", (request, reply) => authController.startGoogle(request, reply));

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/google/callback",
    (request, reply) => authController.googleCallback(request, reply)
  );

  // Email one-time-code sign-in (alongside Google).
  app.post<{ Body: { email?: string } }>("/auth/email/start", (request, reply) =>
    emailLoginController.startEmailLogin(request, reply)
  );
  app.post<{ Body: { email?: string; code?: string } }>("/auth/email/verify", (request, reply) =>
    emailLoginController.verifyEmailLogin(request, reply)
  );

  app.get("/auth/me", (request, reply) => authController.me(request, reply));

  app.patch<{ Body: { name?: string | null } }>("/auth/me", (request, reply) =>
    authController.updateMe(request, reply)
  );

  app.post("/auth/logout", (request, reply) => authController.logout(request, reply));
}
