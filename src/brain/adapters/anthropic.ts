import type { ProviderAdapter, ProviderResponse } from "./types";
import type { RouteRequest } from "@convergers-ai/shared-types";

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic:claude",
  async call(request: RouteRequest): Promise<ProviderResponse> {
    // TODO: call the Anthropic API (console.anthropic.com), pay-as-you-go
    // per the technical plan's provider-access slide. Never hold the API
    // key outside this module.
    throw new Error("anthropicAdapter.call not implemented yet");
  },
};
