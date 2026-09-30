// The Brain: the only part of the system that knows a specific provider
// exists. Everything outside this module talks to it through the functions
// below — nothing else imports a provider SDK, formats a provider-specific
// prompt, or parses a provider-specific response.
//
// See the technical plan §01 for the full interface contract.

import type { RouteRequest, RouteResponse } from "@convergers-ai/shared-types";
import { classifyRequest } from "./classifier";
import { route, routeStream, type RouteUsageContext, type StageEvent } from "./router";
import { detectAndRedact, isSensitiveFilterEnabled, restoreSensitiveData } from "./privacy/sensitiveFilter.service";
import type { BrainRequest } from "./adapters/types";
import { getBalance } from "../ledger/ledger.service";
import { INSUFFICIENT_CREDITS_CODE, UserFacingError } from "./router/errors";

export type { StageEvent, RouteUsageContext };
export { isSensitiveFilterEnabled };
export { userFacingPayload, INSUFFICIENT_CREDITS_CODE } from "./router/errors";

// Every charge is at least 1 credit (see ledger creditsForCost).
const MIN_CREDITS_TO_START = 1;

/**
 * Refuses to start a request the account can't pay for. getBalance applies
 * any due recurring grant first, so a refill that's due is never blocked.
 */
export async function assertHasCredits(accountId: string): Promise<void> {
  const balance = await getBalance(accountId);
  if (balance < MIN_CREDITS_TO_START) {
    throw new UserFacingError(
      "You're out of credits. Buy more credits or upgrade your plan to keep chatting.",
      { code: INSUFFICIENT_CREDITS_CODE }
    );
  }
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
  const { systemNote: _ignored, ...clean } = request as BrainRequest;
  return clean;
}

/** Redacts the current input and every history turn with one shared placeholder map. */
function redactRequest(request: RouteRequest): { request: BrainRequest; map: Map<string, string> } {
  const history = request.history ?? [];
  const redaction = detectAndRedact([request.input, ...history.map((turn) => turn.content)]);

  const [redactedInput, ...redactedHistory] = redaction.redactedTexts as [string, ...string[]];
  return {
    request: {
      ...request,
      input: redactedInput,
      ...(redaction.map.size > 0 ? { systemNote: REDACTION_NOTE } : {}),
      ...(request.history
        ? {
            history: history.map((turn, i) => ({ ...turn, content: redactedHistory[i] as string })),
          }
        : {}),
    },
    map: redaction.map,
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
    const { taskType } = await classifyRequest(request);
    return route(request, taskType, accountId, ctx);
  }

  const redaction = redactRequest(request);
  const redactedRequest = redaction.request;
  const { taskType } = await classifyRequest(redactedRequest);
  const result = await route(redactedRequest, taskType, accountId, ctx);
  return { ...result, content: restoreSensitiveData(result.content, redaction.map) };
}

export async function handleStreamRequest(
  rawRequest: RouteRequest,
  accountId: string,
  onDelta: (text: string) => void,
  onStage?: (event: StageEvent) => void,
  ctx?: RouteUsageContext
): Promise<RouteResponse> {
  await assertHasCredits(accountId);
  const request = sanitize(rawRequest);
  if (!(await isSensitiveFilterEnabled(accountId))) {
    const { taskType, method } = await classifyRequest(request);
    onStage?.({ stage: "classify", taskType, method });
    return routeStream(request, taskType, accountId, onDelta, onStage, ctx);
  }

  onStage?.({ stage: "redact" });
  const redaction = redactRequest(request);
  const redactedRequest = redaction.request;
  const { taskType, method } = await classifyRequest(redactedRequest);
  onStage?.({ stage: "classify", taskType, method });

  // onDelta intentionally swallowed here — result.content already holds the
  // full accumulated text (every adapter's streamCall builds it that way
  // regardless of streaming), so there's nothing to gain from forwarding
  // raw, not-yet-detokenized chunks. The client gets one "delta" event with
  // the complete, restored answer instead of many partial ones.
  const result = await routeStream(redactedRequest, taskType, accountId, () => {}, onStage, ctx);
  const restored = restoreSensitiveData(result.content, redaction.map);
  onDelta(restored);
  return { ...result, content: restored };
}
