import type { FastifyInstance } from "fastify";
import type { ChatStreamRequest } from "@convergers-ai/shared-types";
import * as conversationsController from "./conversations.controller";

export function registerConversationRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { scope?: string; limit?: string; cursor?: string } }>(
    "/v1/conversations",
    (request, reply) => conversationsController.listConversations(request, reply)
  );

  app.get<{ Params: { id: string } }>("/v1/conversations/:id", (request, reply) =>
    conversationsController.getConversation(request, reply)
  );

  app.get<{ Params: { id: string } }>("/v1/conversations/:id/messages", (request, reply) =>
    conversationsController.listMessages(request, reply)
  );

  app.patch<{
    Params: { id: string };
    Body: { title?: string; pinned?: boolean; archived?: boolean; projectId?: string | null };
  }>("/v1/conversations/:id", (request, reply) =>
    conversationsController.patchConversation(request, reply)
  );

  app.delete<{ Params: { id: string } }>("/v1/conversations/:id", (request, reply) =>
    conversationsController.archiveConversation(request, reply)
  );

  app.post<{ Body: ChatStreamRequest }>("/v1/chat/stream", (request, reply) =>
    conversationsController.chatStream(request, reply)
  );
}
