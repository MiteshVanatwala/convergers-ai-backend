// The Brain: the only part of the system that knows a specific provider
// exists. Everything outside this module talks to it through the functions
// below — nothing else imports a provider SDK, formats a provider-specific
// prompt, or parses a provider-specific response.
//
// See the technical plan §01 for the full interface contract.

import type {
  AnswerSource,
  ChatMode,
  CrossCheck,
  MemberAnswer,
  RouteRequest,
  RouteResponse,
  WebSearchSetting,
} from "@convergers-ai/shared-types";
import { classifyByRules, classifyRequest, type Classification, type TaskType } from "./classifier";
import { route, routeStream, type RouteUsageContext, type StageEvent } from "./router";
import { detectAndRedact, isSensitiveFilterEnabled, restoreSensitiveData } from "./privacy/sensitiveFilter.service";
import type { BrainRequest } from "./adapters/types";
import { getSpendable } from "../ledger/spend.service";
import { INSUFFICIENT_CREDITS_CODE, RequestStoppedError, UserFacingError } from "./router/errors";
import { linkCitations, researchNote, searchWeb } from "./search/webSearch";
import { Tally, type ChatResult, type MultiCallbacks } from "./multi/types";
import { runCompare, runCouncil } from "./multi/council";
import { runDeepResearch } from "./multi/deepResearch";
import { crossCheck } from "./multi/crossCheck";

export type { StageEvent, RouteUsageContext, ChatResult };
export { isSensitiveFilterEnabled };
export { userFacingPayload, INSUFFICIENT_CREDITS_CODE, RequestStoppedError } from "./router/errors";

// Every charge is at least 1 credit (see ledger creditsForCost).
const MIN_CREDITS_TO_START = 1;

/**
 * Refuses to start a request the account can't pay for — from its own wallet or,
 * for org members, the shared pool within their monthly limit. getBalance applies
 * any due recurring grant first, so a refill that's due is never blocked.
 */
export async function assertHasCredits(accountId: string): Promise<void> {
  const spendable = await getSpendable(accountId);
  if (spendable.balance >= MIN_CREDITS_TO_START) return;

  let message = "You're out of credits. Buy more credits or upgrade your plan to keep chatting.";
  if (spendable.context.kind === "org") {
    message =
      spendable.limitedBy === "member_limit"
        ? `You've reached your monthly credit limit in ${spendable.context.orgName}. Ask an admin to raise it.`
        : `${spendable.context.orgName} is out of shared credits. Ask an admin to top up.`;
  }
  throw new UserFacingError(message, { code: INSUFFICIENT_CREDITS_CODE });
}

// Without this, models tend to refuse or lecture about the (already masked)
// value, or mangle the placeholder so it can't be restored. Sent as part of
// the system prompt, never the user's turn — otherwise models answer the
// note itself. Deliberately no literal "[REDACT_1]" here — restore would
// rewrite it if echoed back.
const REDACTION_NOTE =
  "Privacy: some values in this conversation were replaced with placeholders of the form [REDACT_n] " +
  "before reaching you. They stand for real values the user provided and are swapped back automatically " +
  "in your reply. Write a placeholder exactly as-is wherever you would use its value. Don't mention the " +
  "masking, and don't bring up those values unless the user's latest message is about them.";

/** Public requests can't set Brain-internal fields (e.g. inject a system note). */
function sanitize(request: RouteRequest): RouteRequest {
  const {
    systemNote: _note,
    enableArtifacts: _artifacts,
    maxOutputTokens: _max,
    effort: _effort,
    ...clean
  } = request as BrainRequest;
  return clean;
}

/** The request with the classifier's effort attached, for the adapters' reasoning controls. */
function withEffort(request: BrainRequest, classification: Classification): BrainRequest {
  return { ...request, effort: classification.effort };
}

/** Internal options for the chat entry point (never settable by the request body). */
export type ChatOptions = {
  artifacts?: boolean;
  /** Aborting stops the model mid-answer; the partial answer comes back marked `stopped`. */
  signal?: AbortSignal;
  /** Omitted = "standard" (one routed model). */
  mode?: ChatMode;
  /** Omitted = "auto": search the web for research questions only. */
  webSearch?: WebSearchSetting;
  /** Compare: models the user picked (the rest are chosen automatically). */
  compareProviderIds?: string[];
  /** The account's custom instructions (personalization_settings), added to every model's system prompt. */
  customInstructions?: string | null;
};

/** Adds what was masked to the usage context, so the usage event records it (counts only). */
function withRedaction(
  ctx: RouteUsageContext | undefined,
  typeCounts: Record<string, number>
): RouteUsageContext {
  const count = Object.values(typeCounts).reduce((sum, n) => sum + n, 0);
  return count > 0 ? { ...ctx, redaction: { count, types: Object.keys(typeCounts) } } : { ...ctx };
}

function customNote(instructions: string): string {
  return `The user's custom instructions — follow them unless their latest message says otherwise:\n"""\n${instructions}\n"""`;
}

function joinNotes(...notes: (string | null | undefined)[]): string | undefined {
  const parts = notes.filter((n): n is string => Boolean(n));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

type Prepared = { request: BrainRequest; map: Map<string, string>; typeCounts: Record<string, number> };

/**
 * Adds the custom instructions to the system note and, with the sensitive
 * data filter on, redacts the input, every history turn and the custom
 * instructions with one shared placeholder map.
 */
function prepareRequest(request: BrainRequest, customInstructions: string | null, filter: boolean): Prepared {
  if (!filter) {
    return {
      request: customInstructions ? { ...request, systemNote: customNote(customInstructions) } : request,
      map: new Map(),
      typeCounts: {},
    };
  }
  const history = request.history ?? [];
  const redaction = detectAndRedact([
    request.input,
    ...history.map((turn) => turn.content),
    ...(customInstructions ? [customInstructions] : []),
  ]);
  const [redactedInput, ...rest] = redaction.redactedTexts as [string, ...string[]];
  const redactedHistory = rest.slice(0, history.length);
  const redactedCustom = customInstructions ? (rest[history.length] as string) : null;
  const systemNote = joinNotes(
    redactedCustom ? customNote(redactedCustom) : null,
    redaction.map.size > 0 ? REDACTION_NOTE : null
  );
  return {
    request: {
      ...request,
      input: redactedInput,
      ...(systemNote ? { systemNote } : {}),
      ...(request.history
        ? { history: history.map((turn, i) => ({ ...turn, content: redactedHistory[i] as string })) }
        : {}),
    },
    map: redaction.map,
    typeCounts: redaction.typeCounts,
  };
}

export async function handleRequest(
  rawRequest: RouteRequest,
  accountId: string,
  ctx?: RouteUsageContext
): Promise<RouteResponse> {
  await assertHasCredits(accountId);
  const request = sanitize(rawRequest);
  if (!(await isSensitiveFilterEnabled(accountId))) {
    const classification = await classifyRequest(request);
    return route(withEffort(request, classification), classification.taskType, accountId, ctx);
  }

  const redaction = prepareRequest(request, null, true);
  const redactedRequest = redaction.request;
  const classification = await classifyRequest(redactedRequest);
  const result = await route(
    withEffort(redactedRequest, classification),
    classification.taskType,
    accountId,
    withRedaction(ctx, redaction.typeCounts)
  );
  return { ...result, content: restoreSensitiveData(result.content, redaction.map) };
}

/** Text answers web research can inform (not images, voice or video). */
const SEARCHABLE: ReadonlySet<TaskType> = new Set<TaskType>([
  "text",
  "research",
  "plan",
  "math",
  "reasoning",
  "writing",
  "translation",
  "code",
  "artifact",
]);

function shouldSearch(setting: WebSearchSetting, taskType: TaskType, mode: ChatMode): boolean {
  // Deep research runs its own searches.
  if (mode === "deep_research" || setting === "off" || !SEARCHABLE.has(taskType)) return false;
  return setting === "on" || taskType === "research";
}

/** The last couple of turns, briefly — so a follow-up ("and in 2024?") searches for the right thing. */
function recentContext(history: BrainRequest["history"]): string | undefined {
  const recent = (history ?? []).slice(-2);
  if (recent.length === 0) return undefined;
  return recent.map((t) => `${t.role}: ${t.content.length > 400 ? `${t.content.slice(0, 400)}…` : t.content}`).join("\n");
}

/** Swaps placeholders back (and links citations) in every part of the answer the user sees. */
function finishContent(
  result: ChatResult,
  transform: (text: string) => string
): ChatResult {
  const metadata = result.metadata;
  const fix = (answers?: MemberAnswer[]) =>
    answers?.map((a) => ({ ...a, content: transform(a.content), ...(a.revised ? { revised: transform(a.revised) } : {}) }));
  return {
    ...result,
    content: transform(result.content),
    ...(metadata
      ? {
          metadata: {
            ...metadata,
            ...(metadata.members ? { members: fix(metadata.members) } : {}),
            ...(metadata.candidates ? { candidates: fix(metadata.candidates) } : {}),
          },
        }
      : {}),
  };
}

/**
 * The chat entry point: one routed model ("standard"), or a council, debate,
 * compare or deep research run — each optionally grounded in web search —
 * with the user's custom instructions and the sensitive-data filter applied
 * to every model call.
 */
export async function handleStreamRequest(
  rawRequest: RouteRequest,
  accountId: string,
  onDelta: (text: string) => void,
  onStage?: (event: StageEvent) => void,
  ctx?: RouteUsageContext,
  options: ChatOptions = {}
): Promise<ChatResult> {
  await assertHasCredits(accountId);
  const mode = options.mode ?? "standard";
  const base: BrainRequest = { ...sanitize(rawRequest), ...(options.artifacts ? { enableArtifacts: true } : {}) };
  const filter = await isSensitiveFilterEnabled(accountId);
  if (filter) onStage?.({ stage: "redact" });
  const prepared = prepareRequest(base, options.customInstructions ?? null, filter);
  const usageCtx = filter ? withRedaction(ctx, prepared.typeCounts) : ctx;

  // With the filter on, streamed chunks still hold placeholders — the client
  // gets one "delta" with the complete, restored answer at the end instead.
  const visibleDelta = filter ? () => {} : onDelta;

  const classification: Classification =
    mode === "deep_research"
      ? { taskType: "research", method: "hint", effort: "deep" }
      : await classifyRequest(prepared.request);
  const { taskType, method, effort } = classification;
  onStage?.({ stage: "classify", taskType, method, effort });

  let request = withEffort(prepared.request, classification);
  const tally = new Tally();
  let sources: AnswerSource[] = [];

  if (shouldSearch(options.webSearch ?? "auto", taskType, mode)) {
    const query = request.input.length > 200 ? `${request.input.slice(0, 199)}…` : request.input;
    onStage?.({ stage: "search", status: "start", query });
    try {
      const research = await searchWeb(request.input, accountId, {
        context: recentContext(request.history),
        conversationId: usageCtx?.conversationId,
        signal: options.signal,
      });
      tally.add({
        credits: research.creditsCharged,
        inputTokens: research.inputTokens,
        outputTokens: research.outputTokens,
        nativeCost: research.nativeCost,
        usageEventId: research.usageEventId,
      });
      sources = research.sources;
      request = { ...request, systemNote: joinNotes(request.systemNote, researchNote(research.notes, research.sources)) };
      onStage?.({ stage: "search", status: "done", query, sources: sources.length });
    } catch (err) {
      if (options.signal?.aborted) throw new RequestStoppedError();
      console.warn("[brain] web search failed — answering without it:", err instanceof Error ? err.message : err);
      onStage?.({ stage: "search", status: "failed", query });
    }
  }

  const cb: MultiCallbacks = { onDelta: visibleDelta, onStage, ctx: usageCtx, signal: options.signal };
  let result: ChatResult;
  switch (mode) {
    case "council":
    case "debate":
      result = await runCouncil(request, taskType, accountId, mode, cb, tally);
      break;
    case "compare":
      result = await runCompare(request, taskType, accountId, options.compareProviderIds ?? [], cb, tally);
      break;
    case "deep_research":
      result = await runDeepResearch(request, accountId, cb, tally);
      break;
    default: {
      const single = await routeStream(request, taskType, accountId, visibleDelta, onStage, usageCtx, options.signal);
      tally.addResponse(single);
      // Tokens shown are the answer's; credits include the search that informed it.
      result = {
        ...single,
        credits_charged: tally.credits,
        native_cost: tally.nativeCost,
        usageEventIds: tally.usageEventIds,
      };
    }
  }

  if (sources.length > 0) {
    result = finishContent(
      { ...result, metadata: { ...result.metadata, sources } },
      (text) => linkCitations(text, sources)
    );
  }
  if (filter) {
    result = finishContent(result, (text) => restoreSensitiveData(text, prepared.map));
    onDelta(result.content);
  }
  return result;
}

/**
 * Cross-checks a saved answer with a model from another family. The
 * question, answer and history go through the sensitive-data filter like
 * any other request.
 */
export async function handleCrossCheck(input: {
  question: string;
  answer: string;
  answerProvider: string | null;
  /** Other models that answered (compare / council / debate) — the checker is none of them. */
  otherProviders?: string[];
  history: { role: "user" | "assistant"; content: string }[];
  accountId: string;
  customInstructions?: string | null;
  conversationId?: string | null;
}): Promise<{ crosscheck: CrossCheck; usageEventId: string | null }> {
  await assertHasCredits(input.accountId);
  const taskType = classifyByRules({ input: input.question }) ?? "text";
  if (!SEARCHABLE.has(taskType)) {
    throw new UserFacingError("Only text answers can be cross-checked.");
  }
  const filter = await isSensitiveFilterEnabled(input.accountId);
  const custom = input.customInstructions ?? null;
  let question = input.question;
  let answer = input.answer;
  let history = input.history;
  let systemNote = custom ? customNote(custom) : undefined;
  let map = new Map<string, string>();
  let ctx: RouteUsageContext = { conversationId: input.conversationId ?? null };
  if (filter) {
    const redaction = detectAndRedact([question, answer, ...history.map((t) => t.content), ...(custom ? [custom] : [])]);
    const texts = redaction.redactedTexts;
    question = texts[0] as string;
    answer = texts[1] as string;
    history = history.map((t, i) => ({ ...t, content: texts[2 + i] as string }));
    const redactedCustom = custom ? (texts[2 + history.length] as string) : null;
    systemNote = joinNotes(redactedCustom ? customNote(redactedCustom) : null, redaction.map.size > 0 ? REDACTION_NOTE : null);
    map = redaction.map;
    ctx = withRedaction(ctx, redaction.typeCounts);
  }
  const { crosscheck: checked, usageEventId } = await crossCheck({
    question,
    answer,
    answerProvider: input.answerProvider,
    ...(input.otherProviders?.length ? { otherProviders: input.otherProviders } : {}),
    history,
    taskType,
    accountId: input.accountId,
    ...(systemNote ? { systemNote } : {}),
    ctx,
  });
  return {
    crosscheck: {
      ...checked,
      content: filter ? restoreSensitiveData(checked.content, map) : checked.content,
      createdAt: new Date().toISOString(),
    },
    usageEventId,
  };
}
