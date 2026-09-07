import type { RouteRequest } from "@convergers-ai/shared-types";

export interface ProviderResponse {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  native_cost: number;
}

/** One adapter per provider — this is the only shape the router depends on. */
export interface ProviderAdapter {
  id: string;
  call(request: RouteRequest): Promise<ProviderResponse>;
}
