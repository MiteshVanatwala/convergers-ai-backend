import type { RouteRequest } from "@convergers-ai/shared-types";

export interface ProviderResponse {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  native_cost: number;
}

/** One adapter per provider — this is the only shape the router depends on. */
export interface ProviderAdapter {
  id: string;
  /**
   * `accountId` drives per-account key resolution (own key vs. master key,
   * tier-gated — see accountKeyResolver.ts). `null` is for internal calls
   * not attributed to any end user (e.g. the sensitive-data detector),
   * which always use the master key.
   */
  call(request: RouteRequest, accountId: string | null): Promise<ProviderResponse>;
  /** Same call, but invokes `onDelta` with each text chunk as it arrives. */
  streamCall(
    request: RouteRequest,
    onDelta: (text: string) => void,
    accountId: string | null
  ): Promise<ProviderResponse>;
}
