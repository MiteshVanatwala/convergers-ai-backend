import type { RouteRequest, RouteResponse } from "@convergers-ai/shared-types";
import type { TaskType } from "../classifier";
import type { ProviderAdapter, ProviderResponse } from "../adapters/types";
import { haikuAdapter, sonnetAdapter } from "../adapters/anthropic";
import { openaiImageAdapter } from "../adapters/openai";
import { normalize } from "../normalizer";
import { creditsForCost } from "../../ledger/ledger.service";
import * as usageLog from "../usageLog";
import * as usageService from "../../usage/usage.service";

/**
 * The hierarchy: every task type maps to a ranked list of model options.
 * The router walks each list top to bottom (see `walkChain`) and uses the
 * first one that actually works — same mechanism whether "doesn't work"
 * means "no API key configured" or "the provider's API call failed", so
 * adding a real second/third option to any list is enough to get automatic
 * fallback for that task type. Per the technical plan §04.
 *
 * POC note: Anthropic (text-only) and OpenAI's gpt-image-1 (image-only) are
 * the only providers with adapters written so far — most lists below only
 * have one viable entry as a result. That's a coverage gap, not a design
 * one: a second provider for any task type is just another entry in its
 * list, in ranked order, via a new file in ../adapters/ implementing the
 * same ProviderAdapter interface.
 */
const HIERARCHY: Record<TaskType, ProviderAdapter[]> = {
  text: [haikuAdapter, sonnetAdapter],
  code: [sonnetAdapter],
  research: [sonnetAdapter],
  plan: [sonnetAdapter],
  image: [openaiImageAdapter],
  voice: [],
  video: [],
};

/** Live progress events for the streaming path — lets a client know the actual routing decision as it happens. */
export type StageEvent = { stage: "classify"; taskType: TaskType } | { stage: "route"; provider: string; attempt: number };

/** Optional chat context so usage_events can store conversation_id. */
export type RouteUsageContext = {
  conversationId?: string | null;
};

const emptyUsage = { inputTokens: 0, outputTokens: 0, nativeCost: 0, creditsCharged: 0, fallbackUsed: false };

async function persistError(
  accountId: string,
  taskType: TaskType,
  provider: string,
  ctx?: RouteUsageContext
): Promise<void> {
  usageLog.record({ accountId, taskType, provider, outcome: "error", ...emptyUsage });
  try {
    await usageService.recordErrorEvent({
      accountId,
      conversationId: ctx?.conversationId,
      taskType,
      provider,
    });
  } catch (error: unknown) {
    // Durable write failed — in-memory log still has the event for this process.
    console.error("[router] usage_events error insert failed", error);
  }
}

/** Resolves a task type's hierarchy, logging (and rethrowing) if none is configured for it. */
async function resolveChain(
  taskType: TaskType,
  accountId: string,
  ctx?: RouteUsageContext
): Promise<ProviderAdapter[]> {
  const chain = HIERARCHY[taskType];
  if (chain.length === 0) {
    await persistError(accountId, taskType, "unconfigured", ctx);
    throw new Error(
      `This was classified as "${taskType}", but no provider is wired up for that yet in this POC ` +
        `(only text/code/research/plan route to Anthropic, image routes to OpenAI). Add a "${taskType}" ` +
        `adapter and list it in backend/src/brain/router/index.ts to support it.`
    );
  }
  return chain;
}

/**
 * Walks a task type's hierarchy top to bottom, calling `attempt` for each
 * option in turn and billing the account once one succeeds. An option can
 * fail for two different reasons that both just mean "try the next one":
 * its adapter isn't configured (missing API key — fails immediately, before
 * any network call), or its provider's API call itself failed. Every
 * outcome — success or final exhaustion — is logged to usageLog + usage_events.
 */
async function walkChain(
  chain: ProviderAdapter[],
  accountId: string,
  taskType: TaskType,
  attempt: (adapter: ProviderAdapter) => Promise<ProviderResponse>,
  onAttempt?: (adapter: ProviderAdapter, attemptIndex: number) => void | Promise<void>,
  ctx?: RouteUsageContext
): Promise<RouteResponse> {
  let lastError: unknown;
  for (let i = 0; i < chain.length; i++) {
    await onAttempt?.(chain[i], i);
    try {
      const response = await attempt(chain[i]);
      const credits = creditsForCost(response.native_cost);
      const { charged, usageEventId } = await usageService.recordSuccessAndDebit({
        accountId,
        conversationId: ctx?.conversationId,
        taskType,
        provider: chain[i].id,
        tokensInput: response.usage.input_tokens,
        tokensOutput: response.usage.output_tokens,
        nativeCost: response.native_cost,
        creditsRequested: credits,
        fallbackUsed: i > 0,
      });
      usageLog.record({
        accountId,
        taskType,
        provider: chain[i].id,
        outcome: "success",
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        nativeCost: response.native_cost,
        creditsCharged: charged,
        fallbackUsed: i > 0,
      });
      return normalize(chain[i].id, response, {
        creditsCharged: charged,
        fallbackUsed: i > 0,
        usageEventId,
      });
    } catch (err) {
      lastError = err;
    }
  }
  await persistError(
    accountId,
    taskType,
    chain[chain.length - 1]?.id ?? "unconfigured",
    ctx
  );
  throw lastError;
}

export async function route(
  request: RouteRequest,
  taskType: TaskType,
  accountId: string,
  ctx?: RouteUsageContext
): Promise<RouteResponse> {
  const chain = await resolveChain(taskType, accountId, ctx);
  return walkChain(chain, accountId, taskType, (adapter) => adapter.call(request), undefined, ctx);
}

/**
 * Streaming counterpart to `route` — `onDelta` fires with each text chunk,
 * `onStage` fires as the routing decision is made (see StageEvent).
 * POC simplification: if an adapter fails mid-stream after already emitting
 * text, the client sees a partial answer follow by the fallback's full
 * answer. In practice this only matters for connection-time failures (bad
 * key, network), which happen before any text is emitted.
 */
export async function routeStream(
  request: RouteRequest,
  taskType: TaskType,
  accountId: string,
  onDelta: (text: string) => void,
  onStage?: (event: StageEvent) => void,
  ctx?: RouteUsageContext
): Promise<RouteResponse> {
  const chain = await resolveChain(taskType, accountId, ctx);
  return walkChain(
    chain,
    accountId,
    taskType,
    (adapter) => adapter.streamCall(request, onDelta),
    (adapter, attemptIndex) => {
      onStage?.({ stage: "route", provider: adapter.id, attempt: attemptIndex });
    },
    ctx
  );
}
