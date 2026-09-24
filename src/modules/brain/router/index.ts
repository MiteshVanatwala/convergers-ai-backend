import type { QueryResult } from "pg";
import type { RouteRequest, RouteResponse } from "@convergers-ai/shared-types";
import type { TaskType } from "../classifier";
import type { ProviderAdapter, ProviderResponse } from "../adapters/types";
import { haikuAdapter, sonnetAdapter, opusAdapter } from "../adapters/anthropic";
import { openaiImageAdapter } from "../adapters/openai";
import { deepseekFlashAdapter, deepseekProAdapter } from "../adapters/deepseek";
import { glmAdapter, glmAirAdapter } from "../adapters/glm";
import { kimiAdapter } from "../adapters/kimi";
import { qwenAdapter } from "../adapters/qwen";
import { gptOssAdapter } from "../adapters/gptOss";
import { geminiFlashAdapter, geminiProAdapter } from "../adapters/gemini";
import { mistralLargeAdapter, mistralSmallAdapter } from "../adapters/mistral";
import { xaiAdapter, grok43Adapter } from "../adapters/xai";
import { openrouterAdapter } from "../adapters/openrouter";
import { normalize } from "../normalizer";
import { creditsForCost } from "../../ledger/ledger.service";
import { getPool } from "../../../infrastructure/db/pool";
import * as usageLog from "../usageLog";
import * as usageService from "../../usage/usage.service";

/**
 * Every known adapter, keyed by the exact id used as `provider_registry.id`
 * in the DB. This is the one place that still needs a code change when a
 * genuinely new provider is added (per the stated scope — DB config only
 * reorders/enables *these* adapters, it doesn't invent new ones).
 */
const ADAPTER_LOOKUP: Record<string, ProviderAdapter> = {
  [haikuAdapter.id]: haikuAdapter,
  [sonnetAdapter.id]: sonnetAdapter,
  [opusAdapter.id]: opusAdapter,
  [openaiImageAdapter.id]: openaiImageAdapter,
  [deepseekFlashAdapter.id]: deepseekFlashAdapter,
  [deepseekProAdapter.id]: deepseekProAdapter,
  [glmAdapter.id]: glmAdapter,
  [glmAirAdapter.id]: glmAirAdapter,
  [kimiAdapter.id]: kimiAdapter,
  [qwenAdapter.id]: qwenAdapter,
  [gptOssAdapter.id]: gptOssAdapter,
  [geminiFlashAdapter.id]: geminiFlashAdapter,
  [geminiProAdapter.id]: geminiProAdapter,
  [mistralLargeAdapter.id]: mistralLargeAdapter,
  [mistralSmallAdapter.id]: mistralSmallAdapter,
  [xaiAdapter.id]: xaiAdapter,
  [grok43Adapter.id]: grok43Adapter,
  [openrouterAdapter.id]: openrouterAdapter,
};

const TASK_TYPES: TaskType[] = ["text", "code", "image", "voice", "video", "research", "plan"];

function emptyHierarchy(): Record<TaskType, ProviderAdapter[]> {
  const hierarchy = {} as Record<TaskType, ProviderAdapter[]>;
  for (const taskType of TASK_TYPES) hierarchy[taskType] = [];
  return hierarchy;
}

/**
 * The hierarchy: every task type maps to a ranked list of model options.
 * The router walks each list top to bottom (see `walkChain`) and uses the
 * first one that actually works — same mechanism whether "doesn't work"
 * means "no API key configured" or "the provider's API call failed", so a
 * real second/third option in any list is enough to get automatic fallback
 * for that task type.
 *
 * DB-driven via `provider_routing_rules` (admin-configurable — see
 * `admin-providers.service.ts`), not hardcoded. Held in memory and rebuilt
 * by `reloadHierarchy()` — called once at boot and again after every admin
 * write — rather than queried per-request, since this is read on every
 * single chat message.
 */
let hierarchy: Record<TaskType, ProviderAdapter[]> = emptyHierarchy();

/**
 * Models an explicit user pick is allowed to target — kept in sync with
 * `reloadHierarchy()` for the same reason (no DB round-trip on the request
 * hot path). Independent of `hierarchy`: a model can be visible here without
 * being part of any task type's automatic chain, or vice versa.
 */
let visibleProviderIds = new Set<string>();

type RoutingRow = { task_type: string; provider_id: string };

/** Rebuilds the in-memory hierarchy + visible-model set. Call at boot and after any admin write (routing rules or visibility). */
export async function reloadHierarchy(): Promise<void> {
  const pool = getPool();
  const [routingResult, registryResult]: [QueryResult<RoutingRow>, QueryResult<{ id: string }>] =
    await Promise.all([
      pool.query(
        `SELECT rr.task_type, rr.provider_id
         FROM provider_routing_rules rr
         JOIN provider_registry pr ON pr.id = rr.provider_id
         WHERE rr.enabled = true AND pr.status = 'active'
         ORDER BY rr.task_type, rr.rank ASC`
      ),
      pool.query(
        `SELECT id FROM provider_registry WHERE visible_to_users = true AND status = 'active'`
      ),
    ]);

  const next = emptyHierarchy();
  for (const row of routingResult.rows) {
    if (!TASK_TYPES.includes(row.task_type as TaskType)) continue;
    const adapter = ADAPTER_LOOKUP[row.provider_id];
    if (!adapter) {
      console.warn(
        `[router] provider_routing_rules references unknown provider_id="${row.provider_id}" — skipping`
      );
      continue;
    }
    next[row.task_type as TaskType].push(adapter);
  }
  hierarchy = next;
  visibleProviderIds = new Set(registryResult.rows.map((r) => r.id));
}

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
  const chain = hierarchy[taskType];
  if (chain.length === 0) {
    await persistError(accountId, taskType, "unconfigured", ctx);
    throw new Error(
      `This was classified as "${taskType}", but no enabled provider is configured for it. ` +
        `Enable one for this task type on the admin panel's Providers page.`
    );
  }
  return chain;
}

/**
 * A user explicitly picked a model — single-element chain, no automatic
 * fallback mixed in. If it fails, the caller sees that model's own error,
 * not a silent substitute they didn't ask for.
 */
async function resolveExplicitProvider(
  providerId: string,
  taskType: TaskType,
  accountId: string,
  ctx?: RouteUsageContext
): Promise<ProviderAdapter[]> {
  const adapter = ADAPTER_LOOKUP[providerId];
  if (!adapter || !visibleProviderIds.has(providerId)) {
    await persistError(accountId, taskType, providerId, ctx);
    throw new Error(`"${providerId}" isn't a valid or currently available model.`);
  }
  return [adapter];
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
      console.warn(
        `[router] ${chain[i].id} failed for taskType="${taskType}" — trying next option:`,
        err instanceof Error ? err.message : err
      );
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
  const chain = request.providerId
    ? await resolveExplicitProvider(request.providerId, taskType, accountId, ctx)
    : await resolveChain(taskType, accountId, ctx);
  return walkChain(chain, accountId, taskType, (adapter) => adapter.call(request, accountId), undefined, ctx);
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
  const chain = request.providerId
    ? await resolveExplicitProvider(request.providerId, taskType, accountId, ctx)
    : await resolveChain(taskType, accountId, ctx);
  return walkChain(
    chain,
    accountId,
    taskType,
    (adapter) => adapter.streamCall(request, onDelta, accountId),
    (adapter, attemptIndex) => {
      onStage?.({ stage: "route", provider: adapter.id, attempt: attemptIndex });
    },
    ctx
  );
}
