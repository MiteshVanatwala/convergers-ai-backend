// The Brain: the only part of the system that knows a specific provider
// exists. Everything outside this module talks to it through the functions
// below — nothing else imports a provider SDK, formats a provider-specific
// prompt, or parses a provider-specific response.
//
// See the technical plan §01 for the full interface contract.

import type { RouteRequest, RouteResponse } from "@convergers-ai/shared-types";
import { classify } from "./classifier";
import { route, routeStream, type RouteUsageContext, type StageEvent } from "./router";
import { detectAndRedact, isSensitiveFilterEnabled, restoreSensitiveData } from "./privacy/sensitiveFilter.service";

export type { StageEvent, RouteUsageContext };

export async function handleRequest(
  request: RouteRequest,
  accountId: string,
  ctx?: RouteUsageContext
): Promise<RouteResponse> {
  if (!(await isSensitiveFilterEnabled(accountId))) {
    const taskType = await classify(request);
    return route(request, taskType, accountId, ctx);
  }

  const redaction = await detectAndRedact(request.input);
  if (!redaction) {
    throw new Error(
      "Couldn't verify message safety for sensitive-data filtering — please try again."
    );
  }
  const redactedRequest: RouteRequest = { ...request, input: redaction.redactedInput };
  const taskType = await classify(redactedRequest);
  const result = await route(redactedRequest, taskType, accountId, ctx);
  return { ...result, content: restoreSensitiveData(result.content, redaction.map) };
}

export async function handleStreamRequest(
  request: RouteRequest,
  accountId: string,
  onDelta: (text: string) => void,
  onStage?: (event: StageEvent) => void,
  ctx?: RouteUsageContext
): Promise<RouteResponse> {
  if (!(await isSensitiveFilterEnabled(accountId))) {
    const taskType = await classify(request);
    onStage?.({ stage: "classify", taskType });
    return routeStream(request, taskType, accountId, onDelta, onStage, ctx);
  }

  const redaction = await detectAndRedact(request.input);
  if (!redaction) {
    throw new Error(
      "Couldn't verify message safety for sensitive-data filtering — please try again."
    );
  }
  const redactedRequest: RouteRequest = { ...request, input: redaction.redactedInput };
  const taskType = await classify(redactedRequest);
  onStage?.({ stage: "classify", taskType });

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
