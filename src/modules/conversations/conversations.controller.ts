import type { FastifyReply, FastifyRequest } from "fastify";
import type { ChatMode, ChatStreamRequest, WebSearchSetting } from "@convergers-ai/shared-types";
import { AppStatus } from "../../config/app-status-codes";
import { loadEnv } from "../../config/env";
import { requireSession } from "../../infrastructure/http/middleware/require-session";
import { fail, ok } from "../../shared/http/api-response";
import { logCaught } from "../../shared/utils/log";
import {
  assertHasCredits,
  handleCrossCheck,
  handleStreamRequest,
  isSensitiveFilterEnabled,
  RequestStoppedError,
  userFacingPayload,
  type ChatResult,
} from "../brain";
import { getPersonalizationSettings } from "../auth/auth.service";
import * as usageService from "../usage/usage.service";
import { expandHistoryArtifacts, storeAnswerArtifacts } from "../artifacts/chat-artifacts";
import { storeAnswerImages } from "../artifacts/chat-images";
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

/** DELETE /v1/conversations/:id/messages/:messageId — removes one turn (prompt + answer). */
export async function deleteMessage(
  request: FastifyRequest<{ Params: IdParams & { messageId: string } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  const { id, messageId } = request.params;
  if (!conversationsService.isUuid(id) || !conversationsService.isMessageId(messageId)) {
    return fail(reply, AppStatus.MESSAGE_NOT_FOUND, "Message not found", 404);
  }
  try {
    const deleted = await conversationsService.deleteTurn(account.id, id, messageId);
    if (!deleted) return fail(reply, AppStatus.MESSAGE_NOT_FOUND, "Message not found", 404);
    return ok(reply, AppStatus.MESSAGE_DELETED, { id: messageId });
  } catch (error: unknown) {
    logCaught("conversations.controller.deleteMessage", error);
    return fail(reply, AppStatus.MESSAGE_DELETE_FAILED, "Failed to delete message", 500);
  }
}

const CHAT_MODES: readonly ChatMode[] = ["standard", "council", "debate", "compare", "deep_research"];
const WEB_SEARCH_SETTINGS: readonly WebSearchSetting[] = ["auto", "on", "off"];

type AnswerParams = IdParams & { messageId: string };

/** POST /v1/conversations/:id/messages/:messageId/vote — picks a compare candidate as the answer. */
export async function voteOnAnswer(
  request: FastifyRequest<{ Params: AnswerParams; Body: { chosen?: unknown } }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  const { id, messageId } = request.params;
  if (!conversationsService.isUuid(id) || !conversationsService.isMessageId(messageId)) {
    return fail(reply, AppStatus.MESSAGE_NOT_FOUND, "Message not found", 404);
  }
  const chosen = request.body?.chosen;
  if (typeof chosen !== "number" || !Number.isInteger(chosen) || chosen < 0) {
    return fail(reply, AppStatus.ANSWER_VOTE_VALIDATION_FAILED, "chosen must be a candidate index", 400);
  }
  try {
    const found = await conversationsService.getAnswerWithPrompt(account.id, id, messageId);
    if (!found) return fail(reply, AppStatus.MESSAGE_NOT_FOUND, "Message not found", 404);
    if (found.answer.metadata?.mode !== "compare") {
      return fail(reply, AppStatus.ANSWER_VOTE_VALIDATION_FAILED, "This answer isn't a comparison", 400);
    }
    const updated = await conversationsService.chooseCandidate({
      accountId: account.id,
      conversationId: id,
      message: found.answer,
      chosen,
    });
    if (!updated) {
      return fail(reply, AppStatus.ANSWER_VOTE_VALIDATION_FAILED, "No such candidate", 400);
    }
    return ok(reply, AppStatus.ANSWER_VOTE_RECORDED, conversationsService.mapMessage(updated));
  } catch (error: unknown) {
    logCaught("conversations.controller.voteOnAnswer", error);
    return fail(reply, AppStatus.ANSWER_VOTE_FAILED, "Failed to record your choice", 500);
  }
}

/** POST /v1/conversations/:id/messages/:messageId/crosscheck — a second model checks this answer. */
export async function crossCheckAnswer(
  request: FastifyRequest<{ Params: AnswerParams }>,
  reply: FastifyReply
) {
  const account = await requireSession(request, reply);
  if (!account) return;
  const { id, messageId } = request.params;
  if (!conversationsService.isUuid(id) || !conversationsService.isMessageId(messageId)) {
    return fail(reply, AppStatus.MESSAGE_NOT_FOUND, "Message not found", 404);
  }
  try {
    const found = await conversationsService.getAnswerWithPrompt(account.id, id, messageId);
    if (!found || !found.prompt || found.answer.status !== "complete" || !found.answer.content.trim()) {
      return fail(reply, AppStatus.MESSAGE_NOT_FOUND, "There's no finished answer to check here", 404);
    }
    const history = found.history
      .filter((m) => m.status === "complete" && (m.role === "user" || m.role === "assistant"))
      .slice(-10)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const { customInstructions } = await getPersonalizationSettings(account.id);
    const { crosscheck, usageEventId } = await handleCrossCheck({
      question: found.prompt.content,
      answer: found.answer.content,
      answerProvider: found.answer.provider,
      otherProviders: [...(found.answer.metadata?.candidates ?? []), ...(found.answer.metadata?.members ?? [])]
        .filter((m) => !m.failed)
        .map((m) => m.provider),
      history: await expandHistoryArtifacts(account.id, history),
      accountId: account.id,
      customInstructions,
      conversationId: id,
    });
    await conversationsService.mergeMessageMetadata(account.id, messageId, { crosscheck });
    if (usageEventId) {
      await usageService.attachMessage(usageEventId, messageId, id).catch((attachErr: unknown) =>
        logCaught("conversations.controller.crossCheckAnswer.attach", attachErr)
      );
    }
    return ok(reply, AppStatus.CROSSCHECK_COMPLETED, { crosscheck });
  } catch (error: unknown) {
    logCaught("conversations.controller.crossCheckAnswer", error);
    const payload = userFacingPayload(error);
    return fail(reply, AppStatus.CROSSCHECK_FAILED, payload.message, 502);
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
  const replaceFrom =
    typeof body.replaceFromMessageId === "string" ? body.replaceFromMessageId.trim() : null;
  if (replaceFrom && (!requestedId || !conversationsService.isMessageId(replaceFrom))) {
    return fail(reply, AppStatus.CHAT_STREAM_VALIDATION_FAILED, "Invalid replaceFromMessageId", 400);
  }
  const mode: ChatMode = body.mode ?? "standard";
  if (!CHAT_MODES.includes(mode)) {
    return fail(reply, AppStatus.CHAT_STREAM_VALIDATION_FAILED, "Invalid mode", 400);
  }
  const webSearch: WebSearchSetting = body.webSearch ?? "auto";
  if (!WEB_SEARCH_SETTINGS.includes(webSearch)) {
    return fail(reply, AppStatus.CHAT_STREAM_VALIDATION_FAILED, "Invalid webSearch", 400);
  }
  const compareProviderIds = body.compareProviderIds ?? [];
  if (
    !Array.isArray(compareProviderIds) ||
    compareProviderIds.length > 3 ||
    compareProviderIds.some((id) => typeof id !== "string")
  ) {
    return fail(reply, AppStatus.CHAT_STREAM_VALIDATION_FAILED, "Invalid compareProviderIds", 400);
  }

  const res = writeSseHeaders(request, reply);
  const send = (event: string, data: unknown) => {
    if (res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // The client's Stop button aborts its fetch, which closes the connection —
  // stop the model too, so it isn't billed for an answer nobody will read.
  const stop = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) stop.abort();
  });

  // Set once the prompt is saved and until its answer is — a failure in
  // between is saved as an error answer, so history doesn't show a bare prompt.
  let unanswered: { conversationId: string } | null = null;

  try {
    // Check before creating the conversation / storing the prompt, so an
    // out-of-credits request leaves nothing behind. (handleStreamRequest
    // re-checks for the other entry points.)
    await assertHasCredits(account.id);

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

    // Edit / regenerate: the old turn (and anything after it) gives way to this one.
    if (replaceFrom) {
      const replaced = await conversationsService.deleteFromMessage(
        account.id,
        conversation.id,
        replaceFrom
      );
      if (!replaced) {
        send("error", { message: "That message no longer exists. Reload the chat and try again." });
        return;
      }
    }

    // Fetch prior turns BEFORE inserting the current message — otherwise
    // it would show up as a duplicate trailing "history" entry alongside
    // being passed separately as `input`.
    const priorMessages = created
      ? []
      : await conversationsService.listMessages(account.id, conversation.id, 20);
    // Artifact references in earlier answers are expanded back into their
    // source so the model can keep editing them.
    const history = await expandHistoryArtifacts(
      account.id,
      priorMessages
        // A stopped answer stays in context, so "continue" picks up where it left off.
        .filter(
          (m) =>
            (m.status === "complete" || (m.status === "cancelled" && m.content.trim() !== "")) &&
            (m.role === "user" || m.role === "assistant")
        )
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
    );

    const userMessage = await conversationsService.insertMessage({
      conversationId: conversation.id,
      accountId: account.id,
      role: "user",
      content: input,
      status: "complete",
    });
    // Lets the client edit, regenerate or delete this turn later.
    send("turn", { userMessageId: userMessage.id });
    unanswered = { conversationId: conversation.id };

    const routeBody = {
      input,
      ...(body.modality_hint ? { modality_hint: body.modality_hint } : {}),
      ...(body.policy ? { policy: body.policy } : {}),
      ...(body.providerId ? { providerId: body.providerId } : {}),
      ...(history.length > 0 ? { history } : {}),
    };

    const { customInstructions } = await getPersonalizationSettings(account.id);
    let rawResult: ChatResult;
    try {
      rawResult = await handleStreamRequest(
        routeBody,
        account.id,
        (text) => send("delta", { text }),
        (event) => send("stage", event),
        { conversationId: conversation.id },
        {
          artifacts: true,
          signal: stop.signal,
          mode,
          webSearch,
          compareProviderIds,
          customInstructions,
        }
      );
    } catch (err) {
      if (!(err instanceof RequestStoppedError)) throw err;
      unanswered = null;
      // Stopped before any model answered — keep the turn so history shows it as stopped.
      await conversationsService.insertMessage({
        conversationId: conversation.id,
        accountId: account.id,
        role: "assistant",
        content: "",
        status: "cancelled",
      });
      return;
    }

    // Generated images and artifacts go to object storage and are swapped
    // for links/references before the answer is saved.
    const withImages = await storeAnswerImages({
      accountId: account.id,
      conversationId: conversation.id,
      content: rawResult.content,
    });
    const stored = await storeAnswerArtifacts({
      accountId: account.id,
      conversationId: conversation.id,
      content: withImages.content,
    });
    const { usageEventIds, ...result } = { ...rawResult, content: stored.content };

    const assistantMessage = await conversationsService.insertMessage({
      conversationId: conversation.id,
      accountId: account.id,
      role: "assistant",
      content: result.content,
      provider: result.provider_used,
      tokensInput: result.usage.input_tokens,
      tokensOutput: result.usage.output_tokens,
      creditsCharged: result.credits_charged,
      status: result.stopped ? "cancelled" : "complete",
      metadata: result.metadata ?? null,
    });
    unanswered = null;

    // Every call that went into the answer (search, council members, chair…).
    for (const usageEventId of usageEventIds) {
      try {
        await usageService.attachMessage(usageEventId, assistantMessage.id, conversation.id);
      } catch (attachErr: unknown) {
        request.log.error(
          { err: attachErr },
          "[conversations.controller.chatStream] usage attachMessage failed"
        );
      }
    }

    // The title model sees the raw prompt, so skip it when the account filters
    // sensitive data — the conversation keeps its local provisional title.
    if (
      (conversation.title_status === "pending" || created) &&
      !(await isSensitiveFilterEnabled(account.id))
    ) {
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

    send("done", { ...result, conversationId: conversation.id, assistant_message_id: assistantMessage.id });
  } catch (err) {
    request.log.error(err);
    const payload = userFacingPayload(err);
    send("error", payload);
    if (unanswered) {
      await conversationsService
        .insertMessage({
          conversationId: unanswered.conversationId,
          accountId: account.id,
          role: "assistant",
          content: payload.message,
          status: "error",
        })
        .catch((saveErr: unknown) => logCaught("conversations.controller.chatStream.saveError", saveErr));
    }
  } finally {
    res.end();
  }
}
