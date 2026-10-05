import type { FastifyInstance } from "fastify";
import type { AgentRoundRequest } from "@convergers-ai/shared-types";
import * as agentController from "./agent.controller";

export function registerAgentRoutes(app: FastifyInstance): void {
  app.post<{ Body: AgentRoundRequest }>("/v1/agent/round", (request, reply) =>
    agentController.agentRound(request, reply)
  );
}
