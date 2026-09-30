import type { QueryResult } from "pg";
import type { RouteRequest, RouteResponse } from "@convergers-ai/shared-types";
import type { ClassificationMethod, TaskType } from "../classifier";
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
import { UserFacingError, describeProviderFailure, isCapacityError } from "./errors";
import { BYOK_FEE_CREDITS, planAttempt } from "./credits";
import { getOrgPolicyForAccount } from "../../orgs/orgs.service";

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

/** provider_registry id -> display label, for user-facing error messages. */
let providerLabels = new Map<string, string>();

function labelFor(providerId: string): string {
  return providerLabels.get(providerId) ?? providerId;
}

type RoutingRow = { task_type: string; provider_id: string };
type RegistryRow = { id: string; label: string | null; visible_to_users: boolean };

/** Rebuilds the in-memory hierarchy + visible-model set. Call at boot and after any admin write (routing rules or visibility). */
export async function reloadHierarchy(): Promise<void> {
  const pool = getPool();
  const [routingResult, registryResult]: [QueryResult<RoutingRow>, QueryResult<RegistryRow>] =
    await Promise.all([
      pool.query(
        `SELECT rr.task_type, rr.provider_id
         FROM provider_routing_rules rr
         JOIN provider_registry pr ON pr.id = rr.provider_id
         WHERE rr.enabled = true AND pr.status = 'active'
         ORDER BY rr.task_type, rr.rank ASC`
      ),
      pool.query(
        `SELECT id, label, visible_to_users FROM provider_registry WHERE status = 'active'`
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
  visibleProviderIds = new Set(
    registryResult.rows.filter((r) => r.visible_to_users).map((r) => r.id)
  );
  providerLabels = new Map(
    registryResult.rows.filter((r) => r.label).map((r) => [r.id, r.label as string])
  );
}

/** Live progress events for the streaming path — lets a client know the actual routing decision as it happens. */
export type StageEvent =
  | { stage: "classify"; taskType: TaskType; method: ClassificationMethod }
  | { stage: "redact" }
  /** `pick`: the user's explicit model choice, or chosen automatically for the task type. */
  | { stage: "route"; provider: string; attempt: number; pick: "explicit" | "auto" }
  | { stage: "generating"; provider: string; inputTokens: number };

/** Optional chat context so usage_events can store conversation_id. */
export type RouteUsageContext = {
  conversationId?: string | null;
  /** What the sensitive-data filter masked in this request — counts and kinds only. */
  redaction?: { count: number; types: string[] };
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
    // Admin-facing detail stays in the log; the user gets a plain explanation.
    console.warn(
      `[router] no enabled provider for taskType="${taskType}" — enable one on the admin panel's Providers page`
    );
    throw new UserFacingError(
      `No model is available for this kind of request (${taskType}) right now. Please try again later.`
    );
  }
  return chain;
}

/**
 * A user explicitly picked a model — it goes first, followed by the task
 * type's automatic chain. `walkChain` only moves past the pick when it hit a
 * rate/capacity limit (see `isCapacityError`); any other failure surfaces the
 * picked model's own error rather than a substitute they didn't ask for.
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
    throw new UserFacingError(`"${labelFor(providerId)}" isn't a valid or currently available model.`);
  }
  return [adapter, ...hierarchy[taskType].filter((a) => a.id !== adapter.id)];
}

async function resolveRouteChain(
  request: RouteRequest,
  taskType: TaskType,
  accountId: string,
  ctx?: RouteUsageContext
): Promise<{ chain: ProviderAdapter[]; explicitPick: boolean }> {
  const policy = await getOrgPolicyForAccount(accountId);
  const allowed = policy?.allowedModelIds ? new Set(policy.allowedModelIds) : null;

  if (request.providerId) {
    if (allowed && !allowed.has(request.providerId)) {
      await persistError(accountId, taskType, request.providerId, ctx);
      throw new UserFacingError(
        `${labelFor(request.providerId)} isn't allowed in ${policy?.orgName}. Pick another model or use Auto.`
      );
    }
    const chain = await resolveExplicitProvider(request.providerId, taskType, accountId, ctx);
    return {
      chain: allowed ? chain.filter((a) => allowed.has(a.id)) : chain,
      explicitPick: true,
    };
  }

  const chain = await resolveChain(taskType, accountId, ctx);
  if (!allowed) return { chain, explicitPick: false };

  // Org admins restricted the models — only route among the allowed ones.
  const permitted = chain.filter((a) => allowed.has(a.id));
  if (permitted.length === 0) {
    await persistError(accountId, taskType, "org_policy", ctx);
    throw new UserFacingError(
      `None of the models allowed in ${policy?.orgName} can handle this kind of request (${taskType}). ` +
        `Ask an admin to allow more models.`
    );
  }
  return { chain: permitted, explicitPick: false };
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
  request: RouteRequest,
  accountId: string,
  taskType: TaskType,
  attempt: (adapter: ProviderAdapter, request: RouteRequest) => Promise<ProviderResponse>,
  onAttempt?: (adapter: ProviderAdapter, attemptIndex: number) => void | Promise<void>,
  ctx?: RouteUsageContext,
  explicitPick = false
): Promise<RouteResponse> {
  let firstError: unknown;
  let lastError: unknown;
  let lastIndex = 0;
  for (let i = 0; i < chain.length; i++) {
    lastIndex = i;
    try {
      // Priced before it's announced, so an option skipped for credits never
      // shows up as "Sending to …" in the client's routing timeline.
      const plan = await planAttempt(chain[i], request, accountId, labelFor(chain[i].id));
      await onAttempt?.(chain[i], i);
      const response = await attempt(chain[i], plan.request);
      const credits = plan.byok ? BYOK_FEE_CREDITS : creditsForCost(response.native_cost);
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
        redactedCount: ctx?.redaction?.count ?? 0,
        redactedTypes: ctx?.redaction?.types ?? null,
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
        truncatedByCredits: plan.cappedByCredits && response.truncated === true,
      });
    } catch (err) {
      if (i === 0) firstError = err;
      lastError = err;
      // An explicit pick only falls back when it was rate/capacity limited.
      const stop = explicitPick && i === 0 && !isCapacityError(err);
      console.warn(
        `[router] ${chain[i].id} failed for taskType="${taskType}"${stop ? " (explicit pick, not falling back)" : " — trying next option"}:`,
        err instanceof Error ? err.message : err
      );
      if (stop) break;
    }
  }
  await persistError(accountId, taskType, chain[lastIndex]?.id ?? "unconfigured", ctx);
  throw chainFailure(chain, explicitPick, lastIndex, firstError, lastError);
}

/** The one user-safe error to surface once every option in the chain has failed. */
function chainFailure(
  chain: ProviderAdapter[],
  explicitPick: boolean,
  lastIndex: number,
  firstError: unknown,
  lastError: unknown
): UserFacingError {
  const first = chain[0];
  if (!first) return describeProviderFailure(lastError, "The model");

  if (explicitPick) {
    const label = labelFor(first.id);
    if (lastIndex > 0) {
      return new UserFacingError(
        `${label} is at its usage limit right now, and no other model could take over. ` +
          `Please try again in a minute.`,
        { cause: lastError }
      );
    }
    return describeProviderFailure(firstError, label);
  }

  if (lastError instanceof UserFacingError) return lastError;
  if (chain.length === 1) return describeProviderFailure(lastError, labelFor(first.id));
  return new UserFacingError(
    "None of the available models could answer right now. Please try again shortly.",
    { cause: lastError }
  );
}

export async function route(
  request: RouteRequest,
  taskType: TaskType,
  accountId: string,
  ctx?: RouteUsageContext
): Promise<RouteResponse> {
  const { chain, explicitPick } = await resolveRouteChain(request, taskType, accountId, ctx);
  return walkChain(
    chain,
    request,
    accountId,
    taskType,
    (adapter, planned) => adapter.call(planned, accountId),
    undefined,
    ctx,
    explicitPick
  );
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
  const { chain, explicitPick } = await resolveRouteChain(request, taskType, accountId, ctx);
  return walkChain(
    chain,
    request,
    accountId,
    taskType,
    (adapter, planned) =>
      adapter.streamCall(planned, onDelta, accountId, (inputTokens) => {
        onStage?.({ stage: "generating", provider: adapter.id, inputTokens });
      }),
    (adapter, attemptIndex) => {
      onStage?.({
        stage: "route",
        provider: adapter.id,
        attempt: attemptIndex,
        pick: explicitPick ? "explicit" : "auto",
      });
    },
    ctx,
    explicitPick
  );
}
