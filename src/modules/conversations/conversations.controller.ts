import type { FastifyReply, FastifyRequest } from "fastify";
import type { ChatStreamRequest, RouteResponse } from "@convergers-ai/shared-types";
import { AppStatus } from "../../config/app-status-codes";
import { loadEnv } from "../../config/env";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import { handleStreamRequest } from "../brain";
import * as usageService from "../usage/usage.service";
import * as conversationsService from "./conversations.service";
import { generateConversationTitle } from "./title.service";

type IdParams = { id: string };

export async function listConversations(
  request: FastifyRequest<{
    Querystring: { scope?: string; limit?: string; cursor?: string };
  }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const scopeRaw = request.query?.scope;
    const scope =
      scopeRaw === undefined || scopeRaw === ""
        ? "all"
        : scopeRaw === "recents" ||
            scopeRaw === "pinned" ||
            scopeRaw === "assigned" ||
            scopeRaw === "all"
          ? scopeRaw
          : null;
    if (!scope) {
      return fail(
        reply,
        AppStatus.CONVERSATION_VALIDATION_FAILED,
        "Invalid scope (use recents|pinned|assigned|all)",
        400
      );
    }

    if (scope === "pinned") {
      const rows = await conversationsService.listPinnedConversations(account.id);
      return ok(reply, AppStatus.CONVERSATIONS_LIST_RETRIEVED, {
        items: rows.map(conversationsService.mapConversation),
        nextCursor: null,
      });
    }

    if (scope === "assigned") {
      const rows = await conversationsService.listAssignedConversations(account.id);
      return ok(reply, AppStatus.CONVERSATIONS_LIST_RETRIEVED, {
        items: rows.map(conversationsService.mapConversation),
        nextCursor: null,
      });
    }

    if (scope === "recents") {
      const limitRaw = request.query?.limit;
      const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 40;
      const limit = Number.isFinite(limitParsed) ? Math.min(Math.max(limitParsed, 1), 100) : 40;
      const cursorRaw = request.query?.cursor;
      let cursor: conversationsService.RecentsCursor | null = null;
      if (typeof cursorRaw === "string" && cursorRaw.trim()) {
        cursor = conversationsService.decodeRecentsCursor(cursorRaw.trim());
        if (!cursor) {
          return fail(reply, AppStatus.CONVERSATION_VALIDATION_FAILED, "Invalid cursor", 400);
        }
      }
      const page = await conversationsService.listRecentsPage(account.id, limit, cursor);
      return ok(reply, AppStatus.CONVERSATIONS_LIST_RETRIEVED, {
        items: page.rows.map(conversationsService.mapConversation),
        nextCursor: page.nextCursor,
      });
    }

    const rows = await conversationsService.listConversations(account.id);
    return ok(reply, AppStatus.CONVERSATIONS_LIST_RETRIEVED, {
      items: rows.map(conversationsService.mapConversation),
      nextCursor: null,
    });
  } catch (error: unknown) {
    logCaught("conversations.controller.listConversations", error);
    request.log.error({ err: error }, "[conversations.controller.listConversations] failed");
    return fail(reply, AppStatus.CONVERSATIONS_FETCH_FAILED, "Failed to load conversations", 500);
  }
}

export async function getConversation(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const row = await conversationsService.getConversationForAccount(account.id, request.params.id);
    if (!row) {
      return fail(reply, AppStatus.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
    }
    return ok(reply, AppStatus.CONVERSATION_RETRIEVED, conversationsService.mapConversation(row));
  } catch (error: unknown) {
    logCaught("conversations.controller.getConversation", error);
    request.log.error({ err: error }, "[conversations.controller.getConversation] failed");
    return fail(reply, AppStatus.CONVERSATIONS_FETCH_FAILED, "Failed to load conversation", 500);
  }
}

export async function listMessages(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const conversation = await conversationsService.getConversationForAccount(
      account.id,
      request.params.id
    );
    if (!conversation) {
      return fail(reply, AppStatus.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
    }
    const rows = await conversationsService.listMessages(account.id, request.params.id);
    return ok(reply, AppStatus.MESSAGES_LIST_RETRIEVED, {
      items: rows.map(conversationsService.mapMessage),
    });
  } catch (error: unknown) {
    logCaught("conversations.controller.listMessages", error);
    request.log.error({ err: error }, "[conversations.controller.listMessages] failed");
    return fail(reply, AppStatus.MESSAGES_FETCH_FAILED, "Failed to load messages", 500);
  }
}

export async function patchConversation(
  request: FastifyRequest<{
    Params: IdParams;
    Body: { title?: string; pinned?: boolean; archived?: boolean; projectId?: string | null };
  }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const body = request.body ?? {};
    if (
      body.title === undefined &&
      body.pinned === undefined &&
      body.archived === undefined &&
      body.projectId === undefined
    ) {
      return fail(reply, AppStatus.CONVERSATION_VALIDATION_FAILED, "No fields to update", 400);
    }
    if (body.title !== undefined && typeof body.title !== "string") {
      return fail(reply, AppStatus.CONVERSATION_VALIDATION_FAILED, "Invalid title", 400);
    }
    if (
      body.projectId !== undefined &&
      body.projectId !== null &&
      typeof body.projectId !== "string"
    ) {
      return fail(reply, AppStatus.CONVERSATION_VALIDATION_FAILED, "Invalid projectId", 400);
    }

    const row = await conversationsService.updateConversation(account.id, request.params.id, body);
    if (row === "invalid_project") {
      return fail(reply, AppStatus.CONVERSATION_VALIDATION_FAILED, "Project not found", 400);
    }
    if (!row) {
      return fail(reply, AppStatus.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
    }
    return ok(reply, AppStatus.CONVERSATION_UPDATED, conversationsService.mapConversation(row));
  } catch (error: unknown) {
    logCaught("conversations.controller.patchConversation", error);
    request.log.error({ err: error }, "[conversations.controller.patchConversation] failed");
    return fail(reply, AppStatus.CONVERSATION_UPDATE_FAILED, "Failed to update conversation", 500);
  }
}

export async function archiveConversation(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  try {
    const okArchive = await conversationsService.archiveConversation(account.id, request.params.id);
    if (!okArchive) {
      return fail(reply, AppStatus.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
    }
    return ok(reply, AppStatus.CONVERSATION_ARCHIVED, { id: request.params.id });
  } catch (error: unknown) {
    logCaught("conversations.controller.archiveConversation", error);
    request.log.error({ err: error }, "[conversations.controller.archiveConversation] failed");
    return fail(reply, AppStatus.CONVERSATION_ARCHIVE_FAILED, "Failed to archive conversation", 500);
  }
}

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

export async function chatStream(
  request: FastifyRequest<{ Body: ChatStreamRequest }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;

  const body: ChatStreamRequest = request.body ?? { input: "" };
  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (!input) {
    return fail(reply, AppStatus.CHAT_STREAM_VALIDATION_FAILED, "input is required", 400);
  }

  const requestedId =
    typeof body.conversationId === "string" && body.conversationId.trim()
      ? body.conversationId.trim()
      : null;
  if (requestedId && !conversationsService.isUuid(requestedId)) {
    return fail(reply, AppStatus.CHAT_STREAM_VALIDATION_FAILED, "Invalid conversationId", 400);
  }

  const res = writeSseHeaders(request, reply);
  const send = (event: string, data: unknown) => {
    if (res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    let conversation = requestedId
      ? await conversationsService.getConversationForAccount(account.id, requestedId)
      : null;

    if (requestedId && !conversation) {
      send("error", { message: "Conversation not found" });
      return;
    }

    let created = false;
    if (!conversation) {
      conversation = await conversationsService.createConversation(
        account.id,
        conversationsService.provisionalTitle(input)
      );
      created = true;
    }

    send("conversation", { id: conversation.id });

    await conversationsService.insertMessage({
      conversationId: conversation.id,
      accountId: account.id,
      role: "user",
      content: input,
      status: "complete",
    });

    const routeBody = {
      input,
      ...(body.modality_hint ? { modality_hint: body.modality_hint } : {}),
      ...(body.policy ? { policy: body.policy } : {}),
    };

    const result: RouteResponse = await handleStreamRequest(
      routeBody,
      account.id,
      (text) => send("delta", { text }),
      (event) => send("stage", event),
      { conversationId: conversation.id }
    );

    const assistantMessage = await conversationsService.insertMessage({
      conversationId: conversation.id,
      accountId: account.id,
      role: "assistant",
      content: result.content,
      provider: result.provider_used,
      tokensInput: result.usage.input_tokens,
      tokensOutput: result.usage.output_tokens,
      creditsCharged: result.credits_charged,
      status: "complete",
    });

    if (result.usage_event_id) {
      try {
        await usageService.attachMessage(
          result.usage_event_id,
          assistantMessage.id,
          conversation.id
        );
      } catch (attachErr: unknown) {
        request.log.error(
          { err: attachErr },
          "[conversations.controller.chatStream] usage attachMessage failed"
        );
      }
    }

    if (conversation.title_status === "pending" || created) {
      const title = await generateConversationTitle(input);
      if (title) {
        const updated = await conversationsService.setGeneratedTitle(
          account.id,
          conversation.id,
          title
        );
        if (updated?.title) {
          send("title", { title: updated.title });
        }
      }
    }

    send("done", { ...result, conversationId: conversation.id });
  } catch (err) {
    request.log.error(err);
    send("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
}
