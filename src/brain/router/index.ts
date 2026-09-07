import type { RouteRequest, RouteResponse } from "@convergers-ai/shared-types";
import type { TaskType } from "../classifier";
import { anthropicAdapter } from "../adapters/anthropic";
import { normalize } from "../normalizer";

// Ranked fallback chain per task type — per the technical plan §04, every
// task type maps to 2-3 providers, not a single point of failure. Only one
// provider is wired up so far.
const fallbackChains: Record<TaskType, (typeof anthropicAdapter)[]> = {
  text: [anthropicAdapter],
  code: [anthropicAdapter],
  image: [],
  voice: [],
  video: [],
  research: [anthropicAdapter],
};

export async function route(request: RouteRequest, taskType: TaskType): Promise<RouteResponse> {
  const chain = fallbackChains[taskType];
  if (chain.length === 0) {
    throw new Error(`No provider configured for task type: ${taskType}`);
  }

  let lastError: unknown;
  for (let i = 0; i < chain.length; i++) {
    try {
      const response = await chain[i].call(request);
      return normalize(chain[i].id, response, {
        creditsCharged: 0, // TODO: wire up the ledger (see ../../ledger)
        fallbackUsed: i > 0,
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
