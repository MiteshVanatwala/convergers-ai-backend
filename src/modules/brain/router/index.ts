import type { QueryResult } from "pg";
import type { RouteRequest, RouteResponse } from "@convergers-ai/shared-types";
import type { ClassificationMethod, TaskType } from "../classifier";
import type { ProviderAdapter, ProviderResponse } from "../adapters/types";
import { haikuAdapter, sonnetAdapter, opusAdapter } from "../adapters/anthropic";
import { openaiImageAdapter } from "../adapters/openai";
import {
  geminiFlashImageAdapter,
  geminiFlashLiteImageAdapter,
  geminiProImageAdapter,
} from "../adapters/geminiImage";
import { claudeImageAdapter } from "../adapters/claudeImage";
import { deepseekFlashAdapter, deepseekProAdapter } from "../adapters/deepseek";
import { glmAdapter, glmFlashAdapter } from "../adapters/glm";
import { kimiAdapter, kimiCodeAdapter } from "../adapters/kimi";
import { qwenAdapter } from "../adapters/qwen";
import { gptOssAdapter, gptOss20bAdapter } from "../adapters/gptOss";
import { geminiFlashAdapter, geminiFlashLiteAdapter, geminiProAdapter } from "../adapters/gemini";
import { xaiAdapter, grok43Adapter } from "../adapters/xai";
import { openrouterAdapter } from "../adapters/openrouter";
import { normalize } from "../normalizer";
import { creditsForCost } from "../../ledger/ledger.service";
import { getPool } from "../../../infrastructure/db/pool";
import * as usageLog from "../usageLog";
import * as usageService from "../../usage/usage.service";
import {
  RequestStoppedError,
  UserFacingError,
  classifyModelFailure,
  describeProviderFailure,
  isCapacityError,
  isServerSideSetupError,
} from "./errors";
import { recordModelFailure, recordModelSuccess } from "../modelHealth";
import { recordModelCallFailure } from "../callFailures";
import { TEST_MODE_MAX_USD, cheapestFirst, isTestModeAccount, typicalRequestUsd } from "./testMode";
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
  [geminiFlashImageAdapter.id]: geminiFlashImageAdapter,
  [geminiProImageAdapter.id]: geminiProImageAdapter,
  [geminiFlashLiteImageAdapter.id]: geminiFlashLiteImageAdapter,
  [claudeImageAdapter.id]: claudeImageAdapter,
  [deepseekFlashAdapter.id]: deepseekFlashAdapter,
  [deepseekProAdapter.id]: deepseekProAdapter,
  [glmAdapter.id]: glmAdapter,
  [glmFlashAdapter.id]: glmFlashAdapter,
  [kimiAdapter.id]: kimiAdapter,
  [kimiCodeAdapter.id]: kimiCodeAdapter,
  [qwenAdapter.id]: qwenAdapter,
  [gptOssAdapter.id]: gptOssAdapter,
  [gptOss20bAdapter.id]: gptOss20bAdapter,
  [geminiFlashAdapter.id]: geminiFlashAdapter,
  [geminiFlashLiteAdapter.id]: geminiFlashLiteAdapter,
  [geminiProAdapter.id]: geminiProAdapter,
  [xaiAdapter.id]: xaiAdapter,
  [grok43Adapter.id]: grok43Adapter,
  [openrouterAdapter.id]: openrouterAdapter,
};

const TASK_TYPES: TaskType[] = ["text", "code", "image", "voice", "video", "research", "plan", "artifact"];

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
/** The task type's configured chain, in admin order (read-only snapshot). */
export function currentChain(taskType: TaskType): readonly ProviderAdapter[] {
  return hierarchy[taskType];
}

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
  | { stage: "route"; provider: string; attempt: number; pick: "explicit" | "auto" | "test" }
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

/**
 * `narrowed`: some models were skipped because they can't do this request
 * (e.g. a GIF on a still-image model), so failures should say so.
 */
type RouteChain = {
  chain: ProviderAdapter[];
  explicitPick: boolean;
  narrowed: boolean;
  testMode: boolean;
  /** Test mode left these out for cost (labels), so a failure can say so. */
  skippedForCost: string[];
};

async function resolveRouteChain(
  request: RouteRequest,
  taskType: TaskType,
  accountId: string,
  ctx?: RouteUsageContext
): Promise<RouteChain> {
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
      narrowed: false,
      testMode: false,
      skippedForCost: [],
    };
  }

  // Test mode: cheapest model first, for accounts an admin flagged for testing.
  const testMode = await isTestModeAccount(accountId);
  const ranked = await resolveChain(taskType, accountId, ctx);
  const fullChain = testMode ? cheapestFirst(ranked) : ranked;
  // Skip models that can't do this particular request (e.g. animation on a
  // still-image model) — unless none can, then let the chain try anyway.
  const capable = fullChain.filter((a) => !a.canHandle || a.canHandle(request));
  const usable = capable.length > 0 ? capable : fullChain;
  const narrowed = capable.length > 0 && capable.length < fullChain.length;
  // Test mode also leaves out pricey models, unless they're all that can do it (e.g. GIFs).
  const affordable = testMode ? usable.filter((a) => typicalRequestUsd(a) <= TEST_MODE_MAX_USD) : usable;
  const chain = affordable.length > 0 ? affordable : usable;
  const skippedForCost = usable.filter((a) => !chain.includes(a)).map((a) => labelFor(a.id));
  if (!allowed) return { chain, explicitPick: false, narrowed, testMode, skippedForCost };

  // Org admins restricted the models — only route among the allowed ones.
  const permitted = chain.filter((a) => allowed.has(a.id));
  if (permitted.length === 0) {
    await persistError(accountId, taskType, "org_policy", ctx);
    throw new UserFacingError(
      `None of the models allowed in ${policy?.orgName} can handle this kind of request (${taskType}). ` +
        `Ask an admin to allow more models.`
    );
  }
  return { chain: permitted, explicitPick: false, narrowed, testMode, skippedForCost };
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
  {
    explicitPick = false,
    narrowed = false,
    skippedForCost = [],
    signal,
  }: { explicitPick?: boolean; narrowed?: boolean; skippedForCost?: string[]; signal?: AbortSignal } = {}
): Promise<RouteResponse> {
  let firstError: unknown;
  let lastError: unknown;
  let firstByok = false;
  let lastByok = false;
  const errors: unknown[] = [];
  let lastIndex = 0;
  for (let i = 0; i < chain.length; i++) {
    // Stopped before this option was called — nothing was generated or spent.
    if (signal?.aborted) throw new RequestStoppedError();
    lastIndex = i;
    // Set once the provider is actually called, for the admin model-status board.
    let callStartedAt: number | null = null;
    let byok = false;
    try {
      // Priced before it's announced, so an option skipped for credits never
      // shows up as "Sending to …" in the client's routing timeline.
      const plan = await planAttempt(chain[i], request, accountId, labelFor(chain[i].id));
      await onAttempt?.(chain[i], i);
      byok = plan.byok;
      callStartedAt = Date.now();
      const response = await attempt(chain[i], plan.request);
      // A stopped stream says nothing about the model's health either way.
      if (!response.stopped) recordModelSuccess(chain[i].id, Date.now() - callStartedAt);
      // A billing error after this point isn't the model's fault.
      callStartedAt = null;
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
      // The provider failed only because the caller went away — don't blame it or fall back.
      if (signal?.aborted) throw new RequestStoppedError();
      if (i === 0) {
        firstError = err;
        firstByok = byok;
      }
      lastError = err;
      lastByok = byok;
      errors.push(err);
      // Only failures of the provider call itself, on our key — a user's own (BYOK)
      // key being rejected says nothing about the model's health.
      if (callStartedAt != null && !byok) {
        const failure = classifyModelFailure(err);
        if (failure) {
          recordModelFailure(chain[i].id, Date.now() - callStartedAt, failure.kind, failure.status);
          recordModelCallFailure({
            providerId: chain[i].id,
            taskType,
            accountId,
            kind: failure.kind,
            status: failure.status,
            error: err,
          });
        }
      }
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
  throw chainFailure(chain, lastIndex, {
    explicitPick,
    narrowed,
    skippedForCost,
    taskType,
    firstError,
    firstByok,
    lastError,
    lastByok,
    errors,
  });
}

/** The one user-safe error to surface once every option in the chain has failed. */
function chainFailure(
  chain: ProviderAdapter[],
  lastIndex: number,
  f: {
    explicitPick: boolean;
    narrowed: boolean;
    skippedForCost: string[];
    taskType: TaskType;
    firstError: unknown;
    firstByok: boolean;
    lastError: unknown;
    lastByok: boolean;
    errors: unknown[];
  }
): UserFacingError {
  const first = chain[0];
  if (!first) return describeProviderFailure(f.lastError, "The model");

  if (f.explicitPick) {
    const label = labelFor(first.id);
    if (lastIndex > 0) {
      return new UserFacingError(
        `${label} is at its usage limit right now, and no other model could take over. ` +
          `Please try again in a minute.`,
        { cause: f.lastError }
      );
    }
    return describeProviderFailure(f.firstError, label, f.firstByok);
  }

  const failure = chainFailureMessage(chain, lastIndex, f);
  if (f.skippedForCost.length === 0) return failure;
  return new UserFacingError(
    `${failure.message} (Test mode skipped ${f.skippedForCost.join(", ")} to save cost — pick it from the model menu to use it.)`,
    { cause: f.lastError, code: failure.code }
  );
}

/** Auto-routing failure message (chainFailure adds the test-mode note). */
function chainFailureMessage(
  chain: ProviderAdapter[],
  lastIndex: number,
  f: Parameters<typeof chainFailure>[2]
): UserFacingError {
  // Only some models can do this (e.g. GIFs) and they all failed — say why
  // nothing else was tried.
  const onlyOption = f.narrowed
    ? ` ${chain.length === 1 ? "It's the only model here" : "These are the only models here"} that can make ` +
      `GIFs and animations, so please try again later.`
    : "";

  if (chain.length === 1) {
    const label = labelFor(chain[lastIndex]!.id);
    if (f.narrowed && !f.lastByok && isServerSideSetupError(f.lastError)) {
      return new UserFacingError(
        `${label} is unavailable right now because of a problem on our side — nothing to do with your request.${onlyOption}`,
        { cause: f.lastError }
      );
    }
    return describeProviderFailure(f.lastError, label, f.lastByok);
  }
  if (f.lastError instanceof UserFacingError) return f.lastError;

  // Every option was down on our side (no credit, blocked, bad or missing key) — not the request.
  if (f.errors.length > 0 && f.errors.every(isServerSideSetupError)) {
    const what = f.taskType === "image" ? "Image generation" : "This kind of request";
    return new UserFacingError(
      `${what} is unavailable right now: every model that can handle it is offline on our side ` +
        `(provider account or setup issue). This isn't caused by your request — please try again later.${onlyOption}`,
      { cause: f.lastError }
    );
  }
  return new UserFacingError(
    `None of the available models could answer right now. Please try again shortly.${onlyOption}`,
    { cause: f.lastError }
  );
}

export async function route(
  request: RouteRequest,
  taskType: TaskType,
  accountId: string,
  ctx?: RouteUsageContext
): Promise<RouteResponse> {
  const { chain, explicitPick, narrowed, skippedForCost } = await resolveRouteChain(request, taskType, accountId, ctx);
  return walkChain(
    chain,
    request,
    accountId,
    taskType,
    (adapter, planned) => adapter.call(planned, accountId),
    undefined,
    ctx,
    { explicitPick, narrowed, skippedForCost }
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
  ctx?: RouteUsageContext,
  signal?: AbortSignal
): Promise<RouteResponse> {
  const { chain, explicitPick, narrowed, testMode, skippedForCost } = await resolveRouteChain(
    request,
    taskType,
    accountId,
    ctx
  );
  return walkChain(
    chain,
    request,
    accountId,
    taskType,
    (adapter, planned) =>
      adapter.streamCall(
        planned,
        onDelta,
        accountId,
        (inputTokens) => {
          onStage?.({ stage: "generating", provider: adapter.id, inputTokens });
        },
        signal
      ),
    (adapter, attemptIndex) => {
      onStage?.({
        stage: "route",
        provider: adapter.id,
        attempt: attemptIndex,
        pick: explicitPick ? "explicit" : testMode ? "test" : "auto",
      });
    },
    ctx,
    { explicitPick, narrowed, skippedForCost, signal }
  );
}
