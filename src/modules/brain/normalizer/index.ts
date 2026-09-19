import type { RouteResponse } from "@convergers-ai/shared-types";
import type { ProviderResponse } from "../adapters/types";

/** Turns any provider's response shape into the one schema every client expects. */
export function normalize(
  providerId: string,
  response: ProviderResponse,
  opts: {
    creditsCharged: number;
    fallbackUsed?: boolean;
    usageEventId?: string | null;
  }
): RouteResponse {
  return {
    provider_used: providerId,
    usage: response.usage,
    native_cost: response.native_cost,
    credits_charged: opts.creditsCharged,
    content: response.content,
    fallback_used: opts.fallbackUsed,
    ...(opts.usageEventId ? { usage_event_id: opts.usageEventId } : {}),
  };
}
