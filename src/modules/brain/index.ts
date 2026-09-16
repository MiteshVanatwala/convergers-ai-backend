// The Brain: the only part of the system that knows a specific provider
// exists. Everything outside this module talks to it through the functions
// below — nothing else imports a provider SDK, formats a provider-specific
// prompt, or parses a provider-specific response.
//
// See the technical plan §01 for the full interface contract.

import type { RouteRequest, RouteResponse } from "@convergers-ai/shared-types";
import { classify } from "./classifier";
import { route, routeStream, type RouteUsageContext, type StageEvent } from "./router";

export type { StageEvent, RouteUsageContext };

export async function handleRequest(
  request: RouteRequest,
  accountId: string,
  ctx?: RouteUsageContext
): Promise<RouteResponse> {
  const taskType = await classify(request);
  return route(request, taskType, accountId, ctx);
}

export async function handleStreamRequest(
  request: RouteRequest,
  accountId: string,
  onDelta: (text: string) => void,
  onStage?: (event: StageEvent) => void,
  ctx?: RouteUsageContext
): Promise<RouteResponse> {
  const taskType = await classify(request);
  onStage?.({ stage: "classify", taskType });
  return routeStream(request, taskType, accountId, onDelta, onStage, ctx);
}
