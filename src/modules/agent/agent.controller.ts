/**
 * POST /v1/agent/round — native tool_use SSE for IDE Agent.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { AgentRoundRequest, IdeAgentToolName } from "@convergers-ai/shared-types";
import { AppStatus } from "../../config/app-status-codes";
import { loadEnv } from "../../config/env";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { fail } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import { assertHasCredits, userFacingPayload } from "../brain";
import { isUuid } from "../conversations/conversations.service";
import { runAnthropicAgentRound } from "./agent.round";

function writeSseHeaders(request: FastifyRequest, reply: FastifyReply) {
  const corsHeaders = reply.getHeaders();
  reply.hijack();
  const res = reply.raw;
  for (const [key, value] of Object.entries(corsHeaders)) {
    if (value !== undefined) res.setHeader(key, value);
  }

  const env = loadEnv();
  const origin = request.headers.origin;
  const allowed = [...env.webOrigins, ...env.adminOrigins];
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.writeHead(200);
  return res;
}

export async function agentRound(
  request: FastifyRequest<{ Body: AgentRoundRequest }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;

  const body = request.body ?? ({ messages: [] } as AgentRoundRequest);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return fail(
      reply,
      AppStatus.CHAT_STREAM_VALIDATION_FAILED,
      "messages are required",
      400
    );
  }

  const res = writeSseHeaders(request, reply);
  const send = (event: string, data: unknown) => {
    if (res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await assertHasCredits(account.id);

    const toolNames = Array.isArray(body.tools)
      ? (body.tools.filter(Boolean) as IdeAgentToolName[])
      : undefined;

    // IDE uses local ids like `conv_…` — usage_events.conversation_id is UUID-only.
    // Same as /v1/chat/stream for client_type=ide: omit non-UUID ids from billing rows.
    const rawConvId =
      typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    const conversationId = rawConvId && isUuid(rawConvId) ? rawConvId : undefined;

    const result = await runAnthropicAgentRound({
      accountId: account.id,
      messages: body.messages,
      toolNames,
      providerId: typeof body.providerId === "string" ? body.providerId : undefined,
      conversationId,
      handlers: {
        onDelta: (text) => send("delta", { text }),
        onToolCalls: (calls) => send("tool_calls", { calls }),
      },
    });

    send("done", result);
  } catch (err) {
    logCaught("agent.controller.agentRound", err);
    const payload = userFacingPayload(err);
    send("error", {
      message: payload.message,
      code: payload.code,
    });
  } finally {
    if (!res.destroyed) res.end();
  }
}
