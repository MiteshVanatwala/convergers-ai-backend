import Fastify from "fastify";
import { registerCors } from "./plugins/cors";
import { registerAuthRoutes } from "../../modules/auth/auth.routes";
import { registerHealthRoutes } from "../../modules/health/health.routes";
import { registerRoutingRoutes } from "../../modules/routing/routing.routes";
import { registerAdminRoutes } from "../../modules/admin/admin.routes";
import { registerConversationRoutes } from "../../modules/conversations/conversations.routes";
import { registerAgentRoutes } from "../../modules/agent/agent.routes";
import { registerProjectRoutes } from "../../modules/projects/projects.routes";
import { registerOrgRoutes } from "../../modules/orgs/orgs.routes";
import { registerSalesRoutes } from "../../modules/sales/sales.routes";
import { registerArtifactRoutes } from "../../modules/artifacts/artifacts.routes";
import { registerVoiceRoutes } from "../../modules/voice/voice.routes";
import { registerUsageRoutes } from "../../modules/usage/usage.routes";
import { registerPlanRoutes } from "../../modules/plans/plans.routes";
import { registerBillingRoutes, registerRazorpayWebhookRoute } from "../../modules/billing/billing.routes";
import { initProviderConfig } from "../../modules/brain/adapters/provider-config-loader";

export async function buildServer() {
  const app = Fastify({ logger: true });

  await registerCors(app);
  await initProviderConfig();

  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerRoutingRoutes(app);
  registerConversationRoutes(app);
  registerAgentRoutes(app);
  registerProjectRoutes(app);
  registerOrgRoutes(app);
  registerSalesRoutes(app);
  registerArtifactRoutes(app);
  registerVoiceRoutes(app);
  registerUsageRoutes(app);
  registerPlanRoutes(app);
  registerBillingRoutes(app);
  await registerRazorpayWebhookRoute(app);
  registerAdminRoutes(app);

  return app;
}
