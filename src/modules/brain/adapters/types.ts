import type { RouteRequest } from "@convergers-ai/shared-types";
import type { TokenUsage } from "./pricing";

/**
 * What adapters actually receive: the public RouteRequest plus Brain-internal
 * fields, set only by the Brain itself (client-supplied values are stripped
 * in brain/index.ts):
 * - `systemNote` is appended to the adapter's system prompt.
 * - `maxOutputTokens` lowers the adapter's output cap — the router sets it to
 *   what the account's credit balance can pay for (router/credits.ts).
 */
export type BrainRequest = RouteRequest & { systemNote?: string; maxOutputTokens?: number };

export function withSystemNote(basePrompt: string, request: RouteRequest): string {
  const note = (request as BrainRequest).systemNote;
  return note ? `${basePrompt}\n\n${note}` : basePrompt;
}

/** The adapter's own cap, lowered to the Brain's `maxOutputTokens` when that's smaller. */
export function outputTokenLimit(adapterMax: number, request: RouteRequest): number {
  const requested = (request as BrainRequest).maxOutputTokens;
  return requested !== undefined ? Math.min(adapterMax, requested) : adapterMax;
}

/** How an adapter is priced — lets the router check affordability before calling it. */
export type AdapterCost =
  | { kind: "tokens"; model: string; maxOutputTokens: number }
  | { kind: "flat"; usd: number };

export interface ProviderResponse {
  content: string;
  usage: TokenUsage;
  native_cost: number;
  /** Stopped at the output-token limit (Anthropic "max_tokens", OpenAI-style "length"). */
  truncated?: boolean;
}

/** One adapter per provider — this is the only shape the router depends on. */
export interface ProviderAdapter {
  id: string;
  /** provider_credentials id this adapter authenticates with — decides own key (BYOK) vs master key. */
  keyProviderId: string;
  cost: AdapterCost;
  /**
   * `accountId` drives per-account key resolution (own key vs. master key,
   * tier-gated — see accountKeyResolver.ts). `null` is for internal calls
   * not attributed to any end user, which always use the master key.
   */
  call(request: RouteRequest, accountId: string | null): Promise<ProviderResponse>;
  /**
   * Same call, but invokes `onDelta` with each text chunk as it arrives.
   * `onInputTokens`, when provided, fires as soon as the provider reports an
   * exact prompt token count — only Anthropic's stream exposes this ahead of
   * completion (its `message_start` event); adapters that can't know this
   * early just never call it.
   */
  streamCall(
    request: RouteRequest,
    onDelta: (text: string) => void,
    accountId: string | null,
    onInputTokens?: (tokens: number) => void
  ): Promise<ProviderResponse>;
}
