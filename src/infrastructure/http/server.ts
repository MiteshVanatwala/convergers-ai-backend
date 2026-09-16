import Fastify from "fastify";
import { registerCors } from "./plugins/cors";
import { registerAuthRoutes } from "../../modules/auth/auth.routes";
import { registerHealthRoutes } from "../../modules/health/health.routes";
import { registerRoutingRoutes } from "../../modules/routing/routing.routes";
import { registerAdminRoutes } from "../../modules/admin/admin.routes";
import { registerConversationRoutes } from "../../modules/conversations/conversations.routes";
import { registerProjectRoutes } from "../../modules/projects/projects.routes";
import { registerUsageRoutes } from "../../modules/usage/usage.routes";

export async function buildServer() {
  const app = Fastify({ logger: true });

  await registerCors(app);

  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerRoutingRoutes(app);
  registerConversationRoutes(app);
  registerProjectRoutes(app);
  registerUsageRoutes(app);
  registerAdminRoutes(app);

  return app;
}
