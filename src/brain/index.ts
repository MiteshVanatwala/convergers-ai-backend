// The Brain: the only part of the system that knows a specific provider
// exists. Everything outside this module talks to it through the one
// function below — nothing else imports a provider SDK, formats a
// provider-specific prompt, or parses a provider-specific response.
//
// See the technical plan §01 for the full interface contract.

import type { RouteRequest, RouteResponse } from "@convergers-ai/shared-types";
import { classify } from "./classifier";
import { route } from "./router";

export async function handleRequest(request: RouteRequest): Promise<RouteResponse> {
  const taskType = await classify(request);
  return route(request, taskType);
}
